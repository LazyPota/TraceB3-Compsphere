import { describe, expect, it, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LandingPortal } from '@/components/pages/landing-portal';
import { AuditExplorer } from '@/components/pages/audit-explorer';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/audit',
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    token: null,
    member: null,
    expiresAt: null,
    isAuthenticated: false,
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

const SAMPLE_LIST_ITEM = {
  batchId: '01950000-0000-7000-8000-000000000001',
  publicId: 'pub123',
  batchRef: 'TB3-2026-0041',
  wasteCode: 'B105d',
  wasteName: 'Spent Industrial Solvent',
  status: 'RECEIVED' as const,
  generatorOrgName: 'PT Cikarang Kimia Manufaktur',
  currentCustodianOrgName: 'PT PPLI Cileungsi Treatment',
  hasDiscrepancy: true,
  maxDiscrepancySeverity: 'critical' as const,
  latestEventSeq: 3,
  latestEventHash: '0x' + 'ab'.repeat(32),
  hasRevisions: false,
  declaredWeightGrams: '850000',
  effectiveWeights: {
    declaredGrams: '850000',
    pickupGrams: '850000',
    deliveryGrams: '620000',
  },
  createdAt: '2026-11-21T07:00:00.000Z',
  updatedAt: '2026-11-21T08:00:00.000Z',
};

const SAMPLE_PASSPORT = {
  viewLevel: 'full' as const,
  batchId: SAMPLE_LIST_ITEM.batchId,
  publicId: 'pub123',
  batchRef: 'TB3-2026-0041',
  onChainBatchId: '0x' + '11'.repeat(32),
  wasteCode: 'B105d',
  wasteName: 'Spent Industrial Solvent',
  wasteCategory: 'Category 2',
  status: 'RECEIVED' as const,
  generatorOrgName: 'PT Cikarang Kimia Manufaktur',
  currentCustodianOrgName: 'PT PPLI Cileungsi Treatment',
  hasDiscrepancy: true,
  maxDiscrepancySeverity: 'critical' as const,
  declaredWeightGrams: '850000',
  festronikRef: 'FEST-001',
  monijaRef: null,
  events: [
    {
      id: 'ev-1',
      seq: 1,
      eventType: 'CREATED' as const,
      actorOrgName: 'PT Cikarang Kimia Manufaktur',
      fromOrgName: null,
      toOrgName: 'PT Cikarang Kimia Manufaktur',
      targetSeq: null,
      reasonCode: null,
      chainStatus: 'ANCHORED' as const,
      txHash: '0x' + 'aa'.repeat(32),
      explorerUrl: 'https://sepolia.basescan.org/tx/0x' + 'aa'.repeat(32),
      anchoredAt: '2026-11-21T07:00:00.000Z',
      eventHash: '0x' + 'ab'.repeat(32),
      quantity: { grams: '850000', originalValue: '850', originalUnit: 'kg' as const },
      evidenceCount: 1,
    },
  ],
  discrepancies: {
    flags: [
      {
        code: 'WEIGHT_MISMATCH_TOTAL' as const,
        severity: 'critical' as const,
        expected: '850000',
        observed: '620000',
        deltaGrams: '230000',
        deltaKg: '230',
        percent: 27.06,
        eventIds: ['ev-1', 'ev-3'],
      },
    ],
    hasDiscrepancy: true,
    maxSeverity: 'critical' as const,
    effectiveWeights: {
      declaredGrams: '850000',
      pickupGrams: '850000',
      deliveryGrams: '620000',
    },
  },
  createdAt: '2026-11-21T07:00:00.000Z',
  updatedAt: '2026-11-21T08:00:00.000Z',
};

const SAMPLE_VERIFICATION = {
  batchId: SAMPLE_LIST_ITEM.batchId,
  publicId: 'pub123',
  batchRef: 'TB3-2026-0041',
  onChainBatchId: '0x' + '11'.repeat(32),
  verdict: 'VERIFIED' as const,
  chainId: 84532,
  ledgerAddress: '0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
  onChainEventCount: 3,
  checkedAt: '2026-11-21T08:30:00.000Z',
  affectedEvents: [],
  affectedFiles: [],
  missingOnChainSeqs: [],
  events: [
    {
      eventId: 'ev-1',
      seq: 1,
      eventType: 'CREATED' as const,
      chainStatus: 'ANCHORED',
      verdict: 'MATCH' as const,
      reasons: [],
      recomputedHash: '0x' + 'ab'.repeat(32),
      storedHash: '0x' + 'ab'.repeat(32),
      onChainHash: '0x' + 'ab'.repeat(32),
      txHash: '0x' + 'aa'.repeat(32),
      explorerUrl: null,
      anchoredAt: '2026-11-21T07:00:00.000Z',
      filesChecked: 1,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Phase 2 pages — LandingPortal & AuditExplorer', () => {
  it('renders LandingPortal with live passport preview and cleaned terminology', async () => {
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
        return new Response(JSON.stringify(SAMPLE_VERIFICATION), { status: 200 });
      }
      if (url.includes('/v1/public/passports/pub123')) {
        return new Response(JSON.stringify(SAMPLE_PASSPORT), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          viewLevel: 'full',
          items: [SAMPLE_LIST_ITEM],
          total: 1,
          limit: 8,
          offset: 0,
        }),
        { status: 200 },
      );
    });

    const { container } = render(<LandingPortal />, { wrapper });

    expect(
      screen.getByText(/Tamper-Evident Chain of Custody for Industrial B3 Waste/i),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Spent Industrial Solvent')).toBeInTheDocument();
    });
    expect(screen.getByText(/Flagged: TB3-2026-0041/)).toBeInTheDocument();
    expect(container.textContent?.toLowerCase()).not.toContain('tamper' + '-proof');
    expect(container.textContent).not.toContain('ARCHITECTTURE');
    expect(container.textContent).not.toContain('FFLIC Izunga');
  });

  it('renders AuditExplorer with Read-Only badge, 4 diagnostic cards, and live lookup verification', async () => {
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
      if (url.includes('/v1/public/lookup')) {
        return new Response(
          JSON.stringify({
            publicId: 'pub123',
            batchId: SAMPLE_LIST_ITEM.batchId,
            batchRef: 'TB3-2026-0041',
            matchedBy: 'batchRef',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/verify')) {
        return new Response(JSON.stringify(SAMPLE_VERIFICATION), { status: 200 });
      }
      if (url.includes('/v1/public/passports/pub123')) {
        return new Response(JSON.stringify(SAMPLE_PASSPORT), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          viewLevel: 'full',
          items: [SAMPLE_LIST_ITEM],
          total: 1,
          limit: 50,
          offset: 0,
        }),
        { status: 200 },
      );
    });

    const { container } = render(<AuditExplorer />, { wrapper });
    expect(screen.getByText('Read-Only Audit Mode')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Spent Industrial Solvent')).toBeInTheDocument();
    });

    fireEvent.change(
      screen.getByLabelText(/Enter Batch ID, Public ID, or Transaction Hash/i),
      { target: { value: 'TB3-2026-0041' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Run Integrity Verification/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/-230 kg -27\.06% \(Critical Discrepancy\)/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/SHA-256 Hash Match Verification/i)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Verificated');
    expect(container.textContent).not.toContain('#991B1B');
    expect(container.textContent?.toLowerCase()).not.toContain('tamper' + '-proof');
  });
});
