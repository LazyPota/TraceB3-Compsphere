import { createHash } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/index.js';
import {
  auditLog,
  batches,
  custodyEvents,
  evidenceFiles,
  newId,
} from '../db/schema.js';
import { AppError } from '../errors.js';
import type { AuthContext } from '../middleware/auth.js';
import type { StorageAdapter } from '../storage/adapter.js';

export type AllowedEvidenceMime =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

const MIME_TO_EXTENSION: Record<AllowedEvidenceMime, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inspects file magic bytes to verify an allowed evidence MIME type.
 * Never trusts client-supplied Content-Type headers.
 */
export function detectEvidenceMimeFromMagicBytes(
  bytes: Uint8Array,
): AllowedEvidenceMime | null {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  ) {
    return 'application/pdf';
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }

  return null;
}

export interface UploadedEvidenceDto {
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

export interface SignedDownloadDto {
  id: string;
  url: string;
  expiresInSeconds: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Streams an uploaded evidence file, checks magic bytes + max byte limit,
 * computes SHA-256 server-side during streaming, stores the blob, and persists DB metadata.
 */
export async function ingestEvidenceUpload(params: {
  db: DatabaseClient;
  storage: StorageAdapter;
  config: Pick<AppConfig, 'MAX_UPLOAD_MB'>;
  auth: AuthContext;
  batchParam: string;
  file: File;
  label?: string;
  requestId?: string;
}): Promise<UploadedEvidenceDto> {
  const { db, storage, config, auth, batchParam, file, label, requestId } =
    params;

  let resolvedBatchId: string | null = null;
  if (batchParam !== 'staging') {
    if (!UUID_REGEX.test(batchParam)) {
      throw AppError.validation(
        'Batch ID must be a valid UUID or "staging"',
      );
    }
    const existingBatch = await db.db
      .select({ id: batches.id })
      .from(batches)
      .where(eq(batches.id, batchParam))
      .limit(1);
    if (!existingBatch[0]) {
      throw AppError.notFound(`Batch ${batchParam} not found`);
    }
    resolvedBatchId = batchParam;
  }

  const maxBytes = Math.floor(config.MAX_UPLOAD_MB * 1024 * 1024);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let headerBuffer = Buffer.alloc(0);
  let detectedMime: AllowedEvidenceMime | null = null;
  let checkedHeader = false;
  const hasher = createHash('sha256');

  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw AppError.evidenceTooLarge(
          `Uploaded file exceeds MAX_UPLOAD_MB limit (${config.MAX_UPLOAD_MB} MB)`,
        );
      }

      const chunkBuf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!checkedHeader) {
        headerBuffer = Buffer.concat([headerBuffer, chunkBuf]);
        if (headerBuffer.length >= 12) {
          detectedMime = detectEvidenceMimeFromMagicBytes(headerBuffer);
          checkedHeader = true;
          if (!detectedMime) {
            await reader.cancel().catch(() => undefined);
            throw AppError.evidenceTypeNotAllowed();
          }
        }
      }

      hasher.update(chunkBuf);
      chunks.push(chunkBuf);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw AppError.validation('Uploaded file must not be empty');
  }

  if (!checkedHeader) {
    detectedMime = detectEvidenceMimeFromMagicBytes(headerBuffer);
    if (!detectedMime) {
      throw AppError.evidenceTypeNotAllowed();
    }
  }

  const sha256 = hasher.digest('hex').toLowerCase();
  const payloadBuffer = Buffer.concat(chunks);
  const evidenceId = newId();
  const safeBaseName = path.basename(file.name || `evidence${MIME_TO_EXTENSION[detectedMime!]}`);
  const storageKey = `evidence/${resolvedBatchId ?? 'staging'}/${evidenceId}${MIME_TO_EXTENSION[detectedMime!]}`;

  await storage.put(storageKey, payloadBuffer, detectedMime!, {
    upsert: false,
  });

  const resolvedLabel = (label ?? '').trim() || safeBaseName;
  const inserted = await db.db.transaction(async (tx) => {
    const rows = await tx
      .insert(evidenceFiles)
      .values({
        id: evidenceId,
        batchId: resolvedBatchId,
        eventId: null,
        uploadedByMemberId: auth.memberId,
        uploadedByOrgId: auth.orgId,
        storageDriver: storage.driverName,
        storageKey,
        originalFilename: safeBaseName,
        label: resolvedLabel,
        mimeType: detectedMime!,
        sizeBytes: totalBytes,
        sha256,
      })
      .returning();

    await tx.insert(auditLog).values({
      id: newId(),
      actorMemberId: auth.memberId,
      actorWallet: auth.address,
      actorRole: auth.role,
      action: 'UPLOAD_EVIDENCE',
      resourceType: 'evidence_file',
      resourceId: evidenceId,
      metadata: {
        batchId: resolvedBatchId,
        mimeType: detectedMime,
        sizeBytes: totalBytes,
        sha256,
      },
      requestId: requestId ?? null,
    });

    return rows[0]!;
  });

  return {
    id: inserted.id,
    batchId: inserted.batchId,
    eventId: inserted.eventId,
    filename: inserted.originalFilename,
    label: inserted.label,
    mimeType: inserted.mimeType,
    sizeBytes: inserted.sizeBytes,
    sha256: inserted.sha256,
    createdAt: inserted.createdAt.toISOString(),
  };
}

/**
 * Verifies org/role access and issues a short-lived signed download URL for an evidence object.
 */
export async function issueEvidenceDownloadUrl(params: {
  db: DatabaseClient;
  storage: StorageAdapter;
  auth: AuthContext;
  evidenceId: string;
}): Promise<SignedDownloadDto> {
  const { db, storage, auth, evidenceId } = params;

  const rows = await db.db
    .select()
    .from(evidenceFiles)
    .where(eq(evidenceFiles.id, evidenceId))
    .limit(1);
  const fileRow = rows[0];
  if (!fileRow) {
    throw AppError.notFound(`Evidence file ${evidenceId} not found`);
  }

  let authorized =
    auth.role === 'ADMIN' ||
    auth.role === 'AUDITOR' ||
    fileRow.uploadedByOrgId === auth.orgId;

  if (!authorized && fileRow.batchId) {
    const batchRows = await db.db
      .select()
      .from(batches)
      .where(eq(batches.id, fileRow.batchId))
      .limit(1);
    const batch = batchRows[0];
    if (
      batch &&
      (batch.generatorOrgId === auth.orgId ||
        batch.currentCustodianOrgId === auth.orgId)
    ) {
      authorized = true;
    } else {
      const eventRows = await db.db
        .select({
          actorOrgId: custodyEvents.actorOrgId,
          fromOrgId: custodyEvents.fromOrgId,
          toOrgId: custodyEvents.toOrgId,
        })
        .from(custodyEvents)
        .where(eq(custodyEvents.batchId, fileRow.batchId));
      authorized = eventRows.some(
        (ev) =>
          ev.actorOrgId === auth.orgId ||
          ev.fromOrgId === auth.orgId ||
          ev.toOrgId === auth.orgId,
      );
    }
  }

  if (!authorized) {
    throw AppError.forbidden(
      'Member organization is not authorized to access this evidence file',
    );
  }

  const expiresInSeconds = 120;
  const url = await storage.getSignedDownloadUrl(
    fileRow.storageKey,
    fileRow.originalFilename,
    expiresInSeconds,
  );

  return {
    id: fileRow.id,
    url,
    expiresInSeconds,
    filename: fileRow.originalFilename,
    mimeType: fileRow.mimeType,
    sizeBytes: fileRow.sizeBytes,
    sha256: fileRow.sha256,
  };
}
