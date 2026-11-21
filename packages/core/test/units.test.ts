import { describe, expect, it } from 'vitest';
import {
  formatGramsAsKg,
  gramsToBigInt,
  normalizeWeightToGrams,
  UnitNormalizationError,
} from '../src/units.js';

describe('unit normalization', () => {
  it('converts kg, g, and ton into exact integer grams', () => {
    expect(normalizeWeightToGrams('850', 'kg')).toEqual({
      grams: '850000',
      originalValue: '850',
      originalUnit: 'kg',
    });

    expect(normalizeWeightToGrams('850.125', 'kg')).toEqual({
      grams: '850125',
      originalValue: '850.125',
      originalUnit: 'kg',
    });

    expect(normalizeWeightToGrams('1500', 'g')).toEqual({
      grams: '1500',
      originalValue: '1500',
      originalUnit: 'g',
    });

    expect(normalizeWeightToGrams('1.25', 'ton')).toEqual({
      grams: '1250000',
      originalValue: '1.25',
      originalUnit: 'ton',
    });

    expect(normalizeWeightToGrams('0.000001', 'ton')).toEqual({
      grams: '1',
      originalValue: '0.000001',
      originalUnit: 'ton',
    });
  });

  it('normalizes leading/trailing zeros and large BigInt quantities without floats', () => {
    expect(normalizeWeightToGrams('00850.500', 'kg')).toEqual({
      grams: '850500',
      originalValue: '850.5',
      originalUnit: 'kg',
    });

    // Exceeds Number.MAX_SAFE_INTEGER in grams
    expect(normalizeWeightToGrams('9007199254740993', 'ton')).toEqual({
      grams: '9007199254740993000000',
      originalValue: '9007199254740993',
      originalUnit: 'ton',
    });
  });

  it('rejects sub-gram precision instead of silently rounding', () => {
    expect(() => normalizeWeightToGrams('1.2345', 'kg')).toThrow(
      UnitNormalizationError,
    );
    expect(() => normalizeWeightToGrams('0.5', 'g')).toThrow(
      UnitNormalizationError,
    );
    expect(() => normalizeWeightToGrams('0.0000001', 'ton')).toThrow(
      UnitNormalizationError,
    );
  });

  it('rejects zero (by default), negative, NaN, and scientific notation inputs', () => {
    expect(() => normalizeWeightToGrams('0', 'kg')).toThrow(
      UnitNormalizationError,
    );
    expect(() => normalizeWeightToGrams('-10', 'kg')).toThrow(
      UnitNormalizationError,
    );
    expect(() => normalizeWeightToGrams(Number.NaN, 'kg')).toThrow(
      UnitNormalizationError,
    );
    expect(() => normalizeWeightToGrams(1e25, 'kg')).toThrow(
      UnitNormalizationError,
    );
    expect(() => normalizeWeightToGrams('1e3', 'kg')).toThrow(
      UnitNormalizationError,
    );

    expect(normalizeWeightToGrams('0', 'kg', { allowZero: true })).toEqual({
      grams: '0',
      originalValue: '0',
      originalUnit: 'kg',
    });
  });

  it('formats grams as exact decimal kg strings', () => {
    expect(formatGramsAsKg(230000n)).toBe('230');
    expect(formatGramsAsKg('850500')).toBe('850.5');
    expect(formatGramsAsKg(1005n)).toBe('1.005');
    expect(formatGramsAsKg('-2500')).toBe('-2.5');
    expect(formatGramsAsKg(0n)).toBe('0');
  });

  it('parses valid gram strings into bigint and rejects invalid strings', () => {
    expect(gramsToBigInt('850000')).toBe(850000n);
    expect(() => gramsToBigInt('850.5')).toThrow(UnitNormalizationError);
    expect(() => gramsToBigInt('-10')).toThrow(UnitNormalizationError);
  });
});
