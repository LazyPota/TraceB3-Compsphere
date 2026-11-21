import type { ActorRole, BatchStatus, EventType } from './enums.js';

export interface RevisionTargetEvent {
  seq: number;
  type: EventType;
  actorOrgId: string;
}

export interface CustodyTransitionInput {
  eventType: EventType;
  actorRole: ActorRole;
  actorOrgId: string;
  currentStatus: BatchStatus | null;
  currentCustodianOrgId: string | null;
  targetEvent?: RevisionTargetEvent | null;
}

export type CustodyTransitionResult =
  | {
      ok: true;
      nextStatus: BatchStatus;
      fromOrgId: string | null;
      toOrgId: string | null;
    }
  | {
      ok: false;
      code: 'FORBIDDEN_ROLE' | 'INVALID_TRANSITION' | 'BATCH_BUSY';
      message: string;
    };

const OPERATIONAL_ROLES = new Set<ActorRole>([
  'GENERATOR',
  'TRANSPORTER',
  'FACILITY',
]);

/**
 * Pure custody state machine matching TraceB3Ledger.sol transition invariants.
 */
export function validateCustodyTransition(
  input: CustodyTransitionInput,
): CustodyTransitionResult {
  const {
    eventType,
    actorRole,
    actorOrgId,
    currentStatus,
    currentCustodianOrgId,
    targetEvent,
  } = input;

  if (currentStatus === 'PENDING_CHAIN') {
    return {
      ok: false,
      code: 'BATCH_BUSY',
      message: 'Batch has an unconfirmed on-chain event in flight',
    };
  }

  switch (eventType) {
    case 'CREATED': {
      if (actorRole !== 'GENERATOR') {
        return {
          ok: false,
          code: 'FORBIDDEN_ROLE',
          message: 'Only GENERATOR members can create a waste batch',
        };
      }
      if (currentStatus !== null) {
        return {
          ok: false,
          code: 'INVALID_TRANSITION',
          message: `Cannot create batch when status is already ${currentStatus}`,
        };
      }
      return {
        ok: true,
        nextStatus: 'REGISTERED',
        fromOrgId: null,
        toOrgId: actorOrgId,
      };
    }

    case 'CUSTODY_TRANSFERRED': {
      if (actorRole !== 'TRANSPORTER' && actorRole !== 'FACILITY') {
        return {
          ok: false,
          code: 'FORBIDDEN_ROLE',
          message:
            'Only TRANSPORTER or FACILITY members can execute custody transfers',
        };
      }
      if (currentStatus === null) {
        return {
          ok: false,
          code: 'INVALID_TRANSITION',
          message: 'Cannot transfer custody before batch is created',
        };
      }
      if (currentStatus === 'REGISTERED') {
        if (actorRole !== 'TRANSPORTER') {
          return {
            ok: false,
            code: 'FORBIDDEN_ROLE',
            message:
              'Batch in REGISTERED state can only be picked up by a TRANSPORTER',
          };
        }
        if (currentCustodianOrgId === actorOrgId) {
          return {
            ok: false,
            code: 'INVALID_TRANSITION',
            message: 'Cannot transfer custody to the current custodian organization',
          };
        }
        return {
          ok: true,
          nextStatus: 'IN_TRANSIT',
          fromOrgId: currentCustodianOrgId,
          toOrgId: actorOrgId,
        };
      }
      if (currentStatus === 'IN_TRANSIT') {
        if (actorRole !== 'FACILITY') {
          return {
            ok: false,
            code: 'FORBIDDEN_ROLE',
            message:
              'Batch in IN_TRANSIT state can only be received by a FACILITY',
          };
        }
        if (currentCustodianOrgId === actorOrgId) {
          return {
            ok: false,
            code: 'INVALID_TRANSITION',
            message: 'Cannot transfer custody to the current custodian organization',
          };
        }
        return {
          ok: true,
          nextStatus: 'RECEIVED',
          fromOrgId: currentCustodianOrgId,
          toOrgId: actorOrgId,
        };
      }
      return {
        ok: false,
        code: 'INVALID_TRANSITION',
        message: `Custody transfer is not allowed from batch status ${currentStatus}`,
      };
    }

    case 'TREATMENT': {
      if (actorRole !== 'FACILITY') {
        return {
          ok: false,
          code: 'FORBIDDEN_ROLE',
          message: 'Only FACILITY members can record batch treatment',
        };
      }
      if (currentStatus !== 'RECEIVED') {
        return {
          ok: false,
          code: 'INVALID_TRANSITION',
          message: `Treatment is only allowed from RECEIVED status, got ${currentStatus ?? 'NONE'}`,
        };
      }
      if (currentCustodianOrgId !== actorOrgId) {
        return {
          ok: false,
          code: 'FORBIDDEN_ROLE',
          message:
            'Only the receiving custody organization can record batch treatment',
        };
      }
      return {
        ok: true,
        nextStatus: 'TREATED',
        fromOrgId: currentCustodianOrgId,
        toOrgId: actorOrgId,
      };
    }

    case 'REVISION': {
      if (!OPERATIONAL_ROLES.has(actorRole)) {
        return {
          ok: false,
          code: 'FORBIDDEN_ROLE',
          message: 'Only GENERATOR, TRANSPORTER, or FACILITY members can submit revisions',
        };
      }
      if (currentStatus === null) {
        return {
          ok: false,
          code: 'INVALID_TRANSITION',
          message: 'Cannot revise an uncreated batch',
        };
      }
      if (!targetEvent) {
        return {
          ok: false,
          code: 'INVALID_TRANSITION',
          message: 'Revision requires a valid target event',
        };
      }
      if (targetEvent.type === 'REVISION') {
        return {
          ok: false,
          code: 'INVALID_TRANSITION',
          message: 'Cannot target a REVISION event; target the original custody event instead',
        };
      }
      if (targetEvent.actorOrgId !== actorOrgId) {
        return {
          ok: false,
          code: 'FORBIDDEN_ROLE',
          message:
            'Revision must be authorized by the same organization that created the target event',
        };
      }
      return {
        ok: true,
        nextStatus: currentStatus,
        fromOrgId: null,
        toOrgId: null,
      };
    }
  }
}
