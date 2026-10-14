# QA26 login-scrolling CSS-only image

This Dockerfile derives **exactly** the pinned QA26 frontend `sha-f51d2e634e450e03214f10d845f90f73f7b2d506`. It validates **all three original hashes** (index HTML, JS bundle and CSS bundle) before creating a new uniquely named CSS bundle with the canonical auth viewport appended. It changes only the CSS asset reference in the HTML. No API, authentication, billing, database or JS changes.

`docker build -f deploy/qa26-mobile-scroll/Dockerfile -t hi5central-qa26-mobile-scroll:<reviewed-sha> .`

**Isolated validation before rollout:** launch under a new container name on the existing QA network, check `/healthz`, `index.html` asset reference, CSS `text/css` response, JS checksum unchanged, runtime-config/API endpoint and WebKit mobile-scroll regression tests. Do not publish ports or update gateway during staging.

**Rollout scope:** Only the two QA26 tenant frontend root/login routes currently served by the dedicated QA26 container `hi5central-qa-email-f51d2e63-web`. The `/settings/subscription` paths and `-admin` domain routes use separate candidates and must not be touched. Before replacing any running container, record original `docker inspect` configuration and check gateway matchers are **only** `h5c-managed-qa26.hi5central.com` and `h5c-custom-qa26.hi5central.com`; ensure there are no other consumers. Stop/replace only during an approved QA deployment window; preserve old image/container for rollback. After rollout, check anonymous QA login, full scroll by iPhone Safari including keyboard and bottom buttons, MFA/reset, other QA pages and correct new CSS hash.

**Caution:** This overlay is strictly for a pinned QA image. Generic main images now include PR #66. New feature builds use the single canonical viewport CSS in PR #67. No real payments are enabled. The unrelated customer `-admin` origin mismatch is not fixed by this CSS-only image.
