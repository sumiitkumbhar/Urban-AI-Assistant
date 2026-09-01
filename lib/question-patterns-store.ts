// lib/question-patterns-store.ts

import type { QuestionAnalysis } from '@/lib/types/questionAnalysis';
import { readFile } from 'fs/promises';
import path from 'path';

let cachedPatterns: QuestionAnalysis[] | null = null;

/**
 * Load analyzed question patterns from JSON file
 */
export async function loadQuestionPatterns(): Promise<QuestionAnalysis[]> {
  if (cachedPatterns) {
    return cachedPatterns;
  }

  try {
    const filePath = path.join(process.cwd(), 'data', 'analyzed-questions.json');
    const data = await readFile(filePath, 'utf-8');
    const allPatterns: QuestionAnalysis[] = JSON.parse(data);

    // Cache the patterns
    cachedPatterns = allPatterns;

    console.log(`✅ Loaded ${allPatterns.length} question patterns`);
    return allPatterns;

  } catch (error) {
    console.warn('⚠️  Could not load question patterns, using empty set:', error);
    return [];
  }
}

/**
 * Get patterns filtered by criteria
 */
export async function getPatternsByCategory(
  category: string
): Promise<QuestionAnalysis[]> {
  const patterns = await loadQuestionPatterns();
  return patterns.filter(p => 
    p.category.toLowerCase() === category.toLowerCase()
  );
}

/**
 * Get patterns that require diagrams
 */
export async function getDiagramPatterns(): Promise<QuestionAnalysis[]> {
  const patterns = await loadQuestionPatterns();
  return patterns.filter(p => p.requiresDiagram);
}

/**
 * Get patterns by jurisdiction
 */
export async function getPatternsByJurisdiction(
  jurisdiction: 'india' | 'uk' | 'usa' | 'general'
): Promise<QuestionAnalysis[]> {
  const patterns = await loadQuestionPatterns();
  return patterns.filter(p => p.jurisdiction === jurisdiction);
}

/**
 * Search patterns by keywords
 */
export async function searchPatterns(
  searchTerm: string
): Promise<QuestionAnalysis[]> {
  const patterns = await loadQuestionPatterns();
  const lowerSearch = searchTerm.toLowerCase();

  return patterns.filter(p => 
    p.question.toLowerCase().includes(lowerSearch) ||
    p.keywords.some(k => k.toLowerCase().includes(lowerSearch))
  );
}

/**
 * Get statistics about patterns
 */
export async function getPatternStats() {
  const patterns = await loadQuestionPatterns();

  return {
    total: patterns.length,
    requiresDiagram: patterns.filter(p => p.requiresDiagram).length,
    byCategory: countBy(patterns, 'category'),
    byDiagramType: countBy(patterns.filter(p => p.requiresDiagram), 'diagramType'),
    byJurisdiction: countBy(patterns, 'jurisdiction'),
    byComplexity: countBy(patterns, 'complexity')
  };
}

function countBy<T>(array: T[], key: keyof T): Record<string, number> {
  return array.reduce((acc, item) => {
    const value = String(item[key] || 'unknown');
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

/**
 * Clear cache (useful for development/testing)
 */
export function clearPatternCache() {
  cachedPatterns = null;
}