# Hi5Central Mobile v0.6.2 — native Service Catalogue forms

Base: v0.6.1 Service Request lookups, Face ID grace periods, native RMM viewer and ITSM workflows unchanged.

## Live schema audit (companycustom, 13 Nov 2026)
- select 25
- textarea 18
- lookup 17 (people/departments/sites/teams)
- text 14
- section 14
- date 10
- datetime-local 1
- multiselect 1

All eight live field types have corresponding native controls. Section markers now render real SwiftUI Form sections with heading/help. Date fields use the native date picker; the Leaver / Account Closure datetime-local field uses the native date + time picker, submitted in local HTML form format YYYY-MM-DDTHH:mm. Optional dates remain empty unless explicitly chosen. Picker values no longer display a duplicate field label. Required/conditional validation and unknown-type safe blocking remain in place. The composer refreshes tenant-scoped People/Department/Site options on open.

## QA
1. Install the unsigned Hi5CentralMobile-iOS-v0.6.2-service-catalogue-native-forms IPA with Sideloadly.
2. Sign in to `companycustom`. Open Service Requests > General IT Request; no unsupported section warnings or duplicate picker titles.
3. Test New Starter sections, required Department/Site/Manager lookups (these lists are currently unconfigured in companycustom: add via ITSM before full submission testing), and conditional "Copy access" / "Equipment" choices.
4. Test Leaver / Account Closure: specific-date-and-time choice; verify stored `YYYY-MM-DDTHH:mm` value and conditional fields.
5. Test Requests submitted to web ITSM with approvals, assignments, fulfilment tasks and close, including clearing a date and hiding conditional fields.
6. Confirm Face ID grace, navigation and RMM viewer remain functional.

Note: CI compilation does not establish a real submitted/approved request. No VPS, database, Agent, codec or release-worker changes in this commit.
