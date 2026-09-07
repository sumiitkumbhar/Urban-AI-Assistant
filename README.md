# Urban AI Assistant

AI assistant for planning, building regulations, and document-grounded compliance checks.

## Screenshots

### Home interface
![Home interface](./public/screenshots/home.png)

### Query in progress
![Query in progress](./public/screenshots/loading.png)

### Grounded answer with citations
![Grounded answer with citations](./public/screenshots/answer.png)

## What it does

Urban AI Assistant is a prototype application that answers planning and construction-related questions using indexed source documents, clause-level retrieval, and citation-backed responses.

## Current capabilities

- **Hybrid retrieval** - combines pgvector semantic search with Postgres full-text search, merged via Reciprocal Rank Fusion (RRF), so both "what this means" and exact-term matches surface strong candidates
- **LLM reranking** - a second-pass Groq call re-scores the top candidates for relevance to the actual question before anything reaches the answer generator
- **Groundedness verification** - every generated answer is independently graded by an LLM-as-judge pass (Ragas-faithfulness-style) that scores 0-100 and flags any claim not actually backed by the retrieved sources
- **Two-signal confidence UI** - retrieval confidence and groundedness are shown as separate, distinctly-colored badges rather than one conflated number, so it's clear whether an answer failed because of weak sources vs. an unsupported claim
- Document-grounded responses with inline, page/clause-level citations and an expandable source-inspection panel (ranked by confidence, with extracted requirement/condition/exception buckets per source)
- Automatic fallback to live web search, clearly labeled, when the indexed corpus doesn't cover a query
- Basic feasibility and regulatory assistance workflows
- Selected UK/US-oriented validation utilities
- Runs entirely on free-tier APIs (Groq, Google Gemini embeddings, Supabase) by design - no paid usage tiers required to run or extend it

## Tech stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS, Framer Motion
- Supabase (Postgres + pgvector) for the chunk store, semantic search, and full-text search
- Groq (`openai/gpt-oss-20b`, free tier) for generation, reranking, and groundedness scoring
- Google Gemini embeddings for the vector index

## Status

This is a working prototype and portfolio project. It is focused on grounded retrieval, speed, and practical usability rather than full production completeness.

## Notes

- Some source previews and diagram/page-level extraction are limited
- Output quality depends on indexed document quality and retrieval coverage
- This repository should be treated as a prototype, not formal professional advice

## Setup

```bash
npm install
npm run dev
