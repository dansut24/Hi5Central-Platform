# Hi5Central Platform

Unified source repository for the Hi5Central managed platform.

## Platform layout

- apps/itsm — ITSM workspace and requester portal
- apps/rmm — RMM workspace
- apps/admin — Platform Admin
- services/api — Control Server / API
- native/agent — Windows/macOS/Linux Agent and deployment installers
- native/viewer — Windows/macOS/Linux native Viewer
- native/app-portal — Self-Service App Portal (Avalonia/.NET)

Each component remains an independently built container, but all four containers now come from the same Git commit and are promoted together.

## Local development

Local development is the default development loop. It runs PostgreSQL, Redis, the API, ITSM/Portal, RMM, Admin and a local Mailpit mailbox on Docker Desktop without deploying to the VPS or consuming GitHub Actions minutes.

From Windows PowerShell on the develop branch:

    .\scripts\start-dev.ps1

See LOCAL_DEVELOPMENT.md for setup, iPhone/LAN testing, reset commands and the release workflow.

## Git and environment flow

- local working copy → primary development/test loop
- develop → GitHub Dev environment / CI validation when required
- main → GitHub Production environment → hi5central.com and managed tenant hostnames

A tested platform commit is promoted from develop to main; Production should not be hot-fixed independently of Dev.

## Self-hosting

The monorepo also gives self-hosted releases one coherent platform version. A release manifest can pin the API, ITSM, RMM and Admin image digests produced by one commit, preventing component version drift.

The self-host distribution remains in hi5central-deploy so customers can consume deployment tooling and published container images without requiring the managed-platform source repository.

Hi5Central-Agent, hi5central-viewer, and hi5central-app-portal have been imported into this monorepo and now build from the same platform source repository. Their native artifacts remain independently versioned and only their own workflows run when native source changes.

The Windows software qualification worker remains independently deployable.
