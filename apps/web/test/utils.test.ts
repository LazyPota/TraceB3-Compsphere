import { describe, expect, it } from 'vitest';
import { parseBatchNotes, serializeBatchNotes } from '@/lib/notes';
import { parseScannedQrPayload } from '@/lib/qr';

describe('Structured notes serialization (Decision 2A)', () => {
  it('roundtrips container, lab summary, lab ref, and free notes deterministically', () => {
    const serialized = serializeBatchNotes({
      containerCount: '4',
      containerType: '200L Steel Drums',
      labSummary: 'pH 6.5, Flash Pt < 23C',
      labReportRef: 'LAB-JBK-2026-88',
      freeNotes: 'Drums sealed at Warehouse B',
    });

    expect(serialized).toBe(
      [
        'Containers: 4 x 200L Steel Drums',
        'Lab Summary: pH 6.5, Flash Pt < 23C',
        'Lab Report Ref: LAB-JBK-2026-88',
        'Drums sealed at Warehouse B',
      ].join('\n'),
    );

    const parsed = parseBatchNotes(serialized);
    expect(parsed).toEqual({
      containerSummary: '4 x 200L Steel Drums',
      labSummary: 'pH 6.5, Flash Pt < 23C',
      labReportRef: 'LAB-JBK-2026-88',
      freeNotes: 'Drums sealed at Warehouse B',
    });
  });

  it('returns undefined when all inputs are empty', () => {
    expect(serializeBatchNotes({ containerCount: '  ', freeNotes: '' })).toBeUndefined();
  });
});

describe('QR payload parsing', () => {
  it('extracts publicId from full URL and relative passport paths', () => {
    expect(parseScannedQrPayload('https://traceb3.vercel.app/p/2TcxO0San0f5KioL')).toEqual({
      kind: 'public_id',
      value: '2TcxO0San0f5KioL',
    });
    expect(parseScannedQrPayload('/p/V1StGXR8_Z5jdHi6')).toEqual({
      kind: 'public_id',
      value: 'V1StGXR8_Z5jdHi6',
    });
  });

  it('routes batchRef, UUID, and txHash to lookup resolution', () => {
    expect(parseScannedQrPayload('TB3-2026-0041')).toEqual({
      kind: 'lookup',
      value: 'TB3-2026-0041',
    });
    expect(
      parseScannedQrPayload(
        '0x9a345df3d2fb6fd00ad9396196b15d683b93b93e338f984d98762ac514e9a4a4',
      ),
    ).toEqual({
      kind: 'lookup',
      value: '0x9a345df3d2fb6fd00ad9396196b15d683b93b93e338f984d98762ac514e9a4a4',
    });
  });
});
