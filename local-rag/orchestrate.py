"""Agentic/Multi-Agent RAG orchestration (architecture plan section 52 -
the last item on the confirmed-in-scope list; section 13's sketch: "a
controlled orchestrator/context engine" over autonomous specialist
subagents that "return structured evidence, not competing final
answers", feeding one synthesis model).

What "agent" means here, concretely: a domain-scoped call to the
existing retrieve() (dense+sparse+graph+status, reranked - everything
already built), never a separate LLM call. Retrieval is local and free,
so running it more than once per query costs nothing; the thing that
actually costs money/rate-limit budget is the Groq synthesis call, and
this orchestrator still only ever makes exactly one of those, regardless
of how many domain agents ran - matching section 13's "one synthesis
model creates the user-facing answer" and section 47/52's explicit
warning that "each additional agent is another LLM call in the critical
path" on a rate-limited free tier. Decomposition (which domains does
this query touch) is a zero-cost regex keyword classifier
(DOMAIN_KEYWORDS in common.py), not an LLM call either, for the same
reason.

Agentic behaviour: a query is only ever orchestrated (run through more
than one domain agent) when its keywords genuinely span more than one
domain - section 13's "only use subagents when isolation/parallel
investigation genuinely helps." A single-domain (or domain-less) query
takes the exact same path it always did: one retrieve() call, no
orchestration overhead, matching section 11's fast/standard path and
staying well clear of section 47's "huge multi-agent swarm" warning
(there are only 4 domains defined at all, and MAX_AGENTS caps how many
can fire even if more match).

Graceful degradation (section 14): if one domain agent's retrieval call
raises, it's recorded as a failed agent and the others still get used -
one bad branch never blocks the whole answer.

orchestrate(query) returns the exact same (chunks, coverage) shape
retrieve() does, so query_cli.py/service.py can call it as a drop-in
replacement and generate_answer() doesn't need to change at all. coverage
additionally carries "agents" (per-domain summaries - domain, confidence,
chunk/source counts, or an error) and "domains_queried", so callers can
show which specialists actually ran, matching section 13's "structured
evidence" / provenance goal.
"""

import re

from common import DOMAIN_KEYWORDS, MAX_AGENTS, GRAPH_MAX_RELATED
from retrieve import retrieve

_COMPILED_DOMAIN_KEYWORDS = {
    domain: [re.compile(p, re.I) for p in patterns]
    for domain, patterns in DOMAIN_KEYWORDS.items()
}

_CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}


def classify_domains(query):
    """Zero-cost (no LLM call) query decomposition: which of
    DOMAIN_KEYWORDS' domains does this query's wording touch, in the
    dict's own definition order, capped to MAX_AGENTS. Returns [] for a
    query that matches nothing (orchestrate() treats that the same as a
    single unscoped domain - see there)."""
    matched = []
    for domain, patterns in _COMPILED_DOMAIN_KEYWORDS.items():
        if any(p.search(query) for p in patterns):
            matched.append(domain)
    return matched[:MAX_AGENTS]


def _run_agent(query, domain, top_k, rerank_top_n, geography_filter=None):
    """One domain-scoped retrieve() call, wrapped so a failure here
    (e.g. a corrupted index, an unexpected exception in a dependency)
    degrades that one agent instead of the whole request - section 14's
    'graceful degradation' for optional branches."""
    try:
        chunks, coverage = retrieve(
            query, top_k=top_k, rerank_top_n=rerank_top_n, domain_filter=domain,
            geography_filter=geography_filter,
        )
        return {
            "domain": domain,
            "chunks": chunks,
            "coverage": coverage,
            "error": None,
        }
    except Exception as e:
        return {
            "domain": domain,
            "chunks": [],
            "coverage": None,
            "error": f"{type(e).__name__}: {e}",
        }


