import { describe, expect, it, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DemoControlsDrawer } from '@/components/domain/demo-controls-drawer';
import { SettingsView } from '@/components/pages/settings-view';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    token: 'jwt-test',
    member: {
      id: 'mem-1',
      orgId: 'org-gen',
      orgName: 'PT Cikarang Kimia Manufaktur',
      orgType: 'generator',
      onChainOrgId: '0x' + '11'.repeat(32),
      walletAddress: '0xAA638C96AEBf82220aE8a3378fb0bE1072554304',
      displayName: 'Rina Santoso',
      role: 'GENERATOR',
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
});

describe('Phase 5 features — DemoControlsDrawer & SettingsView', () => {
  it('triggers file and DB tamper simulations and clears state cleanly', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/v1/dev/tamper')) {
        const body = JSON.parse(String(init?.body)) as { mode: 'db' | 'file'; batchId: string };
        return new Response(
          JSON.stringify({
            tampered: true,
            mode: body.mode,
            batchId: body.batchId,
            detail: `Simulated ${body.mode} tamper applied`,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          viewLevel: 'full',
          items: [
            {
              batchId: 'batch-demo-1',
              publicId: 'pubDemo1',
              batchRef: 'TB3-DEMO-1',
              wasteCode: 'B105d',
              wasteName: 'Spent Industrial Solvent',
              status: 'TREATED',
              generatorOrgName: 'PT Cikarang Kimia',
              currentCustodianOrgName: 'PT PPLI',
              hasDiscrepancy: false,
              maxDiscrepancySeverity: 'none',
              latestEventSeq: 5,
              latestEventHash: '0x' + 'ab'.repeat(32),
              hasRevisions: true,
              declaredWeightGrams: '850000',
              effectiveWeights: {
                declaredGrams: '850000',
                pickupGrams: '850000',
                deliveryGrams: '845000',
              },
              createdAt: '2026-11-21T07:00:00.000Z',
              updatedAt: '2026-11-21T08:00:00.000Z',
            },
          ],
          total: 1,
          limit: 10,
          offset: 0,
        }),
        { status: 200 },
      );
    });

    const { container } = render(<DemoControlsDrawer />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: /Demo Controls/i }));

    await waitFor(() => {
      expect(screen.getByText('TB3-DEMO-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Simulate File Swap Tamper/i }));
    await waitFor(() => {
      expect(screen.getByText(/Simulated file tamper applied/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Simulate DB Row Tamper/i }));
    await waitFor(() => {
      expect(screen.getByText(/Simulated db tamper applied/i)).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/dev/tamper'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent?.toLowerCase()).not.toContain('tamper' + '-proof');
  });

  it('renders SettingsView with Base Sepolia contract metadata and print preset selection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          chainId: 84532,
          networkName: 'Base Sepolia',
          ledgerAddress: '0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
          explorerBaseUrl: 'https://sepolia.basescan.org',
        }),
        { status: 200 },
      ),
    );

    render(<SettingsView />, { wrapper });

    expect(screen.getAllByText('Rina Santoso').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByText(/Base Sepolia \(chainId 84532\)/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /^BaseScan$/i })).toHaveAttribute(
        'href',
        'https://sepolia.basescan.org/address/0xF7566fF7dE836Ad8bD5BB3D484B32DD6796e90f1',
      );
    });

    const a4Btn = screen.getByRole('button', {
      name: /A4 Compliance Manifest Sheet/i,
    });
    fireEvent.click(a4Btn);
    expect(window.localStorage.getItem('traceb3_print_preset_v1')).toBe('a4_sheet');
  });
});
