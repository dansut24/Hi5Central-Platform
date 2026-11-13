# Hi5Central Mobile v0.6.1 — Default Service Catalogue compatibility

Branch: `fix/ios-v061-service-catalogue-lookups-20261113` (inherits full v0.6.0 combined ITSM/RMM app).
IPA artifact: Hi5CentralMobile-iOS-v0.6.1-service-requests-lookup-fields.

## Changes
- Support `section` catalogue fields (headings/help), without falsely marking them as unhandled.
- Support `lookup` to the existing authenticated organisation directory for people, departments, sites and teams. Use external keys as request form values, as the web catalogue expects.
- Fetch departments/sites in the existing tenant-scoped `/api/v1/organisation` API and clear them with all other tenant data on logout.
- Block submission of unhandled lookup types or missing required directory options rather than submitting invalid Service Requests.
- Retain v0.6.0 Face ID grace periods, activities, fulfilment, attachment transfers and native RMM viewer unchanged.

## Acceptance test
1. Sign in to a company with published Default Catalogue v2 forms and populated People/Departments/Sites.
2. Open Service Requests > New Starter, select Department, Manager and Site lookups, complete conditional fields.
3. Submit; confirm correct request and fulfilment flow on web, portal and iOS.
4. Test empty required lookups, wrong tenant, logout and subsequent login; no old organisation options may persist.
5. Retest RMM native viewer, Face ID timeout and separate ITSM/RMM selection.

A green unsigned IPA verifies compilation, not runtime service request submission or approval outcomes.
