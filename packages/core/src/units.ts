import type { WeightUnit } from './enums.js';

export class UnitNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitNormalizationError';
  }
}

export interface NormalizedQuantity {
  grams: string;
  originalValue: string;
  originalUnit: WeightUnit;
}

const UNIT_DECIMALS: Record<WeightUnit, number> = {
  g: 0,
  kg: 3,
  ton: 6,
};

/**
 * Normalizes a waste weight from kg, g, or metric ton into exact integer grams
 * using decimal-string parsing and BigInt arithmetic (never IEEE-754 floats).
 */
export function normalizeWeightToGrams(
  value: string | number,
  unit: WeightUnit,
  options?: { allowZero?: boolean },
): NormalizedQuantity {
  let raw: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new UnitNormalizationError(
        'Weight value must be a finite non-negative number',
      );
    }
    raw = String(value);
    if (/[eE]/.test(raw)) {
      throw new UnitNormalizationError(
        'Scientific notation is not supported; pass an exact decimal string',
      );
    }
  } else {
    raw = value.trim();
  }

  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new UnitNormalizationError(
      `Invalid non-negative decimal weight value: "${raw}"`,
    );
  }

  const [intRaw = '0', fracRaw = ''] = raw.split('.');
  const intNorm = intRaw.replace(/^0+(?=\d)/, '');
  const fracNorm = fracRaw.replace(/0+$/, '');
  const scale = UNIT_DECIMALS[unit];

  if (fracNorm.length > scale) {
    throw new UnitNormalizationError(
      `Weight "${raw} ${unit}" exceeds sub-gram precision (max ${scale} decimal places for ${unit})`,
    );
  }

  const gramsDigits = intNorm + fracNorm.padEnd(scale, '0');
  const gramsBigInt = BigInt(gramsDigits);

  if (!options?.allowZero && gramsBigInt <= 0n) {
    throw new UnitNormalizationError('Weight must be greater than zero grams');
  }

  const originalValue = fracNorm.length > 0 ? `${intNorm}.${fracNorm}` : intNorm;

  return {
    grams: gramsBigInt.toString(10),
    originalValue,
    originalUnit: unit,
  };
}

/**
 * Parses a validated integer-gram string into a non-negative bigint.
 */
export function gramsToBigInt(grams: string): bigint {
  if (!/^\d+$/.test(grams)) {
    throw new UnitNormalizationError(
      `Invalid integer gram string: "${grams}"`,
    );
  }
  return BigInt(grams);
}

/**
 * Formats integer grams as a decimal kilogram string using exact BigInt arithmetic.
 */
export function formatGramsAsKg(grams: bigint | string): string {
  let val: bigint;
  if (typeof grams === 'bigint') {
    val = grams;
  } else {
    if (!/^-?\d+$/.test(grams)) {
      throw new UnitNormalizationError(
        `Invalid integer gram string: "${grams}"`,
      );
    }
    val = BigInt(grams);
  }

  const sign = val < 0n ? '-' : '';
  const abs = val < 0n ? -val : val;
  const whole = abs / 1000n;
  const rem = abs % 1000n;

  if (rem === 0n) {
    return `${sign}${whole.toString(10)}`;
  }

  const frac = rem.toString(10).padStart(3, '0').replace(/0+$/, '');
  return `${sign}${whole.toString(10)}.${frac}`;
}
