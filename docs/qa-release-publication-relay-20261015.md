# Publication relay — security and rollout reference

**Credential provisioning instructions in earlier versions of this note are superseded.**
Do **not** mount the existing broad `RELEASE_OPERATOR_TOKEN` or copy existing
Dev application database credentials from a running container.

The current reviewed workflow is:
[QA release-relay credential handover](qa-release-relay-credential-handover-20261015.md).

It requires a new `hi5_release_publisher` Dev database account with column-limited
permissions and a newly generated, independent publication-only bearer. The
central Live API must first deploy the dedicated `RELEASE_PUBLICATION_TOKEN_SHA256`
authentication code from this PR, without replacing unrelated Live services.

The Dev user has already requested publication of build
`9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0`. The separate authenticated
relay submits only that existing request and verifies central readback before
updating the Dev status. It **never** certifies GitHub releases, alters Live
tenant routes or unpauses the rollout. Follow the precise gates in the linked
administrator handover.
