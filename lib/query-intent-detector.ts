// lib/query-intent-detector.ts
// Detects what the user is trying to accomplish

export type QueryIntent =
  | 'compliance_check'
  | 'feasibility'
  | 'cost_estimation'
  | 'timeline'
  | 'comparison'
  | 'document_gen'
  | 'standard_rag';

export function detectQueryIntent(query: string): QueryIntent {
  const intents = {
    compliance_check: /\b(check|validate|compliant|meets?|requirements)\b/i,
    feasibility: /\b(feasible|can i build|maximum|fsi|far|height limit)\b/i,
    cost_estimation: /\b(cost|price|fee|premium|how much|budget)\b/i,
    timeline: /\b(timeline|how long|duration|approval time)\b/i,
    comparison: /\b(compare|vs|versus|difference|mumbai vs|delhi vs)\b/i,
    document_gen: /\b(generate|create|template|form|application|noc)\b/i,
  };
  
  for (const [intent, pattern] of Object.entries(intents)) {
    if (pattern.test(query)) {
      return intent as QueryIntent;
    }
  }
  
  return 'standard_rag';
}
