"""Builds a lightweight cross-reference graph from chunks.jsonl - Graph
RAG (architecture plan section 52, confirmed in scope, built after the
Corrective-RAG/Self-RAG increment, before Agentic/Multi-Agent
orchestration).

IMPORTANT: this is additive, not a replacement. The existing dense
(Qdrant/semantic) + sparse (BM25) hybrid search in retrieve.py keeps
doing all the same work it always did - this graph only adds one more,
smaller signal on top (a secondary boost for references related to what
the query named), matching the "Graph Signals -> Structured Retrieval"
input feeding the fusion layer in the RAG pattern diagrams the product
owner shared. Semantic search is not being swapped out for graph search
anywhere in this pipeline.

Deliberately NOT a full NER/relation-extraction pipeline (spaCy or an
LLM pass, as originally scoped in section 52) - that's a real future
upgrade, noted below - this is a smaller, deterministic first cut that
reuses the exact-reference regex retrieve.py already had (Policy D3,
Paragraph 135, Approved Document B, etc.) instead of adding a new model
dependency or LLM calls, so it costs nothing extra to build or run and
trivially stays inside the zero-budget rule (section 51).

What it captures:
  - which documents mention which references (a bipartite document <->
    reference graph, with the page numbers each mention appears on);
  - which references tend to co-occur in the same chunk - a cheap proxy
    for "these are related" (e.g. if "Policy D3" and "Policy D2" keep
    showing up in the same paragraphs, they're probably cross-referenced
    in the source text even though nothing here understands *why*).

retrieve.py's _graph_expand_references() reads this at query time: when
a query names an exact reference, the graph's co-occurring references
get a smaller secondary boost (GRAPH_EXPANSION_BOOST in common.py) on
top of the existing dense+sparse+rerank pipeline.

Run automatically at the end of ingest.py's main() - rebuilt from
scratch every ingestion run, same "safe to re-run" philosophy as
everything else in data/. Can also be run standalone against an
existing data/chunks.jsonl:

    source venv/bin/activate
    python3 graph_build.py

Good next upgrade (not done here): real entity/relation extraction
(spaCy locally, or an LLM pass via the free Groq key already in use)
would catch references this regex can't - "the London Plan", "the
Westminster City Plan", "this SPD" - and real relation types (supersedes,
implements, cross-refers-to) instead of just "appeared near each
other". Swap _extract_references() below for that later; nothing else
in this file or retrieve.py's graph-reading code needs to change shape.
"""

import json
import pickle
import time
from collections import Counter, defaultdict
from itertools import combinations

import networkx as nx

from common import CHUNKS_PATH, GRAPH_PATH, EXACT_REFERENCE_PATTERNS, GRAPH_CO_OCCURRENCE_MIN


def _log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _extract_references(text):
    found = set()
    for pattern in EXACT_REFERENCE_PATTERNS:
        found.update(m.group(0).lower().strip() for m in pattern.finditer(text))
    return found


def build_graph(chunks, log=_log):
    """chunks is the same list of chunk dicts ingest.py already has in
    memory (or reads back from chunks.jsonl when run standalone) - no
    new parsing of the source PDFs needed, this is purely derived from
    text extraction that already happened."""
    g = nx.Graph()
    co_occurrence = Counter()
    doc_reference_pages = defaultdict(lambda: defaultdict(set))

    for c in chunks:
        refs = _extract_references(c["text"])
        if not refs:
            continue

        doc = c["doc_filename"]
        if not g.has_node(doc):
            g.add_node(
                doc, kind="document", domain=c.get("domain"),
                geography=c.get("geography"), doc_type=c.get("doc_type"),
                status=c.get("status"),
            )

        for ref in refs:
            if not g.has_node(ref):
                g.add_node(ref, kind="reference")
            doc_reference_pages[doc][ref].add(c.get("page"))
            if g.has_edge(doc, ref):
                g[doc][ref]["weight"] += 1
            else:
                g.add_edge(doc, ref, kind="mentions", weight=1)

        for a, b in combinations(sorted(refs), 2):
            co_occurrence[(a, b)] += 1

    for (a, b), count in co_occurrence.items():
        # A one-off co-occurrence (two references that happened to share
        # a single chunk once, out of thousands) is noise, not a real
        # relationship - only keep edges seen at least
        # GRAPH_CO_OCCURRENCE_MIN times.
        if count >= GRAPH_CO_OCCURRENCE_MIN:
            g.add_edge(a, b, kind="co_occurs", weight=count)

    for doc, refs in doc_reference_pages.items():
        for ref, pages in refs.items():
            if g.has_edge(doc, ref):
                g[doc][ref]["pages"] = sorted(p for p in pages if p is not None)

    doc_count = sum(1 for _, d in g.nodes(data=True) if d.get("kind") == "document")
    ref_count = sum(1 for _, d in g.nodes(data=True) if d.get("kind") == "reference")
    log(f"reference graph: {g.number_of_nodes()} nodes "
        f"({doc_count} documents, {ref_count} references), "
        f"{g.number_of_edges()} edges")
    return g


def save_graph(g, path=GRAPH_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        pickle.dump(g, f)


def load_graph(path=GRAPH_PATH):
    """Returns None (not an error) if the graph hasn't been built yet -
    e.g. data/ from before this feature existed, or ingest.py hasn't
    been re-run since. retrieve.py treats a missing graph as "no extra
    signal available this time", not a failure - the existing
    dense+sparse+rerank pipeline works exactly as before either way."""
    if not path.exists():
        return None
    with open(path, "rb") as f:
        return pickle.load(f)


if __name__ == "__main__":
    chunks = []
    with open(CHUNKS_PATH) as f:
        for line in f:
            chunks.append(json.loads(line))
    _log(f"loaded {len(chunks)} chunks from {CHUNKS_PATH}")
    graph = build_graph(chunks)
    save_graph(graph)
    _log(f"saved to {GRAPH_PATH}")