def _fuse(agent_results, rerank_top_n):
    """Merges each agent's chunks into one evidence set (dedup by
    chunk_id, keeping the highest rerank_score seen for it - the same
    chunk can legitimately surface from more than one domain-scoped
    search if its own `domain` tag happens to be one two keyword sets
    both matched), then builds one combined coverage dict summarizing
    every agent that ran. Capped to a slightly wider pool than a normal
    single-agent answer (rerank_top_n + a small allowance per extra
    agent) since evidence is now drawn from more than one domain - still
    bounded, not unbounded, to keep the synthesis prompt/latency
    reasonable."""
    merged = {}
    for agent in agent_results:
        for chunk in agent["chunks"]:
            cid = chunk["chunk_id"]
            existing = merged.get(cid)
            if existing is None or chunk["rerank_score"] > existing["rerank_score"]:
                merged[cid] = chunk

    cap = rerank_top_n + 2 * max(0, len(agent_results) - 1)
    # 2026-09-28 determinism pass: explicit chunk_id tie-break, same
    # reasoning as retrieve.py's own ranking steps - merged.values()'
    # insertion order (and therefore any tie) currently happens to be
    # deterministic (classify_domains() iterates DOMAIN_KEYWORDS in
    # fixed dict order, not a thread pool), but that's incidental to
    # this function, not something it should rely on silently.
    fused_chunks = sorted(
        merged.values(), key=lambda c: (-c["rerank_score"], c["chunk_id"]),
    )[:cap]

    ok_agents = [a for a in agent_results if a["error"] is None]
    failed_agents = [a for a in agent_results if a["error"] is not None]

    if not fused_chunks:
        confidence = "low"
    else:
        # Worst-case across the agents that actually ran - an answer
        # drawing on a low-confidence agent alongside a high-confidence
        # one is still only as trustworthy as its weakest ingredient.
        confidence = min(
            (a["coverage"]["confidence"] for a in ok_agents),
            key=lambda c: _CONFIDENCE_RANK[c],
            default="low",
        )

    reasons = []
    for a in ok_agents:
        for reason in a["coverage"].get("reasons", []):
            reasons.append(f"[{a['domain']}] {reason}")
    for a in failed_agents:
        reasons.append(f"[{a['domain']}] agent failed: {a['error']}")

    related = []
    for a in ok_agents:
        for ref in a["coverage"].get("related_references", []):
            if ref not in related:
                related.append(ref)
    related = related[:GRAPH_MAX_RELATED]

    agents_summary = []
    for a in agent_results:
        if a["error"] is not None:
            agents_summary.append({"domain": a["domain"], "error": a["error"]})
        else:
            agents_summary.append({
                "domain": a["domain"],
                "confidence": a["coverage"]["confidence"],
                "chunk_count": len(a["chunks"]),
                "source_count": a["coverage"]["source_count"],
            })

    coverage = {
        "confidence": confidence,
        "top_rerank_score": fused_chunks[0]["rerank_score"] if fused_chunks else None,
        "source_count": len({c["doc_filename"] for c in fused_chunks}),
        "reasons": reasons,
        "related_references": related,
        "broadened_from_top_k": None,
        "agents": agents_summary,
        "domains_queried": [a["domain"] for a in agent_results],
    }
    return fused_chunks, coverage


def orchestrate(query, top_k=25, rerank_top_n=8, geography_filter=None):
    """Top-level entry point for query_cli.py/service.py - same
    (chunks, coverage) return shape as retrieve(), so it's a drop-in
    replacement and generate_answer() needs no changes.

    A query whose wording touches 0 or 1 of DOMAIN_KEYWORDS' domains
    takes the plain, unscoped retrieve() path (no orchestration
    overhead - see the module docstring for why). Only a query that
    genuinely spans 2+ domains fans out into that many domain-scoped
    agents, each a plain retrieve() call filtered to its own domain, run
    in sequence (kept deliberately simple for this first cut - true
    concurrency across the shared embedder/reranker models is a later
    optimization, not a correctness requirement, since MAX_AGENTS caps
    this at 3 calls) and then fused into one evidence set for exactly
    one downstream Groq synthesis call.

    geography_filter is passed straight through to every retrieve()/
    _run_agent() call this makes (single-domain or fanned-out) - see
    retrieve()'s own docstring for its semantics (a chunk tagged
    "national" is always in scope; anything else must match the given
    value)."""
    domains = classify_domains(query)

    if len(domains) <= 1:
        domain_filter = domains[0] if domains else None
        chunks, coverage = retrieve(
            query, top_k=top_k, rerank_top_n=rerank_top_n, domain_filter=domain_filter,
            geography_filter=geography_filter,
        )
        coverage["agents"] = [{
            "domain": domain_filter or "general",
            "confidence": coverage["confidence"],
            "chunk_count": len(chunks),
            "source_count": coverage["source_count"],
        }]
        coverage["domains_queried"] = [domain_filter] if domain_filter else []
        return chunks, coverage

    agent_results = [
        _run_agent(query, d, top_k, rerank_top_n, geography_filter=geography_filter)
        for d in domains
    ]
    return _fuse(agent_results, rerank_top_n)
