# Multiple tenant signup with one email identity

- `users.email` remains globally unique and unchanged.
- An existing identity can create a separate new organisation by providing its **existing Hi5Central password** and verifying the new organisation-specific email link.
- New identities continue to use the existing password/email verification flow.
- A second signup creates a new tenant, tenant membership, tenant settings and verification token, but never mutates an existing user's name, ID, password hash, or other tenant membership.
- Invalid existing password returns 401. Duplicate tenant slug still returns 409. A FOR UPDATE identity lock prevents races with changes to the identity during membership creation.
- The frontend password field should explain: **If you already have a Hi5Central account, enter your existing password.** The same password is used across tenant workspaces; tenant switching and multi-org UX can be added later.
- This is separate from email aliases; it works with the exact same email address.
- CI test uses a fresh ephemeral Postgres/Redis and dummy SMTP endpoint. It asserts 1 user, 2 tenant memberships, 2 verification tokens, incorrect-password rejection and no original user-data modification.
- No Production database migrations or unique constraint removal required.
- **Do not deploy without passing CI and a reviewed Production image promotion.** This branch does not directly update the live Production API.
