import type {
  ActorRole,
  ApiErrorCode,
  BatchStatus,
  CanonicalEventRecordV1,
  ChainStatus,
  CustodyIntentTypedDataJson,
  DiscrepancyReport,
  DiscrepancySeverity,
  EventType,
  EventVerificationVerdict,
  NormalizedQuantity,
  OrgType,
  OverallVerificationVerdict,
  ProofBundle,
  PublicViewLevel,
  ReasonCode,
  WeightUnit,
} from '@traceb3/core';
import { webEnv } from './env';

export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  UNAUTHENTICATED: 'Your wallet session expired or is missing. Please sign in again.',
  FORBIDDEN_ROLE: 'Your registered role does not have permission for this action.',
  VALIDATION_ERROR: 'Please check the highlighted form fields and try again.',
  INVALID_TRANSITION: 'This batch is not in a valid custody state for that action.',
  BATCH_BUSY:
    'Another custody transaction is already anchoring for this batch. Please retry in a few seconds.',
  INTENT_EXPIRED: 'This signing intent expired before submission. Prepare a fresh intent to sign.',
  BAD_SIGNATURE:
    'The wallet signature did not match your authenticated member address. Verify the active wallet and sign again.',
  EVIDENCE_TOO_LARGE: 'The uploaded file exceeds the maximum allowed size limit (10 MB).',
  EVIDENCE_TYPE_NOT_ALLOWED:
    'Only verified PDF, JPEG, PNG, or WebP files (validated by magic bytes) are accepted.',
  CHAIN_REVERT: 'On-chain validation rejected this custody step.',
  CHAIN_UNAVAILABLE: 'Blockchain RPC or relayer is temporarily unavailable. Please retry shortly.',
  NOT_FOUND: 'The requested batch, passport, or evidence record was not found.',
  RATE_LIMITED: 'Too many requests right now. Please wait a moment and try again.',
  INTERNAL_ERROR: 'An unexpected server error occurred. Check API logs or retry.',
};

export interface ProblemDetailsJson {
  type: string;
  title: string;
  status: number;
  detail: string;
  code?: string;
  requestId?: string;
  errors?: Array<Record<string, unknown>>;
}

