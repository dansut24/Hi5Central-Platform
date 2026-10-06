CREATE TABLE IF NOT EXISTS tenant_delivery_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  domain_mode text NOT NULL DEFAULT 'default'
    CHECK (domain_mode IN ('default','custom')),
  custom_workspace_domain text,
  custom_portal_domain text,
  domain_status text NOT NULL DEFAULT 'default'
    CHECK (domain_status IN ('default','pending','verified')),
  domain_verification_token text,
  smtp_mode text NOT NULL DEFAULT 'default'
    CHECK (smtp_mode IN ('default','custom')),
  smtp_host text,
  smtp_port integer,
  smtp_security text
    CHECK (smtp_security IS NULL OR smtp_security IN ('starttls','tls','plain')),
  smtp_username text,
  smtp_password_encrypted text,
  smtp_from_name text,
  smtp_from_email text,
  smtp_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_delivery_settings_domain_idx
  ON tenant_delivery_settings(custom_workspace_domain)
  WHERE custom_workspace_domain IS NOT NULL;
