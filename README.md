# Hi5Central Platform

Unified source repository for the Hi5Central managed platform.

- `apps/itsm` — ITSM workspace and requester portal
- `apps/rmm` — RMM workspace
- `apps/admin` — Platform Admin
- `services/api` — Control Server / API

Git flow:
- `develop` deploys to the **Dev** GitHub Environment and `dev*.hi5central.com`.
- `main` deploys to the **Production** GitHub Environment and `hi5central.com`.

Native Agent, Viewer, App Portal, qualification runner, and the self-host deployment distribution remain separately versioned repositories/artifacts.
