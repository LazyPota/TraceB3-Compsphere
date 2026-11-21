import { describe, expect, it } from 'vitest';
import { formatGramsAsKg, normalizeWeightToGrams } from '@traceb3/core';

// Smoke test: the shared pure core library is consumable from apps/web.
describe('@traceb3/core in apps/web', () => {
  it('normalizes weights to exact integer grams', () => {
    expect(normalizeWeightToGrams('850', 'kg').grams).toBe('850000');
    expect(formatGramsAsKg('620000')).toContain('620');
  });
});
