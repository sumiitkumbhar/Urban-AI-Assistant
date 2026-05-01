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

- Retrieval-augmented question answering
- Document-grounded responses with inline citations
- Clause and page reference support
- Source inspection panel
- Basic feasibility and regulatory assistance workflows
- Selected UK/US-oriented validation utilities

## Tech stack

- Next.js
- TypeScript
- Tailwind CSS
- Supabase
- Groq
- Google embeddings

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
