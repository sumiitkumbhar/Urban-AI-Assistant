// lib/types/questionAnalysis.ts
//
// Shared shape for the "learned question patterns" dataset that
// lib/diagram-intent-detector.ts and lib/question-patterns-store.ts consume.
//
// This used to be imported from '@/scripts/analyze-questions', but that
// script (and the rest of the scripts/ directory referenced by the
// extract-questions / analyze-questions / process-dataset npm scripts)
// isn't present in this repo, which broke the TypeScript build for every
// route that pulls in diagram-intent-detector or question-patterns-store.
//
// Question-patterns-store already degrades gracefully at runtime (it
// falls back to an empty array if data/analyzed-questions.json is
// missing), so defining the type locally is enough to restore a working
// build without needing the original extraction script back.

export interface QuestionAnalysis {
  question: string;
  category: string;
  jurisdiction: 'india' | 'uk' | 'usa' | 'general';
  complexity: string;
  keywords: string[];
  requiresDiagram: boolean;
  diagramType?: string;
  confidence: number;
}
