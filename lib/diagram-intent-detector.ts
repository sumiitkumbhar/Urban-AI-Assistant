// lib/diagram-intent-detector.ts

import type { QuestionAnalysis } from '@/lib/types/questionAnalysis';

export interface DiagramIntent {
  shouldGenerate: boolean;
  type?: 'buildable_envelope' | 'annotated_object' | 'flow_chart' | 'comparison' | 'timeline';
  confidence: number;
  reason: string;
  matchedPatterns: string[];
}

/**
 * Detect if a query should generate a diagram based on learned patterns
 */
export function detectDiagramIntent(
  query: string,
  knownPatterns: QuestionAnalysis[]
): DiagramIntent {
  const lowerQuery = query.toLowerCase();
  const matchedPatterns: string[] = [];
  let confidence = 0;
  let type: DiagramIntent['type'];

  // Pattern 1: Explicit diagram request keywords
  const explicitKeywords = [
    'show', 'draw', 'diagram', 'illustrate', 'visualize', 'sketch',
    'display', 'plot', 'layout', 'envelope', 'depict', 'picture', 'image'
  ];

  const explicitMatches = explicitKeywords.filter(kw => lowerQuery.includes(kw));
  if (explicitMatches.length > 0) {
    matchedPatterns.push(`Explicit request: ${explicitMatches.join(', ')}`);
    confidence += 0.3;
  }

  // Pattern 2: Buildable envelope indicators
  const envelopeKeywords = [
    'setback', 'buildable', 'envelope', 'fsi', 'far', 'fsr',
    'coverage', 'built-up area', 'ground coverage', 'developable area',
    'plot', 'site layout', 'building footprint'
  ];

  const envelopeMatches = envelopeKeywords.filter(kw => lowerQuery.includes(kw));
  const envelopeScore = envelopeMatches.length;

  if (envelopeScore >= 2) {
    matchedPatterns.push(`Envelope indicators: ${envelopeMatches.join(', ')}`);
    confidence += 0.25 * envelopeScore;
    type = 'buildable_envelope';
  }

  // Pattern 3: Dimension mentions (indicates spatial question)
  const dimensionPatterns = [
    /\d+\s*(m|ft|meter|feet|metre)\s*[x×]\s*\d+\s*(m|ft|meter|feet|metre)/i,
    /\d+\s*(meter|feet|metre)\s*by\s*\d+\s*(meter|feet|metre)/i,
    /plot\s+(?:of\s+)?\d+/i,
    /area\s+(?:of\s+)?\d+/i
  ];

  const hasDimensions = dimensionPatterns.some(pattern => pattern.test(query));
  if (hasDimensions) {
    matchedPatterns.push('Dimensions detected');
    confidence += 0.2;
  }

  // Pattern 4: Technical component questions
  const componentKeywords = [
    'rebar', 'reinforcement', 'column', 'beam', 'slab', 'footing',
    'foundation', 'plinth', 'lintel', 'tie beam', 'shear wall',
    'cantilever', 'truss', 'joist', 'staircase'
  ];

  const componentMatches = componentKeywords.filter(kw => lowerQuery.includes(kw));
  if (componentMatches.length > 0 && (lowerQuery.includes('what is') || lowerQuery.includes('looks'))) {
    matchedPatterns.push(`Technical component: ${componentMatches.join(', ')}`);
    confidence += 0.3;
    type = type || 'annotated_object';
  }

  // Pattern 5: Process/workflow questions
  const processKeywords = [
    'approval', 'process', 'workflow', 'steps', 'procedure',
    'clearance', 'permission', 'timeline', 'schedule', 'sequence'
  ];

  const processMatches = processKeywords.filter(kw => lowerQuery.includes(kw));
  if (processMatches.length >= 2) {
    matchedPatterns.push(`Process indicators: ${processMatches.join(', ')}`);
    confidence += 0.25;
    type = type || 'flow_chart';
  }

  // Pattern 6: Comparison questions
  const comparisonKeywords = ['vs', 'versus', 'difference', 'compare', 'comparison', 'contrast'];
  const hasComparison = comparisonKeywords.some(kw => lowerQuery.includes(kw));

  if (hasComparison && envelopeScore >= 1) {
    matchedPatterns.push('Comparison question');
    confidence += 0.2;
    type = type || 'comparison';
  }

  // Pattern 7: Match against known patterns from dataset
  const similarQuestions = findSimilarQuestions(query, knownPatterns, 0.6);
  const diagramQuestions = similarQuestions.filter(q => q.requiresDiagram);

  if (diagramQuestions.length >= 2) {
    matchedPatterns.push(`Matched ${diagramQuestions.length} similar questions requiring diagrams`);
    confidence += 0.15 * Math.min(diagramQuestions.length, 5);

    // Use most common diagram type from matches
    const typeCount = countDiagramTypes(diagramQuestions);
    type = type || getMostCommonType(typeCount);
  }

  // Pattern 8: Jurisdiction + spatial keywords = likely envelope diagram
  const jurisdictionKeywords = ['mumbai', 'delhi', 'bangalore', 'london', 'nyc', 'new york'];
  const hasJurisdiction = jurisdictionKeywords.some(kw => lowerQuery.includes(kw));

  if (hasJurisdiction && envelopeScore >= 1 && hasDimensions) {
    matchedPatterns.push('Jurisdiction-specific spatial query');
    confidence += 0.15;
    type = type || 'buildable_envelope';
  }

  // Normalize confidence to 0-1 range
  confidence = Math.min(confidence, 1);

  // Decision threshold
  const shouldGenerate = confidence >= 0.5;

  return {
    shouldGenerate,
    type: shouldGenerate ? type : undefined,
    confidence,
    reason: shouldGenerate 
      ? `High confidence diagram request (${Math.round(confidence * 100)}%)`
      : `Low confidence (${Math.round(confidence * 100)}%) - no diagram needed`,
    matchedPatterns
  };
}

/**
 * Find questions similar to the query
 */
function findSimilarQuestions(
  query: string,
  patterns: QuestionAnalysis[],
  threshold: number
): QuestionAnalysis[] {
  const queryWords = tokenize(query);

  return patterns
    .map(pattern => ({
      pattern,
      similarity: calculateSimilarity(queryWords, tokenize(pattern.question))
    }))
    .filter(item => item.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10)
    .map(item => item.pattern);
}

/**
 * Calculate Jaccard similarity between two sets of words
 */
function calculateSimilarity(words1: Set<string>, words2: Set<string>): number {
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Tokenize text into meaningful words
 */
function tokenize(text: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'is', 'are', 'was', 'were']);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  );
}

/**
 * Count diagram types in matched questions
 */
function countDiagramTypes(questions: QuestionAnalysis[]): Record<string, number> {
  return questions.reduce((acc, q) => {
    if (q.diagramType) {
      acc[q.diagramType] = (acc[q.diagramType] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);
}

/**
 * Get most common diagram type
 */
function getMostCommonType(typeCount: Record<string, number>): DiagramIntent['type'] {
  const entries = Object.entries(typeCount);
  if (entries.length === 0) return undefined;

  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0] as DiagramIntent['type'];
}

/**
 * Export question patterns to use for matching
 */
export function preparePatternIndex(analyses: QuestionAnalysis[]): QuestionAnalysis[] {
  // Filter high-confidence, diagram-required questions
  return analyses.filter(a => 
    a.requiresDiagram && 
    a.confidence >= 0.7 &&
    a.question.length > 20
  );
}