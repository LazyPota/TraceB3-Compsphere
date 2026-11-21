export interface StructuredBatchNotesInput {
  containerCount?: string;
  containerType?: string;
  labSummary?: string;
  labReportRef?: string;
  freeNotes?: string;
}

export interface ParsedBatchNotes {
  containerSummary: string | null;
  labSummary: string | null;
  labReportRef: string | null;
  freeNotes: string | null;
}

const CONTAINER_PREFIX = 'Containers: ';
const LAB_SUMMARY_PREFIX = 'Lab Summary: ';
const LAB_REF_PREFIX = 'Lab Report Ref: ';

/**
 * Serializes UI-only batch attributes into deterministic canonical `notes` lines
 * so they become part of the RFC 8785 hashed and anchored record.
 */
export function serializeBatchNotes(input: StructuredBatchNotesInput): string | undefined {
  const lines: string[] = [];
  const count = input.containerCount?.trim();
  const type = input.containerType?.trim();
  if (count && type) {
    lines.push(`${CONTAINER_PREFIX}${count} x ${type}`);
  } else if (count) {
    lines.push(`${CONTAINER_PREFIX}${count}`);
  } else if (type) {
    lines.push(`${CONTAINER_PREFIX}${type}`);
  }

  const labSummary = input.labSummary?.trim();
  if (labSummary) {
    lines.push(`${LAB_SUMMARY_PREFIX}${labSummary}`);
  }

  const labRef = input.labReportRef?.trim();
  if (labRef) {
    lines.push(`${LAB_REF_PREFIX}${labRef}`);
  }

  const free = input.freeNotes?.trim();
  if (free) {
    lines.push(free);
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

export function parseBatchNotes(raw: string | null | undefined): ParsedBatchNotes {
  if (!raw || !raw.trim()) {
    return {
      containerSummary: null,
      labSummary: null,
      labReportRef: null,
      freeNotes: null,
    };
  }

  let containerSummary: string | null = null;
  let labSummary: string | null = null;
  let labReportRef: string | null = null;
  const remaining: string[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(CONTAINER_PREFIX)) {
      containerSummary = line.slice(CONTAINER_PREFIX.length).trim() || null;
    } else if (line.startsWith(LAB_SUMMARY_PREFIX)) {
      labSummary = line.slice(LAB_SUMMARY_PREFIX.length).trim() || null;
    } else if (line.startsWith(LAB_REF_PREFIX)) {
      labReportRef = line.slice(LAB_REF_PREFIX.length).trim() || null;
    } else {
      remaining.push(line);
    }
  }

  return {
    containerSummary,
    labSummary,
    labReportRef,
    freeNotes: remaining.length > 0 ? remaining.join('\n') : null,
  };
}
