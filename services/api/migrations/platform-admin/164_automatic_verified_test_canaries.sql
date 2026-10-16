-- A real release can advance automatically after two previously designated
-- customer Test canaries passed, soaked, and reported host-verified success.
-- This does not select or seed any customers automatically.
CREATE TABLE IF NOT EXISTS platform_release_canary_tenants (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  CHECK (length(note)<=500)
);
CREATE INDEX IF NOT EXISTS platform_release_canary_tenants_active
 ON platform_release_canary_tenants(enabled,assigned_at)
 WHERE enabled=true;

-- A passed gate can be EITHER a staff-approved manual quality signoff OR a
-- machine-evidenced gate. Never impersonate a staff approver for automatic
-- verification. Certification requires a separate real staff approval.
ALTER TABLE platform_release_test_qa_gates
 DROP CONSTRAINT IF EXISTS platform_release_test_qa_gates_check;
ALTER TABLE platform_release_test_qa_gates
 ADD CONSTRAINT platform_release_test_qa_gates_check
 CHECK (
  state <> 'passed'
  OR (
    passed_at IS NOT NULL
    AND passed_canary_count >= 2
    AND jsonb_typeof(evidence)='object'
    AND evidence <> '{}'::jsonb
    AND (
      accepted_by IS NOT NULL
      OR (accepted_by IS NULL
          AND evidence->>'automatic'='true'
          AND evidence->>'source'='two-verified-designated-test-canaries'
          AND jsonb_typeof(evidence->'verifiedJobIds')='array'
          AND jsonb_array_length(evidence->'verifiedJobIds') >= 2)
    )
  )
);