export class ApiProblemError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly requestId?: string;
  readonly errors?: Array<Record<string, unknown>>;
  readonly userMessage: string;

  constructor(params: {
    status: number;
    code: ApiErrorCode;
    title: string;
    detail: string;
    requestId?: string;
    errors?: Array<Record<string, unknown>>;
  }) {
    const fallback = ERROR_MESSAGES[params.code] ?? ERROR_MESSAGES.INTERNAL_ERROR;
    const userMessage =
      params.code === 'VALIDATION_ERROR' ||
      params.code === 'CHAIN_REVERT' ||
      params.code === 'INVALID_TRANSITION' ||
      params.code === 'FORBIDDEN_ROLE'
        ? params.detail || fallback
        : fallback;
    super(params.detail || params.title || fallback);
    this.name = 'ApiProblemError';
    this.status = params.status;
    this.code = params.code;
    this.title = params.title;
    this.detail = params.detail;
    this.requestId = params.requestId;
    this.errors = params.errors;
    this.userMessage = userMessage;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

function normalizeErrorCode(status: number, rawCode?: string): ApiErrorCode {
  if (rawCode && rawCode in ERROR_MESSAGES) {
    return rawCode as ApiErrorCode;
  }
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN_ROLE';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'INVALID_TRANSITION';
  if (status === 410) return 'INTENT_EXPIRED';
  if (status === 413) return 'EVIDENCE_TOO_LARGE';
  if (status === 415) return 'EVIDENCE_TYPE_NOT_ALLOWED';
  if (status === 422) return 'CHAIN_REVERT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'CHAIN_UNAVAILABLE';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

export async function parseProblemResponse(res: Response): Promise<ApiProblemError> {
  let body: Partial<ProblemDetailsJson> | null = null;
  try {
    body = (await res.json()) as Partial<ProblemDetailsJson>;
  } catch {
    body = null;
  }
  const code = normalizeErrorCode(res.status, body?.code);
  return new ApiProblemError({
    status: body?.status ?? res.status,
    code,
    title: body?.title || res.statusText || 'Request failed',
    detail: body?.detail || ERROR_MESSAGES[code],
    requestId: body?.requestId,
    errors: body?.errors,
  });
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit & { token?: string; skipUnauthorizedTrigger?: boolean },
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.token) {
    headers.set('Authorization', `Bearer ${init.token}`);
  }
  const res = await fetch(`${webEnv.apiUrl}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    if (res.status === 401 && !init?.skipUnauthorizedTrigger) {
      unauthorizedHandler?.();
    }
    throw await parseProblemResponse(res);
  }
  return (await res.json()) as T;
}

// ---------- DTO Types matching backend OpenAPI responses ----------

export interface ChainInfo {
  chainId: number;
  networkName: string;
  ledgerAddress: string | null;
  explorerBaseUrl: string | null;
}

export interface MemberProfile {
  id: string;
  orgId: string;
  orgName: string;
  orgType: OrgType;
  onChainOrgId: string;
  walletAddress: string;
  displayName: string;
  role: ActorRole;
}

export interface AuthNonceResponse {
  nonce: string;
  domain: string;
  chainId: number;
  expiresAt: string;
}

export interface AuthVerifyResponse {
  token: string;
  expiresAt: string;
  member: MemberProfile;
}

export interface OrgRef {
  id: string;
  name: string;
  code: string;
  orgType: string;
}

export interface BatchSummary {
  id: string;
  publicId: string;
  batchRef: string;
  onChainBatchId: string;
  wasteCode: string;
  wasteName: string;
  wasteCategory: string | null;
  status: BatchStatus;
  generatorOrgId: string;
  generatorOrg: OrgRef | null;
  currentCustodianOrgId: string | null;
  currentCustodianOrg: OrgRef | null;
  declaredWeightGrams: string | null;
  latestEventSeq: number;
  latestEventHash: string;
  hasDiscrepancy: boolean;
  maxDiscrepancySeverity: DiscrepancySeverity;
  festronikRef: string | null;
  monijaRef: string | null;
  publicPassportUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface BatchListResponse {
  items: BatchSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface TimelineEvidenceItem {
  id: string | null;
  sha256: string;
  mime: string;
  size: number;
  label: string;
  filename: string | null;
}

export interface TimelineEvent {
  id: string;
  seq: number;
  eventType: EventType;
  actorWallet: string;
  actorOrgId: string;
  actorOrg: OrgRef | null;
  fromOrgId: string | null;
  fromOrg: OrgRef | null;
  toOrgId: string | null;
  toOrg: OrgRef | null;
  targetSeq: number | null;
  revisedBySeqs: number[];
  reasonCode: ReasonCode | null;
  quantity: NormalizedQuantity | null;
  evidence: TimelineEvidenceItem[];
  eventHash: string;
  prevEventHash: string;
  chainStatus: ChainStatus;
  txHash: string | null;
  explorerUrl: string | null;
  blockNumber: number | null;
  anchoredAt: string | null;
  failureReason: string | null;
  record: CanonicalEventRecordV1;
  createdAt: string;
}

export interface BatchTimelineResponse {
  batchId: string;
  publicId: string;
  batchRef: string;
  events: TimelineEvent[];
}

export interface BatchDiscrepanciesResponse extends DiscrepancyReport {
  batchId: string;
  batchRef: string;
}

export interface PublicPassportSummary {
  batchId: string;
  publicId: string;
  batchRef: string;
  wasteCode: string;
  wasteName: string;
  status: BatchStatus;
  generatorOrgName: string | null;
  currentCustodianOrgName: string | null;
  hasDiscrepancy: boolean;
  maxDiscrepancySeverity: DiscrepancySeverity;
  latestEventSeq: number;
  latestEventHash: string;
  hasRevisions: boolean;
  declaredWeightGrams: string | null;
  effectiveWeights: {
    declaredGrams: string | null;
    pickupGrams: string | null;
    deliveryGrams: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PublicPassportListResponse {
  viewLevel: PublicViewLevel;
  items: PublicPassportSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface PublicLookupResponse {
  publicId: string;
  batchId: string;
  batchRef: string;
  matchedBy:
    | 'publicId'
    | 'batchRef'
    | 'batchId'
    | 'txHash'
    | 'eventHash'
    | 'onChainBatchId';
}

export interface PublicPassportEvent {
  id: string;
  seq: number;
  eventType: EventType;
  actorOrgName: string | null;
  fromOrgName: string | null;
  toOrgName: string | null;
  targetSeq: number | null;
  reasonCode: ReasonCode | null;
  chainStatus: ChainStatus;
  txHash: string | null;
  explorerUrl: string | null;
  anchoredAt: string | null;
  eventHash: string;
  quantity?: NormalizedQuantity | null;
  notes?: string | null;
  evidenceCount: number;
  evidence?: Array<{
    id: string | null;
    sha256: string;
    mime: string;
    size: number;
    label: string;
  }>;
}

export interface PublicPassportResponse {
  viewLevel: PublicViewLevel;
  batchId: string;
  publicId: string;
  batchRef: string;
  onChainBatchId: string;
  wasteCode: string;
  wasteName: string;
  wasteCategory: string | null;
  status: BatchStatus;
  generatorOrgName: string | null;
  currentCustodianOrgName: string | null;
  hasDiscrepancy: boolean;
  maxDiscrepancySeverity: DiscrepancySeverity;
  declaredWeightGrams?: string | null;
  festronikRef: string | null;
  monijaRef: string | null;
  events: PublicPassportEvent[];
  discrepancies?: DiscrepancyReport;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationResponse {
  batchId: string;
  publicId: string;
  batchRef: string;
  onChainBatchId: string;
  verdict: OverallVerificationVerdict;
  chainId: number;
  ledgerAddress: string | null;
  onChainEventCount: number;
  checkedAt: string;
  affectedEvents: Array<{
    eventId: string;
    seq: number;
    verdict: EventVerificationVerdict;
    reason: string;
  }>;
  affectedFiles: Array<{
    evidenceId: string | null;
    eventId: string;
    seq: number;
    filename: string;
    issue: 'FILE_MISSING' | 'FILE_MISMATCH';
    expectedSha256: string;
    actualSha256: string | null;
  }>;
  missingOnChainSeqs: number[];
  events: Array<{
    eventId: string;
    seq: number;
    eventType: EventType;
    chainStatus: string;
    verdict: EventVerificationVerdict;
    reasons: string[];
    recomputedHash: string;
    storedHash: string;
    onChainHash: string | null;
    txHash: string | null;
    explorerUrl: string | null;
    anchoredAt: string | null;
    filesChecked: number;
  }>;
}

export interface EvidenceUploadResponse {
  id: string;
  batchId: string | null;
  eventId: string | null;
  filename: string;
  label: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface SignedDownloadResponse {
  id: string;
  url: string;
  expiresInSeconds: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface CreateIntentPayload {
  kind: EventType;
  batchId?: string;
  data: {
    batchRef?: string;
    wasteCode?: string;
    wasteName?: string;
    wasteCategory?: string;
    festronikRef?: string;
    monijaRef?: string;
    quantity?: { value: string; unit: WeightUnit };
    targetSeq?: number;
    reasonCode?: ReasonCode;
    notes?: string;
  };
  evidenceIds?: string[];
}

export interface CreateIntentResponse {
  intentId: string;
  batchId: string;
  seq: number;
  eventHash: string;
  typedData: CustodyIntentTypedDataJson;
  eventPreview: CanonicalEventRecordV1;
  expiresAt: string;
}

export interface SubmitIntentResponse {
  eventId: string;
  batchId: string;
  seq: number;
  status: 'PENDING';
  eventHash: string;
}

export interface EventStatusResponse {
  eventId: string;
  batchId: string;
  seq: number;
  eventType: EventType;
  chainStatus: ChainStatus;
  txHash: string | null;
  blockNumber: number | null;
  anchoredAt: string | null;
  failureReason: string | null;
  explorerUrl: string | null;
}

export interface AuditLogItem {
  id: string;
  actorMemberId: string | null;
  actorWallet: string | null;
  actorRole: ActorRole | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

export interface AuditLogListResponse {
  items: AuditLogItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface DevSeedRequest {
  wallets?: Partial<Record<ActorRole, string>>;
}

export interface DevSeedResponse {
  createdOrganizations: number;
  createdMembers: number;
  onChainRegisteredCount: number;
  organizations: Array<{
    id: string;
    code: string;
    name: string;
    orgType: OrgType;
    onChainOrgId: string;
  }>;
  members: Array<{
    id: string;
    orgId: string;
    orgCode: string;
    onChainOrgId: string;
    walletAddress: string;
    displayName: string;
    role: ActorRole;
    status: string;
  }>;
}

export interface DevTamperRequest {
  mode: 'db' | 'file';
  batchId: string;
  eventSeq?: number;
  tamperedWeightGrams?: string;
  evidenceId?: string;
}

export interface DevTamperResponse {
  tampered: true;
  mode: 'db' | 'file';
  batchId: string;
  eventId?: string;
  seq?: number;
  evidenceId?: string;
  filename?: string;
  detail: string;
}

// ---------- Endpoint Functions ----------

export const api = {
  getChainInfo: () => apiRequest<ChainInfo>('/v1/chain/info'),

  getNonce: () =>
    apiRequest<AuthNonceResponse>('/v1/auth/nonce', {
      cache: 'no-store',
    }),

  verifySiwe: (message: string, signature: string) =>
    apiRequest<AuthVerifyResponse>('/v1/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature }),
      skipUnauthorizedTrigger: true,
    }),

  getMe: (token: string) =>
    apiRequest<{ member: MemberProfile }>('/v1/auth/me', { token }),

  listBatches: (
    token: string,
    params?: {
      status?: BatchStatus;
      hasDiscrepancy?: boolean;
      limit?: number;
      offset?: number;
    },
  ) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.hasDiscrepancy !== undefined) {
      qs.set('has_discrepancy', String(params.hasDiscrepancy));
    }
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const q = qs.toString();
    return apiRequest<BatchListResponse>(`/v1/batches${q ? `?${q}` : ''}`, { token });
  },

  getBatch: (token: string, id: string) =>
    apiRequest<BatchSummary>(`/v1/batches/${id}`, { token }),

  getBatchTimeline: (token: string, id: string) =>
    apiRequest<BatchTimelineResponse>(`/v1/batches/${id}/timeline`, { token }),

  getBatchDiscrepancies: (token: string, id: string) =>
    apiRequest<BatchDiscrepanciesResponse>(`/v1/batches/${id}/discrepancies`, { token }),

  fetchBatchQrSvg: async (token: string, id: string): Promise<string> => {
    const res = await fetch(`${webEnv.apiUrl}/v1/batches/${id}/qr?format=svg`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw await parseProblemResponse(res);
    return res.text();
  },

  fetchBatchQrPngBlob: async (token: string, id: string): Promise<Blob> => {
    const res = await fetch(`${webEnv.apiUrl}/v1/batches/${id}/qr?format=png`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw await parseProblemResponse(res);
    return res.blob();
  },

  uploadEvidence: async (
    token: string,
    batchIdOrStaging: string,
    file: File,
    label?: string,
  ): Promise<EvidenceUploadResponse> => {
    const form = new FormData();
    form.append('file', file);
    if (label?.trim()) {
      form.append('label', label.trim());
    }
    return apiRequest<EvidenceUploadResponse>(
      `/v1/batches/${encodeURIComponent(batchIdOrStaging)}/evidence`,
      {
        method: 'POST',
        body: form,
        token,
      },
    );
  },

  getEvidenceDownload: (token: string, evidenceId: string) =>
    apiRequest<SignedDownloadResponse>(`/v1/evidence/${evidenceId}/download`, { token }),

  createIntent: (token: string, payload: CreateIntentPayload) =>
    apiRequest<CreateIntentResponse>('/v1/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        evidenceIds: payload.evidenceIds ?? [],
      }),
      token,
    }),

  submitIntent: (
    token: string,
    intentId: string,
    signature: string,
    idempotencyKey: string,
  ) =>
    apiRequest<SubmitIntentResponse>(`/v1/intents/${intentId}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ signature }),
      token,
    }),

  getEventStatus: (token: string, eventId: string) =>
    apiRequest<EventStatusResponse>(`/v1/events/${eventId}/status`, { token }),

  listAuditLogs: (token: string, params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const q = qs.toString();
    return apiRequest<AuditLogListResponse>(`/v1/audit-logs${q ? `?${q}` : ''}`, { token });
  },

  listPublicPassports: (params?: {
    limit?: number;
    offset?: number;
    flagged?: boolean;
    status?: BatchStatus;
  }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    if (params?.flagged !== undefined) qs.set('flagged', String(params.flagged));
    if (params?.status) qs.set('status', params.status);
    const q = qs.toString();
    return apiRequest<PublicPassportListResponse>(
      `/v1/public/passports${q ? `?${q}` : ''}`,
    );
  },

  lookupPublicPassport: (query: string) =>
    apiRequest<PublicLookupResponse>(
      `/v1/public/lookup?q=${encodeURIComponent(query.trim())}`,
    ),

  getPublicPassport: (publicId: string) =>
    apiRequest<PublicPassportResponse>(
      `/v1/public/passports/${encodeURIComponent(publicId)}`,
    ),

  verifyPublicPassport: (publicId: string) =>
    apiRequest<VerificationResponse>(
      `/v1/public/passports/${encodeURIComponent(publicId)}/verify`,
    ),

  getProofBundle: (publicId: string) =>
    apiRequest<ProofBundle>(
      `/v1/public/passports/${encodeURIComponent(publicId)}/proof-bundle`,
    ),

  devSeed: (body?: DevSeedRequest) =>
    apiRequest<DevSeedResponse>('/v1/dev/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),

  devTamper: (body: DevTamperRequest) =>
    apiRequest<DevTamperResponse>('/v1/dev/tamper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

/**
 * Watches anchor progression via SSE (`GET /v1/events/:id/stream`) with automatic
 * fallback to 1.5s status polling until ANCHORED or FAILED.
 */
export async function watchEventStatus(
  token: string,
  eventId: string,
  onUpdate: (update: EventStatusResponse) => void,
  signal?: AbortSignal,
): Promise<EventStatusResponse> {
  let latest: EventStatusResponse | null = null;
  try {
    const res = await fetch(`${webEnv.apiUrl}/v1/events/${eventId}/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame
            .split('\n')
            .find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine.slice(5).trim()) as Partial<EventStatusResponse>;
          if (payload.chainStatus) {
            const normalized = payload as EventStatusResponse;
            latest = normalized;
            onUpdate(normalized);
            if (
              normalized.chainStatus === 'ANCHORED' ||
              normalized.chainStatus === 'FAILED'
            ) {
              return normalized;
            }
          }
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // Fall through cleanly to status polling.
  }

  // Fallback / completion polling
  const deadlineMs = Date.now() + 90_000;
  while (Date.now() < deadlineMs) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const status = await api.getEventStatus(token, eventId);
    latest = status;
    onUpdate(status);
    if (status.chainStatus === 'ANCHORED' || status.chainStatus === 'FAILED') {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (latest) return latest;
  throw new ApiProblemError({
    status: 504,
    code: 'CHAIN_UNAVAILABLE',
    title: 'Confirmation timeout',
    detail: 'Timed out waiting for transaction anchor confirmation.',
  });
}
