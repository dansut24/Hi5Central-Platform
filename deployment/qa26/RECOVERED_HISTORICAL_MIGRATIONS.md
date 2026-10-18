# Recovered migration provenance — 18 October 2026

This changes **source control only**. It does not run SQL against Production.

The live `hi5central` PostgreSQL `schema_migrations` ledger contained 26
historically applied basename identities numbered 150–171 which were no longer
present in GitHub `main`. Their **exact original SQL bytes** were recovered
from the historical PR refs and validated against independent reviewed VPS
worktree copies where present. Every recovered filename had exactly one
content variant. The immutable source paths, PR ref and SHA-256 are in
`deployment/qa26/recovered-rollout-migration-provenance.json`.

In `services/api/src/migrate.js`, migrations are discovered recursively
and each **filename** is the global migration identity. Existing ledger
entries are skipped. The 26 restored filenames correspond exactly to the
26 existing ledger entries and therefore do **not** need reapplication on
the already-migrated Production database.

## Verification

- `node --test services/api/test/recovered-rollout-migrations.mjs`
- Checksums are exact for all 26 recovered files.
- There are no duplicate filename identities in the restored API migration tree.
- On 18 October, all source SQL filenames in this candidate branch corresponded
  to already-applied Production migration IDs: **zero pending source filenames**.
- Live ledger had 171 total entries. The restored API tree covered 166.
  The five remaining entries were created in older Node.js/Nextcloud/RMM
  deployment paths, not the platform API migration tree:
  `081_nodejs_windows_inventory_identity.sql`,
  `082_nextcloud_vendor_html_recipe.sql`,
  `083_nextcloud_exact_vulnerability_identity.sql`,
  `084_nextcloud_windows_inventory_identity.sql`, and
  `116_wayland_remote_persistence.sql`.
  Four of these have separate original host source candidates under
  `/opt/hi5central/`; the fifth was not located in the GitHub Platform
  PR history or reviewed VPS snapshots checked. These **must be reconciled
  with the appropriate RMM migration owner**, not inserted blindly into
  the platform API tree.

## Safety

Do not run the recovered SQL manually on Production: the 26 historical
migrations are **already applied**. A protected merge adds source
reproducibility; an independently restored database is required before
claiming fresh-bootstrap parity. Do not change `schema_migrations` by hand,
or reassign external RMM migration IDs to platform-admin.

PR #90 (restricted workers) is independent and must be merged and
preflighted under the global rollout pause before admitting a customer.

The migration recovery adds no production credentials or customer data.
