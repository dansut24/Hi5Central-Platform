import {createHash,timingSafeEqual} from 'node:crypto'

const DIGEST=/^[0-9a-f]{64}$/
const BEARER=/^[A-Za-z0-9_-]{48,256}$/

/** SHA-256 digests are provisioning metadata, not reusable bearer credentials.
 * Rotations allow a short dual-digest overlap while the publisher switches.
 * These hashes never authorise deployments, certifications or Admin actions.
 */
export function publicationTokenDigests(settings=process.env){
  const candidates=[settings.RELEASE_PUBLICATION_TOKEN_SHA256,
    settings.RELEASE_PUBLICATION_TOKEN_SHA256_NEXT]
  if(!DIGEST.test(String(candidates[0]||'')))
    return []
  if(candidates[1]&&!DIGEST.test(String(candidates[1])))
    return []
  return candidates.filter(Boolean)
}

export function publicationBearerAuthorised(header,settings=process.env){
  const digests=publicationTokenDigests(settings)
  if(!digests.length)return false
  if(typeof header!=='string'||!header.startsWith('Bearer '))return false
  const bearer=header.slice(7)
  if(!BEARER.test(bearer))return false
  const input=createHash('sha256').update(bearer).digest()
  let authorised=0
  for(const digest of digests){
    const expected=Buffer.from(digest,'hex')
    authorised |= Number(timingSafeEqual(input,expected))
  }
  return authorised===1
}

/** Bound at the receiving Live authority, not merely trusted from the relay.
 * A stolen QA publication token must never publish a different build.
 */
export function publicationShaAuthorised(buildSha,settings=process.env){
  const expected=String(settings.RELEASE_PUBLICATION_ALLOWED_SHA||'')
  return /^[a-f0-9]{40}$/.test(expected)
    &&typeof buildSha==='string'&&buildSha===expected
}

/**
 * Automatic Dev editorial bridge is independently gated by:
 *  - a dedicated publication-only bearer;
 *  - an authenticated developer's immutable publication_requested row;
 *  - the exact currently served Dev API SHA;
 *  - central verification of the official GitHub release candidate workflow;
 *  - matching live Dev API and frontend SHA.
 *
 * No caller-provided wildcard and no authority to execute tenant cutovers.
 */
export function automaticDevPublicationEnabled(settings=process.env){
  return settings.RELEASE_PUBLICATION_ALLOWED_SHA==='verified-dev'
    &&settings.RELEASE_PUBLICATION_AUTOMATIC==='true'
}
