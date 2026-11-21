import { describe, expect, it, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { WastePassportView } from '@/components/pages/waste-passport-view';
import { CustodyHandoffView } from '@/components/pages/custody-handoff-view';
import { ReviseBatchView } from '@/components/pages/revise-batch-view';
import type { MemberProfile } from '@/lib/api';

let currentRole: MemberProfile['role'] = 'FACILITY';
let currentOrgId = 'org-fac';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/batches/batch-1',
}));

vi.mock('wagmi', () => ({
  useSignTypedData: () => ({
    mutateAsync: vi.fn(),
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    token: 'jwt-test',
    member: {
      id: 'mem-1',
      orgId: currentOrgId,
      orgName: 'PT PPLI Cileungsi Treatment',
      orgType: 'facility',
      onChainOrgId: '0x' + '33'.repeat(32),
      walletAddress: '0xAA638C96AEBf82220aE8a3378fb0bE1072554304',
      displayName: 'Budi Santoso',
      role: currentRole,
    },
    expiresAt: '2099-01-01T00:00:00.000Z',
    isAuthenticated: true,
    isSigningIn: false,
    authError: null,
    signInWithSiwe: vi.fn(),
    signOut: vi.fn(),
    clearError: vi.fn(),
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  currentRole = 'FACILITY';
  currentOrgId = 'org-fac';
});

describe('Phase 4 pages — Passport, Custody Handoff & Revision', () => {
  it('renders WastePassportView VERIFIED -> TAMPERED and -230 kg discrepancy without mockup glitches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/chain/info')) {
        return new Response(
          JSON.stringify({
            chainId: 84532,
            networkName: 'Base Sepolia',
            ledgerAddress: '0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
            explorerBaseUrl: 'https://sepolia.basescan.org',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/verify')) {
        return new Response(
          JSON.stringify({
            batchId: 'batch-1',
            publicId: 'pub-1',
            batchRef: 'TB3-2026-0041',
            onChainBatchId: '0x' + '11'.repeat(32),
            verdict: 'TAMPERED',
            chainId: 84532,
            ledgerAddress: '0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
            onChainEventCount: 3,
            checkedAt: '2026-11-21T08:30:00.000Z',
            affectedEvents: [
              {
                eventId: 'ev-2',
                seq: 2,
                verdict: 'HASH_MISMATCH',
                reason: 'SHA-256 mismatch vs on-chain anchor',
              },
            ],
            affectedFiles: [],
            missingOnChainSeqs: [],
            events: [
              {
                eventId: 'ev-2',
                seq: 2,
                eventType: 'CUSTODY_TRANSFERRED',
                chainStatus: 'ANCHORED',
                verdict: 'HASH_MISMATCH',
                reasons: ['Digest differs'],
                recomputedHash: '0x' + 'bb'.repeat(32),
                storedHash: '0x' + 'aa'.repeat(32),
                onChainHash: '0x' + 'aa'.repeat(32),
                txHash: '0x' + 'cc'.repeat(32),
                explorerUrl: null,
                anchoredAt: '2026-11-21T07:30:00.000Z',
                filesChecked: 1,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          viewLevel: 'full',
          batchId: 'batch-1',
          publicId: 'pub-1',
          batchRef: 'TB3-2026-0041',
          onChainBatchId: '0x' + '11'.repeat(32),
          wasteCode: 'A102d',
          wasteName: 'Spent Organic Solvents',
          wasteCategory: 'Category 1',
          status: 'RECEIVED',
          generatorOrgName: 'PT Cikarang Kimia',
          currentCustodianOrgName: 'PT PPLI Cileungsi Treatment',
          hasDiscrepancy: true,
          maxDiscrepancySeverity: 'critical',
          declaredWeightGrams: '850000',
          festronikRef: 'FEST-041',
          monijaRef: null,
          events: [
            {
              id: 'ev-1',
              seq: 1,
              eventType: 'CREATED',
              actorOrgName: 'PT Cikarang Kimia',
              fromOrgName: null,
              toOrgName: 'PT Cikarang Kimia',
              targetSeq: null,
              reasonCode: null,
              chainStatus: 'ANCHORED',
              txHash: '0x' + 'aa'.repeat(32),
              explorerUrl: null,
              anchoredAt: '2026-11-21T07:00:00.000Z',
              eventHash: '0x' + '11'.repeat(32),
              quantity: { grams: '850000', originalValue: '850', originalUnit: 'kg' },
              notes: 'Containers: 4 x 200L Steel Drums\nLab Summary: pH 6.5',
              evidenceCount: 1,
              evidence: [],
            },
          ],
          discrepancies: {
            flags: [
              {
                code: 'WEIGHT_MISMATCH_TOTAL',
                severity: 'critical',
                expected: '850000',
                observed: '620000',
                deltaGrams: '230000',
                deltaKg: '230',
                percent: 27.06,
                eventIds: ['ev-1', 'ev-3'],
              },
            ],
            hasDiscrepancy: true,
            maxSeverity: 'critical',
            effectiveWeights: {
              declaredGrams: '850000',
              pickupGrams: '850000',
              deliveryGrams: '620000',
            },
          },
          createdAt: '2026-11-21T07:00:00.000Z',
          updatedAt: '2026-11-21T08:00:00.000Z',
        }),
        { status: 200 },
      );
    });

    const { container } = render(
      <WastePassportView mode="public" publicId="pub-1" />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText(/INTEGRITY BREACH — TAMPERED/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Event #2 · HASH_MISMATCH/i)).toBeInTheDocument();
    expect(screen.getByText(/Weight Discrepancy Flagged:/i)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Lorater');
    expect(container.textContent).not.toContain('Lab parameters: 80');
    expect(container.textContent).not.toContain('timer original record');
    expect(container.textContent?.toLowerCase()).not.toContain('tamper' + '-proof');
  });

  it('computes live -230 kg critical delta in CustodyHandoffView during intake', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/chain/info')) {
        return new Response(
          JSON.stringify({
            chainId: 84532,
            networkName: 'Base Sepolia',
            ledgerAddress: '0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
            explorerBaseUrl: 'https://sepolia.basescan.org',
          }),
          { status: 200 },
        );
      }
      if (url.includes('/discrepancies')) {
        return new Response(
          JSON.stringify({
            batchId: 'batch-1',
            batchRef: 'TB3-2026-0041',
            flags: [],
            hasDiscrepancy: false,
            maxSeverity: 'none',
            effectiveWeights: {
              declaredGrams: '850000',
              pickupGrams: '850000',
              deliveryGrams: null,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'batch-1',
          publicId: 'pub-1',
          batchRef: 'TB3-2026-0041',
          onChainBatchId: '0x' + '11'.repeat(32),
          wasteCode: 'A102d',
          wasteName: 'Spent Organic Solvents',
          wasteCategory: 'Category 1',
          status: 'IN_TRANSIT',
          generatorOrgId: 'org-gen',
          generatorOrg: { id: 'org-gen', name: 'PT Cikarang Kimia', code: 'CKM', orgType: 'generator' },
          currentCustodianOrgId: 'org-trans',
          currentCustodianOrg: null,
          declaredWeightGrams: '850000',
          latestEventSeq: 2,
          latestEventHash: '0x' + 'ab'.repeat(32),
          hasDiscrepancy: false,
          maxDiscrepancySeverity: 'none',
          festronikRef: null,
          monijaRef: null,
          publicPassportUrl: 'http://localhost:3000/p/pub-1',
          createdAt: '2026-11-21T07:00:00.000Z',
          updatedAt: '2026-11-21T07:30:00.000Z',
        }),
        { status: 200 },
      );
    });

    render(<CustodyHandoffView batchId="batch-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText(/Weighbridge Intake Verification/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Observed Physical Weight/i), {
      target: { value: '620' },
    });

    expect(
      screen.getByText(/Critical Weight Discrepancy Will Be Flagged/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/-230 kg \(-27\.06%\)/)).toBeInTheDocument();
  });

  it('enforces locked code/description and requires change + reason in ReviseBatchView', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/chain/info')) {
        return new Response(
          JSON.stringify({
            chainId: 84532,
            networkName: 'Base Sepolia',
            ledgerAddress: '0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
            explorerBaseUrl: 'https://sepolia.basescan.org',
          }),
          { status: 200 },
        );
      }
      if (url.includes('/timeline')) {
        return new Response(
          JSON.stringify({
            batchId: 'batch-1',
            publicId: 'pub-1',
            batchRef: 'TB3-2026-0041',
            events: [
              {
                id: 'ev-3',
                seq: 3,
                eventType: 'CUSTODY_TRANSFERRED',
                actorWallet: '0xAA638C96AEBf82220aE8a3378fb0bE1072554304',
                actorOrgId: 'org-fac',
                actorOrg: { id: 'org-fac', name: 'PT PPLI Cileungsi Treatment', code: 'PPLI', orgType: 'facility' },
                fromOrgId: 'org-trans',
                fromOrg: null,
                toOrgId: 'org-fac',
                toOrg: null,
                targetSeq: null,
                revisedBySeqs: [],
                reasonCode: null,
                quantity: { grams: '620000', originalValue: '620', originalUnit: 'kg' },
                evidence: [],
                eventHash: '0x' + '33'.repeat(32),
                prevEventHash: '0x' + '22'.repeat(32),
                chainStatus: 'ANCHORED',
                txHash: '0x' + 'cc'.repeat(32),
                explorerUrl: null,
                blockNumber: 12,
                anchoredAt: '2026-11-21T08:00:00.000Z',
                failureReason: null,
                record: { notes: 'Initial weighbridge' },
                createdAt: '2026-11-21T08:00:00.000Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'batch-1',
          publicId: 'pub-1',
          batchRef: 'TB3-2026-0041',
          onChainBatchId: '0x' + '11'.repeat(32),
          wasteCode: 'A102d',
          wasteName: 'Spent Solvents',
          wasteCategory: 'Category 1',
          status: 'RECEIVED',
          generatorOrgId: 'org-gen',
          generatorOrg: null,
          currentCustodianOrgId: 'org-fac',
          currentCustodianOrg: null,
          declaredWeightGrams: '850000',
          latestEventSeq: 3,
          latestEventHash: '0x' + '33'.repeat(32),
          hasDiscrepancy: true,
          maxDiscrepancySeverity: 'critical',
          festronikRef: null,
          monijaRef: null,
          publicPassportUrl: 'http://localhost:3000/p/pub-1',
          createdAt: '2026-11-21T07:00:00.000Z',
          updatedAt: '2026-11-21T08:00:00.000Z',
        }),
        { status: 200 },
      );
    });

    const { container } = render(<ReviseBatchView batchId="batch-1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText(/Proposed Append-Only Revision/i)).toBeInTheDocument();
    });
    expect(container.textContent).not.toContain('Revision page');

    const submitBtn = screen.getByRole('button', { name: /Sign & Anchor Revision/i });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Revised Net Weight/i), {
      target: { value: '845' },
    });
    expect(submitBtn).toBeDisabled(); // reason still required

    fireEvent.change(screen.getByLabelText(/Revision Reason/i), {
      target: { value: 'SCALE_RECALIBRATION' },
    });
    expect(submitBtn).toBeEnabled();
  });
});
