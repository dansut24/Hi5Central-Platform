# Hi5Central Mobile v0.4.0 — native record workflows

Branch: feature/hi5central-ios-v040-native-workflows
IPA artifact: Hi5CentralMobile-iOS-v0.4.0-native-workflows

- Combined navigation, home, activity, native viewer and RMM integrations from v0.3 retained.
- Incidents, Problems and Changes: new Resolve / Close / Reopen lifecycle panel, mandatory internal outcome note, server-side permission checks and failure feedback.
- Activity timeline filters: All, Internal, Customer. Native composer supports internal notes and customer replies with a 20,000-character limit.
- Existing assignments, priority, edits, SLA, Service Request approvals and task navigation preserved.
- Backend currently exposes attachment metadata but NOT verified authenticated download/upload endpoints: attachments are read-only.
- Service Request discussion still requires a dedicated API; no fake write controls.
- Notes and status transitions are separate requests, not atomic.
- A green GitHub IPA build verifies Swift compilation/package only, not real-device function.

Test: Install via Sideloadly; open incident, filter/post notes, resolve with reason, close, reopen; check restricted permissions, Service Request flow, Lenovo native remote viewer, MFA and cross-tenant isolation.
