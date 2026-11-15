-- Newtest EPM: distinguish user-selected EXE requests coming from a
-- Windows Credential UI tile from Explorer or Edge requests.
-- This column is AUDIT METADATA only; no approval or privilege is conveyed.
ALTER TABLE rmm_epm_file_requests
  ADD COLUMN IF NOT EXISTS request_source text NOT NULL DEFAULT 'explorer'
    CHECK (request_source IN ('explorer','native-uac'));
