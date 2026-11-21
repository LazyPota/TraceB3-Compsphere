export type ScannedQrTarget =
  | { kind: 'public_id'; value: string }
  | { kind: 'lookup'; value: string };

/**
 * Extracts a passport publicId or lookup identifier from a scanned QR code or manual input.
 */
export function parseScannedQrPayload(raw: string): ScannedQrTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Handle full URLs such as https://app.example/p/V1StGXR8_Z5jdHi6
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const match = url.pathname.match(/\/p\/([A-Za-z0-9_-]+)/);
      if (match?.[1]) {
        return { kind: 'public_id', value: match[1] };
      }
      const batchMatch = url.pathname.match(/\/batches\/([0-9a-f-]{36})/i);
      if (batchMatch?.[1]) {
        return { kind: 'lookup', value: batchMatch[1] };
      }
    } catch {
      // Fall through to general parsing.
    }
  }

  // Handle relative paths like /p/V1StGXR8_Z5jdHi6
  const relMatch = trimmed.match(/^\/?p\/([A-Za-z0-9_-]+)(?:[?#].*)?$/);
  if (relMatch?.[1]) {
    return { kind: 'public_id', value: relMatch[1] };
  }

  // UUID, 66-char txHash/eventHash, or human batchRef (e.g. TB3-2026-0001) go through lookup
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ||
    /^0x[0-9a-f]{64}$/i.test(trimmed) ||
    /^TB3-/i.test(trimmed)
  ) {
    return { kind: 'lookup', value: trimmed };
  }

  return { kind: 'lookup', value: trimmed };
}
