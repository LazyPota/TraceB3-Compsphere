import type {
  ActorRole,
  BatchStatus,
  DiscrepancyCode,
  EventType,
  ReasonCode,
} from '@traceb3/core';

export interface B3WasteCodeOption {
  code: string;
  name: string;
  category: string;
}

/**
 * Common hazardous waste codes from PP No. 22/2021 Lampiran IX (Indonesia).
 * The combobox also permits custom code entry accepted by the backend.
 */
export const B3_WASTE_CODES: readonly B3WasteCodeOption[] = [
  { code: 'A102d', name: 'Spent Organic Solvents & Thinners', category: 'Category 1' },
  { code: 'B105d', name: 'Spent Industrial Solvent / Lubricating Oil', category: 'Category 2' },
  { code: 'A106d', name: 'Hazardous Laboratory Chemical Residue', category: 'Category 1' },
  { code: 'A108d', name: 'Waste Ink, Dyes & Paint Sludge', category: 'Category 1' },
  { code: 'B104d', name: 'Contaminated Packaging & Steel Drums', category: 'Category 2' },
  { code: 'B109d', name: 'Spent Aqueous Alkaline / Acid Wash', category: 'Category 2' },
  { code: 'B110d', name: 'Contaminated Rags, Absorbents & PPE', category: 'Category 2' },
  { code: 'A306-1', name: 'Petrochemical Catalyst & Resin Residue', category: 'Category 1' },
  { code: 'B321-1', name: 'WWTP Chemical Dewatering Sludge', category: 'Category 2' },
  { code: 'A337-1', name: 'Clinical & Pharmaceutical Chemical Waste', category: 'Category 1' },
];

export const CONTAINER_TYPES = [
  '200L Steel Drums',
  '1000L IBC Tote',
  'HDPE Jerrycans',
  'Sealed Roll-Off Skip',
  'Flexibag / Tanker',
] as const;

export const REASON_CODE_LABELS: Record<ReasonCode, string> = {
  SCALE_RECALIBRATION: 'Scale Recalibration',
  UNIT_CORRECTION: 'Unit Entry Correction',
  DATA_ENTRY_ERROR: 'Data Entry Error',
  MANIFEST_AMENDMENT: 'Updated Manifest / Lab Analysis',
  OTHER: 'Other Justification',
};

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  PENDING_CHAIN: 'Pending Anchor',
  REGISTERED: 'Registered',
  IN_TRANSIT: 'In Transit',
  RECEIVED: 'Received',
  TREATED: 'Treated',
};

export const ACTOR_ROLE_LABELS: Record<ActorRole, string> = {
  GENERATOR: 'Generator',
  TRANSPORTER: 'Transporter',
  FACILITY: 'Treatment Facility',
  AUDITOR: 'Compliance Auditor',
  ADMIN: 'Platform Admin',
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  CREATED: 'Batch Created & Anchored',
  CUSTODY_TRANSFERRED: 'Custody Transferred',
  REVISION: 'Append-Only Revision',
  TREATMENT: 'Treatment Completed',
};

export const DISCREPANCY_CODE_LABELS: Record<DiscrepancyCode, string> = {
  WEIGHT_MISMATCH_PICKUP: 'Pickup Weight Variance',
  WEIGHT_MISMATCH_DELIVERY: 'Delivery Weight Variance',
  WEIGHT_MISMATCH_TOTAL: 'Total Weight Discrepancy',
  LIKELY_UNIT_ERROR: 'Likely Unit Mismatch (1000x)',
  CUSTODY_GAP: 'Custody Handover Delay',
  VALUE_REVISED: 'Record Value Revised',
};

export function generateBatchRef(date = new Date()): string {
  const year = date.getFullYear();
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
  return `TB3-${year}-${suffix}`;
}

export function formatShortHash(hash: string | null | undefined, start = 8, end = 6): string {
  if (!hash) return '—';
  if (hash.length <= start + end + 3) return hash;
  return `${hash.slice(0, start)}…${hash.slice(-end)}`;
}

export function formatShortAddress(address: string | null | undefined): string {
  return formatShortHash(address, 6, 4);
}

export function formatTimestampWib(iso: string | null | undefined): string {
  if (!iso) return 'Pending anchor';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return (
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(parsed) + ' WIB'
    );
  } catch {
    return parsed.toISOString();
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
