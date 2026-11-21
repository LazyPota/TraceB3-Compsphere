import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { HashVerificationBanner } from '@/components/domain/hash-verification-banner';
import { DiscrepancyDeltaMeter } from '@/components/domain/discrepancy-delta-meter';
import { MiniCustodyStepper } from '@/components/domain/custody-timeline-stepper';
import { WastePassportQRCard } from '@/components/domain/waste-passport-qr-card';
import { Web3TxProgressModal } from '@/components/domain/web3-tx-progress-modal';
import type { CreateIntentPayload } from '@/lib/api';

const mockSignTypedDataAsync = vi.fn();

vi.mock('wagmi', () => ({
  useSignTypedData: () => ({
    mutateAsync: mockSignTypedDataAsync,
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockSignTypedDataAsync.mockReset();
});

describe('TRACEB3 domain components', () => {
  it('renders VERIFIED and TAMPERED states in HashVerificationBanner without prohibited terminology', () => {
    const { rerender, container } = render(
      <HashVerificationBanner verdict="VERIFIED" networkLabel="Base Sepolia" />,
    );
    expect(screen.getByText(/Cryptographic integrity verified/i)).toBeInTheDocument();
    expect(container.textContent?.toLowerCase()).not.toContain('tamper' + '-proof');

    rerender(
      <HashVerificationBanner
        verdict="TAMPERED"
        affectedEvents={[
          {
            eventId: 'ev-2',
            seq: 2,
            verdict: 'HASH_MISMATCH',
            reason: 'SHA-256 canonical record digest mismatch on-chain',
          },
        ]}
        affectedFiles={[
          {
            evidenceId: 'file-1',
            eventId: 'ev-1',
            seq: 1,
            filename: 'manifest.pdf',
            issue: 'FILE_MISMATCH',
            expectedSha256: '0x' + 'a'.repeat(64),
            actualSha256: '0x' + 'b'.repeat(64),
          },
        ]}
      />,
    );
    expect(screen.getByText(/INTEGRITY BREACH — TAMPERED/i)).toBeInTheDocument();
    expect(screen.getByText(/Event #2 · HASH_MISMATCH/i)).toBeInTheDocument();
    expect(screen.getByText(/manifest\.pdf\) · FILE_MISMATCH/i)).toBeInTheDocument();
  });

  it('computes real DiscrepancyDeltaMeter states: match, -230 kg critical, and LIKELY_UNIT_ERROR', () => {
    const { rerender } = render(
      <DiscrepancyDeltaMeter
        expectedGrams="850000"
        observedValue="850"
        observedUnit="kg"
      />,
    );
    expect(screen.getByText(/Weight Within Tolerance/i)).toBeInTheDocument();

    rerender(
      <DiscrepancyDeltaMeter
        expectedGrams="850000"
        observedValue="620"
        observedUnit="kg"
      />,
    );
    expect(
      screen.getByText(/Critical Weight Discrepancy Will Be Flagged/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/-230 kg \(-27\.06%\)/)).toBeInTheDocument();

    rerender(
      <DiscrepancyDeltaMeter
        expectedGrams="850000"
        observedValue="850"
        observedUnit="g"
      />,
    );
    expect(screen.getByText(/LIKELY_UNIT_ERROR/)).toBeInTheDocument();
  });

  it('renders interactive G/T/F MiniCustodyStepper and QR card with real SVG', () => {
    render(<MiniCustodyStepper status="IN_TRANSIT" />);
    expect(screen.getByLabelText('Custody progress: IN_TRANSIT')).toBeInTheDocument();
    expect(screen.getByText('G')).toBeInTheDocument();
    expect(screen.getByText('T')).toBeInTheDocument();
    expect(screen.getByText('F')).toBeInTheDocument();

    render(
      <WastePassportQRCard
        publicId="2TcxO0San0f5KioL"
        batchRef="TB3-DEMO-1"
        wasteCode="B105d"
        txHash="0x9a345df3d2fb6fd00ad9396196b15d683b93b93e338f984d98762ac514e9a4a4"
      />,
    );
    expect(screen.getByRole('img', { name: /TRACEB3 Waste Passport QR Code/i })).toBeInTheDocument();
    expect(screen.getByText(/Batch: TB3-DEMO-1/)).toBeInTheDocument();
  });

  it('handles 3-step gasless signing, BATCH_BUSY retry without data loss, and ANCHORED completion', async () => {
    mockSignTypedDataAsync.mockResolvedValue('0x' + '11'.repeat(65));

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    // 1st attempt: createIntent succeeds, submit returns 409 BATCH_BUSY
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            intentId: 'intent-1',
            batchId: 'batch-1',
            seq: 2,
            eventHash: '0x' + 'aa'.repeat(32),
            typedData: {
              domain: {
                name: 'TraceB3Ledger',
                version: '1',
                chainId: 84532,
                verifyingContract: '0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
              },
              types: {
                CustodyIntent: [
                  { name: 'batchId', type: 'bytes32' },
                  { name: 'eventType', type: 'uint8' },
                  { name: 'eventHash', type: 'bytes32' },
                  { name: 'prevHash', type: 'bytes32' },
                  { name: 'targetSeq', type: 'uint32' },
                  { name: 'actor', type: 'address' },
                  { name: 'nonce', type: 'uint256' },
                  { name: 'deadline', type: 'uint64' },
                ],
              },
              primaryType: 'CustodyIntent',
              message: {
                batchId: '0x' + '22'.repeat(32),
                eventType: 1,
                eventHash: '0x' + 'aa'.repeat(32),
                prevHash: '0x' + '00'.repeat(32),
                targetSeq: 0,
                actor: '0xAA638C96AEBf82220aE8a3378fb0bE1072554304',
                nonce: '1',
                deadline: '9999999999',
              },
            },
            eventPreview: {},
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'https://traceb3.example/errors/BATCH_BUSY',
            title: 'Batch Busy',
            status: 409,
            code: 'BATCH_BUSY',
            detail: 'Batch already has an in-flight anchor job.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      )
      // Retry: submit succeeds -> SSE falls back cleanly or streams ANCHORED
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            eventId: 'ev-2',
            batchId: 'batch-1',
            seq: 2,
            status: 'PENDING',
            eventHash: '0x' + 'aa'.repeat(32),
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"eventId":"ev-2","batchId":"batch-1","seq":2,"eventType":"CUSTODY_TRANSFERRED","chainStatus":"ANCHORED","txHash":"0x' +
            'cc'.repeat(32) +
            '","blockNumber":61638268,"anchoredAt":"2026-11-21T08:25:22.000Z","failureReason":null,"explorerUrl":"https://sepolia.basescan.org/tx/0x' +
            'cc'.repeat(32) +
            '"}\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

    const payload: CreateIntentPayload = {
      kind: 'CUSTODY_TRANSFERRED',
      batchId: 'batch-1',
      data: { quantity: { value: '850', unit: 'kg' } },
      evidenceIds: [],
    };
    const onAnchored = vi.fn();

    render(
      <Web3TxProgressModal
        open
        onClose={() => undefined}
        title="Sign Custody Handoff"
        token="jwt-token"
        intentPayload={payload}
        onAnchored={onAnchored}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/already anchoring for this batch/i)).toBeInTheDocument();
    });
    expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1);

    // Retry reuses existing intent + signature without re-prompting wallet!
    fireEvent.click(screen.getByRole('button', { name: /Retry Step/i }));

    await waitFor(() => {
      expect(screen.getByText(/Custody record anchored on-chain/i)).toBeInTheDocument();
    });
    expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1);
    expect(onAnchored).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: /Open Explorer/i })).toBeInTheDocument();
  });
});
