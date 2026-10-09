# Public wildcard routing fix — 9 October 2026

## Incident and root cause

The live public `hi5central-web` gateway uses Caddy v2.11.4 with a
`*.hi5central.com` virtual host. Explicit Dev, legacy Test/UAT, Help
and recordlab routes are handled first, but an unmatched hostname used to
fall through to `hi5central-prod-itsm:80`. This served Production ITSM
HTML under unapproved `pilot-uat-api.hi5central.com`,
`pilotexampleuat.hi5central.com` and similar UAT/Test suffix hosts.

The wildcard TLS certificate and DNS wildcard were **not** proof that any
customer pilot had been authorised. A follow-up test also found:
- Mixed-case Host values bypassed a case-sensitive version of the deny rule.
- Trailing-dot Host values did not select Caddy's wildcard virtual host at
  all, returning an empty HTTP 200 unless an explicit unmatched-host
  HTTPS fallback existed.

## Active remediation

The persistent public gateway file on the VPS is:
`/opt/hi5central/deployment/Caddyfile`. It is mounted read-only inside
`hi5central-web` at `/etc/caddy/Caddyfile`. This is **not** the
generic self-host `Caddyfile` from the separate deploy repository.

Two independent configuration changes were validated and applied:

1. At the **start of the existing wildcard HTTPS virtual host**,
   `public-ingress-deny.caddy` adds a case-insensitive CEL expression
   and a `handle @unapprovedSandbox { respond 404 }` block. It reserves
   customer-qualified `*uat`, `*test` and `pilot-*` hosts, including
   Portal/RMM/API alternatives. Use `handle`; a top-level
   `respond @unapprovedSandbox` is sorted after the other handlers by
   this Caddyfile adapter and does not protect the fallback.
2. At the **top-level of the Caddyfile**,
   `public-ingress-unknown-host.caddy` adds
   `https://:443 { respond "Misdirected Request" 421 }`. This
   explicit hostless HTTPS handler protects requests for which the
   wildcard virtual host is **not** selected (including trailing dots).
   It does not use `tls internal` or replace existing certificate issuers.

These fragments are reference source; they are **not** separately imported
by the existing public ingress. Any future gateway update must merge both
into the effective persistent file and repeat validation.

## Verification

- The full live config passed Caddy `adapt` and `validate` using the
  running Caddy executable and DNS provider plugin.
- Isolated Caddy smoke tests validated 404 routing before tenant and
  RMM/Portal fallbacks, preserving known hosts.
- A separate isolated HTTPS test proved 421 fallback for trailing-dot
  requests without affecting legacy virtual hosts.
- **49/49 live HTTPS checks passed** after the final reload, including
  existing Production, Dev, legacy Test/UAT, test2, mixed-case host
  headers, trailing-dot host headers, plain API and RMM-viewer paths.
- The existing read-only `public-route-audit.mjs` reported **zero
  policy findings** against the fixed public DNS/TLS endpoints. Its
  `approvalAllowed=false` result is intentional and must remain so.
- All tested Production, Dev, legacy Test/UAT containers remained
  healthy. No production application image/database, customer account,
  pilot application container, pilot network attachment or DNS record
  was changed. Only the public Caddy configuration was reloaded.

## Backup and rollback

The **original pre-incident** configuration was saved under the host's
`/opt/hi5central/deployment/` directory as:

`Caddyfile.pre-phase13-20261009T224240Z`

The previous working (case-sensitive) version was separately backed up as:

`Caddyfile.pre-phase13-complete-20261009T224913Z`

Both have mode 0600. They are deliberately retained.

On the authorised VPS Docker host, only after approving rollback, restore
the original content **in-place** and reload (do not rename the bind-mounted
file over the old inode):

```sh
docker run --rm --pull never \
  -v /opt/hi5central/deployment:/ingress:rw \
  --entrypoint sh caddy:2-alpine -ec \
  'cat /ingress/Caddyfile.pre-phase13-20261009T224240Z > /ingress/Caddyfile'

docker exec hi5central-web caddy reload \
  --config /etc/caddy/Caddyfile --adapter caddyfile
```

That rollback **reintroduces the unapproved hostname issue** and is only
for emergencies with a new corrective change and verification.

Avoid editing Production to activate customer routes without independent
infrastructure approval. The two prepared pilot Docker edges remain empty.
The public 404/421 fix removes one blocker, but dedicated runtime
attestation, outbound email controls, browser MFA/isolation and approved
DNS/TLS pilot routing are still outstanding.
