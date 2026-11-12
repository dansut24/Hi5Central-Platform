# Hi5Central ITSM — native iPhone and iPad app

Version 0.1.0 · staff workspace · initial unsigned IPA prototype.

## Architecture
- Separate app, separate bundle ID `com.hi5central.itsm`, not a page inside the RMM app.
- SwiftUI + Swift Charts on iOS 16+, XcodeGen, self-contained unsigned IPA GitHub Actions.
- Reuses the official Hi5Central logo binary from the same Git repository.
- Existing HTTPS API at `api.hi5central.com`, with the required `Origin: https://{tenant}.hi5central.com` and the existing tenant-bound session cookies.
- MFA: `/api/v1/auth/login-secure`, `/api/v1/auth/mfa/setup`, `/api/v1/auth/mfa/verify` + session validation.
- Staff only; requester accounts are correctly rejected. Separate requester Portal application can follow.
- No passwords, recovery codes, OTPs, shell transcripts or API tokens are saved as app preferences.
- No new server-side services, VPS routes or changes to the working RMM native viewer.

## First functional screens
1. Native splash, login, authenticator/recovery MFA and logout.
2. Dashboard from real /api/v1/itsm/reports/summary with type, priority and 30-day chart data. Explicit empty state if reports permission is denied.
3. Incidents, Problems, Changes and Service Requests, with searchable list and native detail panels.
4. Generic record work notes / customer replies and non-terminal status + priority updates using existing authorised routes.
5. Tasks queue (read-only initially), Knowledge (read-only initially), in-app Notifications (mark read), global record/task/article search.
6. Light/dark/system display preference.

## Testing (do not conflate GitHub compilation with live proof)
- Install IPA using Sideloadly alongside the existing RMM app, not over it.
- Log in using a company prefix, username/password and mandatory MFA. Ensure account is a staff member on an ITSM-enabled tenant.
- Check dashboard counts against web ITSM; dashboard report access requires reports.view.
- Verify Incidents/Problems/Changes plus Service Requests load; use pull-to-refresh and global search.
- Open an Incident and post a work note, confirm it appears in web ITSM.
- Verify permission-limited accounts are denied the same operations as the website.
- Try Tasks, Knowledge, Notifications; note these are first-pass read-only workspaces.
- Test dark mode and sign-out; confirm RMM app remains unchanged.

## Known initial limits and next priorities
- Supports production tenant workspace only; Custom UAT / Test switching needs per-environment API verification before exposing.
- Approvals, Projects, Calendar, People, CMDB, incident resolution with required notes, inline assignment typeahead, rich text editor and file uploads are next.
- First-party APNs push and passkey enrolment require separate backend/device-token and Apple capability work; not claimed as operational in this IPA.
- Service Request activity is initially read-only; its lifecycle APIs differ from generic ITSM records.
- Unified deep links from ITSM device/CMDB records into the RMM app are a subsequent integration.
- Real device functional tests and regression checks are required after the unsigned IPA build.

## Recovery / continuation
- Native RMM working baseline: branch `feature/rmm-ios-v0516-native-dashboard-device-tools-search` and green Actions run `43303475212`; do not alter codecs, native viewer or Agent.
- ITSM initial build branch: `feature/itsm-ios-v010-native-staff-app`.
- If CI fails, fix only `apps/itsm-ios/**` and its dedicated workflow. No live VPS deployment is required to test a compiled ITSM IPA.
