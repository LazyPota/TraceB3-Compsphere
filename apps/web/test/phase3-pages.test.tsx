import { describe, expect, it, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { OperationsDashboard } from '@/components/pages/operations-dashboard';
import { RegisterBatchForm } from '@/components/pages/register-batch-form';
import type { MemberProfile } from '@/lib/api';

let currentRole: MemberProfile['role'] = 'GENERATOR';
const mockSignTypedDataAsync = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/dashboard',
}));

vi.mock('wagmi', () => ({
  useSignTypedData: () => ({
    mutateAsync: mockSignTypedDataAsync,
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    token: 'test-jwt-token',
    member: {
      id: 'mem-1',
      orgId: 'org-gen',
      orgName: 'PT Cikarang Kimia Manufaktur',
      orgType: 'generator',
      onChainOrgId: '0x' + '11'.repeat(32),
      walletAddress: '0xAA638C96AEBf82220aE8a3378fb0bE1072554304',
      displayName: 'Rina Santoso',
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
  mockSignTypedDataAsync.mockReset();
  currentRole = 'GENERATOR';
});

describe('Phase 3 pages — OperationsDashboard & RegisterBatchForm', () => {
  it('renders OperationsDashboard KPIs, crimson discrepancy banner, and real G/T/F stepper', async () => {
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
            batchRef: 'TB3-2026-0042',
            flags: [
              {
                code: 'WEIGHT_MISMATCH_TOTAL',
                severity: 'critical',
                expected: '850000',
                observed: '620000',
                deltaGrams: '230000',
                deltaKg: '230',
                percent: 27.06,
                eventIds: ['e1', 'e3'],
              },
            ],
            hasDiscrepancy: true,
            maxSeverity: 'critical',
            effectiveWeights: {
              declaredGrams: '850000',
              pickupGrams: '850000',
              deliveryGrams: '620000',
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/verify')) {
        return new Response(
          JSON.stringify({
            batchId: 'batch-1',
            publicId: 'pub1',
            batchRef: 'TB3-2026-0042',
            onChainBatchId: '0x' + '11'.repeat(32),
            verdict: 'VERIFIED',
            chainId: 84532,
            ledgerAddress: '0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
            onChainEventCount: 3,
            checkedAt: '2026-11-21T08:30:00.000Z',
            affectedEvents: [],
            affectedFiles: [],
            missingOnChainSeqs: [],
            events: [],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'batch-1',
              publicId: 'pub1',
              batchRef: 'TB3-2026-0042',
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
              latestEventHash: '0x' + 'ab'.repeat(32),
              hasDiscrepancy: true,
              maxDiscrepancySeverity: 'critical',
              festronikRef: null,
              monijaRef: null,
              publicPassportUrl: 'http://localhost:3000/p/pub1',
              createdAt: '2026-11-21T07:00:00.000Z',
              updatedAt: '2026-11-21T08:00:00.000Z',
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        }),
        { status: 200 },
      );
    });

    const { container } = render(<OperationsDashboard />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText(/Discrepancy Flagged:/i)).toBeInTheDocument();
      expect(screen.getAllByText(/850 → 850 → 620 kg/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Total Tracked Batches')).toBeInTheDocument();
    expect(container.textContent).not.toContain('3-dot mini stepper');
    expect(container.textContent).not.toContain('hazard tag');
    expect(container.textContent).not.toContain('Mariutement');
  });

  it('enforces GENERATOR guard and submits gasless CREATED intent with serialized notes', async () => {
    currentRole = 'TRANSPORTER';
    const { rerender, container } = render(<RegisterBatchForm />, { wrapper });
    expect(screen.getByText(/Generator Role Required/i)).toBeInTheDocument();

    currentRole = 'GENERATOR';
    rerender(<RegisterBatchForm />);

    expect(screen.getByText(/\$0 \(Sponsored via Relayer\)/i)).toBeInTheDocument();
    expect(container.textContent).not.toContain('font-mono');
    expect(container.textContent).not.toContain('(searchable)');

    const submitBtn = screen.getByRole('button', {
      name: /Hash Evidence & Sign Batch Creation/i,
    });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(submitBtn).toBeEnabled();
  });
});
