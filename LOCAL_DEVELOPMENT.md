# Hi5Central local development

This is the default development loop for the consolidated Hi5Central platform. It does not deploy to the VPS and it does not require a GitHub Actions run.

## Requirements

- Windows 11
- Docker Desktop with Docker Compose v2
- Git
- PowerShell
- The develop branch of Hi5Central-Platform

Run the local scripts from Windows PowerShell, not from the WSL shell. Docker Desktop already exposes Docker Compose correctly to Windows, while a WSL distro can have a separate or missing Compose plugin.

## First start

Clone the repository and switch to develop, then run:

    git clone https://github.com/dansut24/Hi5Central-Platform.git
    cd Hi5Central-Platform
    git checkout develop
    .\scripts\start-dev.ps1

The start script creates .env.local automatically, detects the PC LAN IPv4 address, starts the containers, runs all database migrations, and prints the URLs to use.

Default ports:

| Surface | Port |
| --- | ---: |
| ITSM / requester portal | 3000 |
| API / WebSockets | 3001 |
| RMM | 3002 |
| Platform Admin | 3003 |
| Mailpit local mailbox | 8025 |

The web applications and API run directly from the checked-out source. Vite hot reload is enabled for the frontends and the API uses Node watch mode.

## Account setup and email

The local stack runs in managed/full-feature development mode with a single local tenant. SMTP is redirected to Mailpit.

Create an account normally in the UI. Open the Mailpit URL printed by start-dev.ps1 to see the verification email and follow the verification link. No local-development email is delivered to the public internet.

## iPhone testing

Connect the iPhone to the same Wi-Fi as the development PC and open the LAN URL printed by the start script, for example:

    http://192.168.1.50:3000

RMM, Admin, API and Mailpit use the same IP with their respective ports.

If the page is reachable on the PC but not the iPhone, allow the Hi5Central development ports through Windows Defender Firewall for the Private network profile. Do not expose these development ports to a Public network.

## Daily workflow

Start:

    .\scripts\start-dev.ps1

Status and API logs:

    .\scripts\status-dev.ps1

Run the local platform smoke test:

    .\scripts\test-dev.ps1

This checks PostgreSQL/Redis through the API health endpoint plus ITSM, RMM, Admin, deployment configuration and the local Mailpit mailbox.

Stop while preserving the database:

    .\scripts\stop-dev.ps1

Reset all local data and recreate a clean installation:

    .\scripts\reset-dev.ps1

The reset command deletes local PostgreSQL, Redis and dependency volumes only. It does not touch Git or the VPS.

## Background workers

BACKGROUND_WORKERS_ENABLED=false is the local default. This keeps normal UI/API development light and prevents scheduled vulnerability/vendor/network jobs from running unnecessarily.

Set it to true in .env.local when explicitly testing those schedulers, then restart the stack.

## Release flow

1. Develop and test locally.
2. Commit to develop when the change is ready.
3. Normal pushes to develop do not run GitHub Actions. Run workflows manually when a native artifact or Dev container set is actually required; PRs still validate affected components.
4. Promote the tested commit to the self-host distribution.
5. Validate the self-host package on the IONOS VPS before release.

The existing VPS remains untouched while local parity is established.
