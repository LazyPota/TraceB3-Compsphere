import { describe, expect, it } from 'vitest';
import { validateCustodyTransition } from '../src/state-machine.js';

describe('custody state machine', () => {
  it('accepts full lifecycle CREATED -> pickup -> delivery -> TREATMENT', () => {
    const createRes = validateCustodyTransition({
      eventType: 'CREATED',
      actorRole: 'GENERATOR',
      actorOrgId: 'org-gen',
      currentStatus: null,
      currentCustodianOrgId: null,
    });
    expect(createRes).toEqual({
      ok: true,
      nextStatus: 'REGISTERED',
      fromOrgId: null,
      toOrgId: 'org-gen',
    });

    const pickupRes = validateCustodyTransition({
      eventType: 'CUSTODY_TRANSFERRED',
      actorRole: 'TRANSPORTER',
      actorOrgId: 'org-trans',
      currentStatus: 'REGISTERED',
      currentCustodianOrgId: 'org-gen',
    });
    expect(pickupRes).toEqual({
      ok: true,
      nextStatus: 'IN_TRANSIT',
      fromOrgId: 'org-gen',
      toOrgId: 'org-trans',
    });

    const deliveryRes = validateCustodyTransition({
      eventType: 'CUSTODY_TRANSFERRED',
      actorRole: 'FACILITY',
      actorOrgId: 'org-fac',
      currentStatus: 'IN_TRANSIT',
      currentCustodianOrgId: 'org-trans',
    });
    expect(deliveryRes).toEqual({
      ok: true,
      nextStatus: 'RECEIVED',
      fromOrgId: 'org-trans',
      toOrgId: 'org-fac',
    });

    const treatRes = validateCustodyTransition({
      eventType: 'TREATMENT',
      actorRole: 'FACILITY',
      actorOrgId: 'org-fac',
      currentStatus: 'RECEIVED',
      currentCustodianOrgId: 'org-fac',
    });
    expect(treatRes).toEqual({
      ok: true,
      nextStatus: 'TREATED',
      fromOrgId: 'org-fac',
      toOrgId: 'org-fac',
    });
  });

  it('rejects forbidden roles and invalid state transitions', () => {
    expect(
      validateCustodyTransition({
        eventType: 'CREATED',
        actorRole: 'TRANSPORTER',
        actorOrgId: 'org-trans',
        currentStatus: null,
        currentCustodianOrgId: null,
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });

    expect(
      validateCustodyTransition({
        eventType: 'CUSTODY_TRANSFERRED',
        actorRole: 'FACILITY',
        actorOrgId: 'org-fac',
        currentStatus: 'REGISTERED',
        currentCustodianOrgId: 'org-gen',
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });

    expect(
      validateCustodyTransition({
        eventType: 'CUSTODY_TRANSFERRED',
        actorRole: 'TRANSPORTER',
        actorOrgId: 'org-trans',
        currentStatus: 'RECEIVED',
        currentCustodianOrgId: 'org-fac',
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });

    expect(
      validateCustodyTransition({
        eventType: 'TREATMENT',
        actorRole: 'FACILITY',
        actorOrgId: 'org-other-fac',
        currentStatus: 'RECEIVED',
        currentCustodianOrgId: 'org-fac',
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });

    expect(
      validateCustodyTransition({
        eventType: 'CUSTODY_TRANSFERRED',
        actorRole: 'TRANSPORTER',
        actorOrgId: 'org-trans',
        currentStatus: 'PENDING_CHAIN',
        currentCustodianOrgId: 'org-gen',
      }),
    ).toMatchObject({ ok: false, code: 'BATCH_BUSY' });
  });

  it('allows revisions only by the original organization on non-revision events', () => {
    expect(
      validateCustodyTransition({
        eventType: 'REVISION',
        actorRole: 'FACILITY',
        actorOrgId: 'org-fac',
        currentStatus: 'RECEIVED',
        currentCustodianOrgId: 'org-fac',
        targetEvent: { seq: 3, type: 'CUSTODY_TRANSFERRED', actorOrgId: 'org-fac' },
      }),
    ).toEqual({
      ok: true,
      nextStatus: 'RECEIVED',
      fromOrgId: null,
      toOrgId: null,
    });

    expect(
      validateCustodyTransition({
        eventType: 'REVISION',
        actorRole: 'GENERATOR',
        actorOrgId: 'org-gen',
        currentStatus: 'RECEIVED',
        currentCustodianOrgId: 'org-fac',
        targetEvent: { seq: 3, type: 'CUSTODY_TRANSFERRED', actorOrgId: 'org-fac' },
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });

    expect(
      validateCustodyTransition({
        eventType: 'REVISION',
        actorRole: 'FACILITY',
        actorOrgId: 'org-fac',
        currentStatus: 'RECEIVED',
        currentCustodianOrgId: 'org-fac',
        targetEvent: { seq: 4, type: 'REVISION', actorOrgId: 'org-fac' },
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });
});
