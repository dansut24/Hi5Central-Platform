# Hi5Central Mobile v0.6.0 — Face ID timeout + Service Requests

Branch: feature/hi5central-ios-v060-lock-grace-service-requests
IPA artifact: Hi5CentralMobile-iOS-v0.6.0-service-requests-faceid-timeout
Combined app ID: com.hi5central.mobile. Updates v0.5 without replacing standalone apps.

## Face ID grace
- Per-company settings under More > Privacy & notifications.
- Unlock after Immediately (default), 1, 5, 15 or 30 minutes *away from the app*.
- If back in the app before timeout, previous unlocked session is retained.
- On cold launch/restart with a valid server session, unlock required (fail closed).
- Remote viewing closes whenever a protected app is backgrounded, even during grace.
- Server MFA, session expiry and permissions are unchanged; this is local privacy unlock, not passkey authentication.
- Test immediate, 1-minute grace and crossing the threshold, force quit/relaunch and switching tenants.

## Native Service Requests
- Existing Records already includes Service Request records alongside Incident/Problem/Change.
- New Service Request via Records (+) > New Service Request or More > Service Request catalogue.
- Catalogue is queried from authenticated /api/v1/catalogue and filters to active visible request forms with Service Request type.
- Native dynamic form: text, textarea, number, email, date, checkbox, select/dropdown/radio, product and checkbox product selection. Conditional showWhen, required fields and standard priority. Unsupported forms fail safely rather than blindly submitting.
- Creation uses /api/v1/service-requests with catalogueItemId/fields/details/urgency; backend enforces pricing and approval plans.
- Service Request detail supports internal notes and customer-visible replies; approvals remain visible with existing decision UI.
- Native fulfilment transitions via /transition with completion notes and reopen reason, preserving server rules.
- Assignment/priority updates, fulfilment task start/complete with notes via dedicated endpoints.
- Attachment upload (base64 JSON; 6 MB app cap, server policy may be lower) and authorised download/share.
- Existing ITSM-to-RMM device picker and native viewer retained.
- Server routes verified in services/api/src/serviceRequestOperations.js, serviceRequests.js and catalogue.js. No VPS or Agent changes.

## QA on iPhone
1. Install via Sideloadly; sign in to combined tenant.
2. More > Privacy & notifications: enable Face ID and choose 5 minutes; background 1 minute, then 6 minutes, check lock behaviour.
3. Records > + > New Service Request: choose form, complete required fields and submit. Confirm reference.
4. Open request: customer and internal comments, pending approvals, SLA, tasks, start/complete fulfilment, attachments, completion/reopen.
5. Try unsupported form fields and permission-restricted user; app must show errors, not fabricate success.
6. Re-test native Lenovo RMM session, keyboard, codec and ITSM-only/RMM-only navigation.

A green IPA build confirms compile/package, not live API behaviour. Apple APNs background push and passkey login remain separate work.
