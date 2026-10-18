-- A platform-wide Test/QA sign-off is shared by Managed and Custom release
-- stages. Managed customers NEVER receive a UAT environment or a UAT grant.
-- No QA gate is invented by migration: a validated, staff-approved gate must
-- be recorded only after real Test/canary evidence and the soak requirement.
CREATE TABLE IF NOT EXISTS platform_release_test_qa_gates (
  build_sha text PRIMARY KEY CHECK (build_sha ~ '^[a-f0-9]{40}$'),
  state text NOT NULL CHECK (state IN ('passed','failed','revoked')),
  passed_canary_count integer NOT NULL DEFAULT 0 CHECK (passed_canary_count BETWEEN 0 AND 10000),
  passed_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state <> 'passed' OR
    (passed_at IS NOT NULL AND accepted_by IS NOT NULL AND passed_canary_count>=2
     AND jsonb_typeof(evidence)='object' AND evidence <> '{}'::jsonb))
);
-- Live publication and approval continue to be separate independent gates.
-- Default state is no gate => all managed automation blocks.
