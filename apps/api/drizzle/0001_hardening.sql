CREATE UNIQUE INDEX custody_events_batch_seq_active_uniq ON custody_events (batch_id, seq) WHERE chain_status != 'FAILED';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_custody_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'custody_events is append-only: DELETE is not permitted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
      OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
      OR NEW.seq IS DISTINCT FROM OLD.seq
      OR NEW.event_type IS DISTINCT FROM OLD.event_type
      OR NEW.actor_member_id IS DISTINCT FROM OLD.actor_member_id
      OR NEW.actor_wallet IS DISTINCT FROM OLD.actor_wallet
      OR NEW.actor_org_id IS DISTINCT FROM OLD.actor_org_id
      OR NEW.from_org_id IS DISTINCT FROM OLD.from_org_id
      OR NEW.to_org_id IS DISTINCT FROM OLD.to_org_id
      OR NEW.target_seq IS DISTINCT FROM OLD.target_seq
      OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
      OR NEW.quantity_grams IS DISTINCT FROM OLD.quantity_grams
      OR NEW.quantity_unit IS DISTINCT FROM OLD.quantity_unit
      OR NEW.record IS DISTINCT FROM OLD.record
      OR NEW.event_hash IS DISTINCT FROM OLD.event_hash
      OR NEW.prev_event_hash IS DISTINCT FROM OLD.prev_event_hash
      OR NEW.signature IS DISTINCT FROM OLD.signature
      OR NEW.nonce IS DISTINCT FROM OLD.nonce
      OR NEW.deadline IS DISTINCT FROM OLD.deadline
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
      RAISE EXCEPTION 'custody_events is append-only: immutable columns cannot be modified';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_custody_events_append_only
BEFORE UPDATE OR DELETE ON custody_events
FOR EACH ROW
EXECUTE FUNCTION prevent_custody_event_mutation();
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_organizations ON organizations FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_members ON members FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE siwe_nonces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_siwe_nonces ON siwe_nonces FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_batches ON batches FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE custody_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_custody_events ON custody_events FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE evidence_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_evidence_files ON evidence_files FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE intents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_intents ON intents FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE chain_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_chain_jobs ON chain_jobs FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_idempotency_records ON idempotency_records FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY deny_all_audit_log ON audit_log FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
