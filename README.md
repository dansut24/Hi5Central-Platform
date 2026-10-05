# Hi5Central Platform

Unified source repository for the Hi5Central managed platform.

## Platform layout

- `apps/itsm` — ITSM workspace and requester portal
- `apps/rmm` — RMM workspace
- `apps/admin` — Platform Admin
- `services/api` — Control Server / API

Each component remains an independently built container, but all four containers now come from the same Git commit and are promoted together.

## Git and environment flow

- `develop` → GitHub **Dev** environment → `dev*.hi5central.com`
- `main` → GitHub **Production** environment → `hi5central.com` and managed tenant hostnames

A tested platform commit is promoted from `develop` to `main`; Production should not be hot-fixed independently of Dev.

## Self-hosting

The monorepo also gives self-hosted releases one coherent platform version. A release manifest can pin the API, ITSM, RMM and Admin image digests produced by one commit, preventing component version drift.

The self-host distribution remains in `hi5central-deploy` so customers can consume deployment tooling and published container images without requiring the managed-platform source repository.

Native release repositories remain separate:

- `Hi5Central-Agent`
- `hi5central-viewer`
- `hi5central-app-portal`

The Windows software qualification worker also remains independently deployable.
