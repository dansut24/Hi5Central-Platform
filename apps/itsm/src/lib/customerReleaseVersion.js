/** Customer-facing release identifiers are published by Hi5Central, NEVER
 * derived from a Git commit, Docker image, or frontend build manifest.
 * Build SHAs remain internal correlation keys for deployments and rollback.
 */
const SHA=/^[0-9a-f]{7,40}$/i
export function publishedCustomerVersion(value){
 const label=String(value||'').trim().replace(/\+[a-f0-9]{8,40}$/i,'')
 if(!label||SHA.test(label)||/^(?:sha-|build\s+|commit\s+)/i.test(label))
  return null
 return label
}
export function customerVersionForBuild(sha,releases){
 if(!/^[0-9a-f]{40}$/i.test(String(sha||'')))return null
 if(!Array.isArray(releases))return null
 const match=releases.find(item=>item?.buildSha===sha)
 return publishedCustomerVersion(match?.versionLabel)
}
export function customerVersionOrUnpublished(sha,releases){
 return customerVersionForBuild(sha,releases)||'Version not published'
}
