CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_member_id" uuid,
	"actor_wallet" text,
	"actor_role" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"batch_ref" text NOT NULL,
	"on_chain_batch_id" text NOT NULL,
	"waste_code" text NOT NULL,
	"waste_name" text NOT NULL,
	"waste_category" text,
	"status" text DEFAULT 'PENDING_CHAIN' NOT NULL,
	"generator_org_id" uuid NOT NULL,
	"current_custodian_org_id" uuid,
	"declared_weight_grams" text,
	"latest_event_seq" integer DEFAULT 0 NOT NULL,
	"latest_event_hash" text NOT NULL,
	"has_discrepancy" boolean DEFAULT false NOT NULL,
	"max_discrepancy_severity" text DEFAULT 'none' NOT NULL,
	"festronik_ref" text,
	"monija_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "batches_batch_ref_unique" UNIQUE("batch_ref"),
	CONSTRAINT "batches_on_chain_batch_id_unique" UNIQUE("on_chain_batch_id")
);
--> statement-breakpoint
CREATE TABLE "chain_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_type" text DEFAULT 'ANCHOR_EVENT' NOT NULL,
	"batch_id" uuid,
	"event_id" uuid,
	"member_id" uuid,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"tx_hash" text,
	"last_error" text,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custody_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"intent_id" uuid,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_member_id" uuid NOT NULL,
	"actor_wallet" text NOT NULL,
	"actor_org_id" uuid NOT NULL,
	"from_org_id" uuid,
	"to_org_id" uuid,
	"target_seq" integer,
	"reason_code" text,
	"quantity_grams" text,
	"quantity_unit" text,
	"record" jsonb NOT NULL,
	"event_hash" text NOT NULL,
	"prev_event_hash" text NOT NULL,
	"signature" text NOT NULL,
	"nonce" text NOT NULL,
	"deadline" text NOT NULL,
	"chain_status" text DEFAULT 'PENDING' NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"anchored_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid,
	"event_id" uuid,
	"uploaded_by_member_id" uuid NOT NULL,
	"uploaded_by_org_id" uuid NOT NULL,
	"storage_driver" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"label" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"scope" text NOT NULL,
	"actor_member_id" uuid,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_member_id" uuid NOT NULL,
	"actor_org_id" uuid NOT NULL,
	"actor_wallet" text NOT NULL,
	"waste_code" text NOT NULL,
	"waste_name" text,
	"batch_ref" text,
	"record" jsonb NOT NULL,
	"typed_data" jsonb NOT NULL,
	"event_hash" text NOT NULL,
	"prev_event_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"deadline" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"wallet_address" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"on_chain_tx_hash" text,
	"on_chain_registered_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"org_type" text NOT NULL,
	"code" text NOT NULL,
	"on_chain_org_id" text NOT NULL,
	"estate" text,
	"klhk_permit_no" text,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_code_unique" UNIQUE("code"),
	CONSTRAINT "organizations_on_chain_org_id_unique" UNIQUE("on_chain_org_id")
);
--> statement-breakpoint
CREATE TABLE "siwe_nonces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nonce" text NOT NULL,
	"wallet_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "siwe_nonces_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_generator_org_id_organizations_id_fk" FOREIGN KEY ("generator_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_current_custodian_org_id_organizations_id_fk" FOREIGN KEY ("current_custodian_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_jobs" ADD CONSTRAINT "chain_jobs_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_jobs" ADD CONSTRAINT "chain_jobs_event_id_custody_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."custody_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_jobs" ADD CONSTRAINT "chain_jobs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_actor_org_id_organizations_id_fk" FOREIGN KEY ("actor_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_from_org_id_organizations_id_fk" FOREIGN KEY ("from_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_to_org_id_organizations_id_fk" FOREIGN KEY ("to_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_event_id_custody_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."custody_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_uploaded_by_member_id_members_id_fk" FOREIGN KEY ("uploaded_by_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_uploaded_by_org_id_organizations_id_fk" FOREIGN KEY ("uploaded_by_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_actor_org_id_organizations_id_fk" FOREIGN KEY ("actor_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "batches_generator_org_idx" ON "batches" USING btree ("generator_org_id");--> statement-breakpoint
CREATE INDEX "batches_custodian_org_idx" ON "batches" USING btree ("current_custodian_org_id");--> statement-breakpoint
CREATE INDEX "batches_status_idx" ON "batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "batches_waste_code_idx" ON "batches" USING btree ("waste_code");--> statement-breakpoint
CREATE INDEX "chain_jobs_status_next_run_idx" ON "chain_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "chain_jobs_batch_id_idx" ON "chain_jobs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "chain_jobs_event_id_idx" ON "chain_jobs" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "custody_events_batch_id_idx" ON "custody_events" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "custody_events_chain_status_idx" ON "custody_events" USING btree ("chain_status");--> statement-breakpoint
CREATE INDEX "custody_events_event_hash_idx" ON "custody_events" USING btree ("event_hash");--> statement-breakpoint
CREATE INDEX "evidence_files_batch_id_idx" ON "evidence_files" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "evidence_files_event_id_idx" ON "evidence_files" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "evidence_files_sha256_idx" ON "evidence_files" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_scope_key_uniq" ON "idempotency_records" USING btree ("scope","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "intents_batch_id_idx" ON "intents" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "intents_actor_member_id_idx" ON "intents" USING btree ("actor_member_id");--> statement-breakpoint
CREATE INDEX "intents_status_idx" ON "intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "intents_expires_at_idx" ON "intents" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "members_org_id_idx" ON "members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "members_role_idx" ON "members" USING btree ("role");--> statement-breakpoint
CREATE INDEX "members_status_idx" ON "members" USING btree ("status");--> statement-breakpoint
CREATE INDEX "siwe_nonces_expires_at_idx" ON "siwe_nonces" USING btree ("expires_at");