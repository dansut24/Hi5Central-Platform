# Endpoint Management removal and Hi5Central Local Admin retirement

Date: 14 November 2026. Scope: original VPS and Newtest. Feature branch: `feature/endpoint-setting-exceptions-20261114`.

## Three separate setting operations

- **Exclude:** disables this setting's enforcement for a specific target, but does **not** reset whatever Windows currently has. Expiry causes review/re-evaluation rather than immediate disruptive change.
- **Override:** sets a different effective value for a device, group, or assigned user, with risk acknowledgment and expiry for unsafe overrides.
- **Remove:** withdraws a setting from a configuration profile, or archives the whole profile and its active exceptions. The profile history and exceptions audit remain. It does **not** assume that a device was restored.

### Verified device restoration

A previously applied supported setting (currently `windows.filesystem.long_paths_enabled`) must be restored to its captured original Windows value through the separate `Restore original` operation before the setting, profile, or assignment can be withdrawn.

The API checks completed `endpoint_management` apply/restore jobs by profile, device, and setting; a later apply invalidates an earlier restore, and only a **verified** restore removes the guard. Claimed apply jobs block removal because they may still modify Windows. An interrupted or failed restore does not count as success. A truncated audit history blocks removal rather than guessing.

Other Windows ADMX and native Windows LAPS catalogue settings remain audit/preview-only until an actual write-and-restore adapter exists. No request to remove an ADMX profile resets Microsoft-managed Group Policy or Intune settings. Native Windows LAPS is separate from Hi5Central's dedicated local-admin vault.

Profile deletion is a **soft archive** with `archived_at`, a revocation of live setting exceptions, cancellation of queued endpoint policy jobs and a `profile.removed` history entry containing the operator reason. Removed names become available for reuse. Confirmation requires typing the exact profile name and a meaningful reason.

## Hi5Central Local Administrator Vault removal

1. **Stop managing / Resume:** changes only the Hi5Central management state. Password rotation is paused, but the Windows `Hi5Recovery` account, current encrypted password and audit trail are preserved. A separate reason and `rmm.security.local_admin.rotate` permission are required; the existing vault reveal permission remains distinct.
2. **Remove registration:** allowed only when there is no active SID, current rotation or encrypted credential. This retires an unused registration without modifying Windows. It is auditable and reversible by registering a fresh dedicated account.
3. **Remove Windows account & vault:** requires online Windows Agent 1.0.510+, a typed `REMOVE Hi5Recovery` confirmation, reason, RBAC and tenant session. The server sends a dedicated typed `laps.remove` job containing account ID/name and the *registered* SID—**never the password**. The native agent checks its SID, refuses built-in Administrator/domain controllers/native LAPS conflicts, deletes only that matched account via `NetUserDel`, then independently verifies the account is absent by SID lookup. Only a successful verified Agent result lets the server retire ciphertext, mark the account `removed` and append a detailed audit entry.
4. **Unconfirmed deletion:** if the Agent disconnects, removal times out, or a verification check fails, the vault enters `removal_uncertain` rather than deleting secrets or automatically replaying the delete job. A technician must check the device SID and reconcile manually. Canceled jobs not claimed by the Agent safely restore the previous paused/active state.
5. Historical rotations/audit remain accessible as nonsecret metadata. Removed ciphertext cannot be revealed. A new registration can later be created on the same device; it never reuses the previous password.

The operation is restricted to Newtest until Windows-Agent 1.0.510 is built and installed and actual removal is approved/tested. **The active Hi5Recovery account tested with two successful rotations is not removed by deploying this feature.**

## Deployment / rollback

Migration `119_endpoint_policy_and_laps_removal.sql` was tested transactionally, then applied individually (not via full migration runner) on the original VPS. Backup before migration: `/opt/hi5central/runtime/backups/endpoint-removal-20261114/endpoint-and-vault-pre-removal.dump` plus Compose snapshot; do not share recovery secret material or the vault master key.

API/web are additive to existing RMM, policy profiles and self-service broker. Keep `app_portal.uninstall` excluded from generic Agent job claiming; do not change the broker's independent install/uninstall handling. For LAPS Windows delete, build the matching 1.0.510 Agent from GitHub Actions before offering the destructive action; do not use generic PowerShell to remove privileged local accounts.

### Test sequence

1. Confirm existing Newtest Hi5Recovery is `active`, Agent 1.0.509 connected and vaulted password still works **before** any new Agent upgrade.
2. Create a disposable *draft* endpoint profile, add/remove a setting, and archive the profile; verify it disappears from active profiles but has a `profile.removed` history record.
3. Apply/restore Win32 long-path setting on a specifically authorised test device. Confirm profile removal is blocked after apply and allowed only after verified restoration. Do not modify firewall, SMB, native Windows LAPS or built-in Administrator.
4. Test **Stop managing** while preserving the Windows local admin account and encrypted credential, then **Resume management**. There is no password rotation from these state changes.
5. Upgrade the Newtest Windows Agent to 1.0.510 through the SHA-256-verified established path.
6. Test **Remove Windows account & vault** only when the operator chooses to decommission the working recovery credential, with an alternative administrator login confirmed by the operator. Verify Windows SID absent and encrypted credential retired; confirm history and audit.
7. Test wrong SID, native Windows LAPS collision, disconnection and unconfirmed-delete paths on a **disposable test account**, not the working recovery account.

Extra safety guard: requesting live Windows local-admin deletion additionally requires a checked acknowledgment confirming a separate tested administrator login; the server independently enforces the Boolean flag, not only the UI. This protects against accidentally removing the sole recovery route. No credential rotation or account removal occurs during the deployment itself.

Security: deleting the Windows account or unregistering a dedicated vault record additionally requires the separate rmm.security.local_admin.remove permission. Read-only viewing, password rotation and password reveal remain distinct capabilities. The earlier extra five-minute MFA re-verification was not reinstated.
