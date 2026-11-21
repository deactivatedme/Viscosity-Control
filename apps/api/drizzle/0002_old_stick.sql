CREATE TABLE "deployment_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"version" text,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"session_id" uuid,
	"health" jsonb,
	"detail" text,
	"requested_by" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"server_id" uuid NOT NULL,
	"project_id" uuid,
	"workdir" text NOT NULL,
	"compose_file" text DEFAULT 'docker-compose.yml' NOT NULL,
	"environment" text DEFAULT 'staging' NOT NULL,
	"env_enc" text,
	"build_command" jsonb,
	"health_url" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"current_release_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_samples" (
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"cpu" real NOT NULL,
	"mem_used" real NOT NULL,
	"mem_total" real NOT NULL,
	"disk_used" real NOT NULL,
	"disk_total" real NOT NULL,
	"net_rx_bps" real NOT NULL,
	"net_tx_bps" real NOT NULL,
	CONSTRAINT "metric_samples_server_id_ts_pk" PRIMARY KEY("server_id","ts")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"server_id" uuid NOT NULL,
	"path" text NOT NULL,
	"repo_full_name" text,
	"clone_url" text,
	"default_branch" text,
	"credential_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "state" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "deployment_releases" ADD CONSTRAINT "deployment_releases_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_releases" ADD CONSTRAINT "deployment_releases_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_releases" ADD CONSTRAINT "deployment_releases_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_releases_deployment_idx" ON "deployment_releases" USING btree ("deployment_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_server_idx" ON "deployments" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_server_path_idx" ON "projects" USING btree ("server_id","path");