// Immutable, bounded Git-history validation for UAT -> shared Production reviews.
// We can review a large release, but never silently approve an incomplete one.
export const MAX_RELEASE_HISTORY_COMMITS = 512
export const RELEASE_HISTORY_SCHEMA = 2
const SHA = /^[0-9a-f]{40}$/

export function reviewedReleaseRange(manifest, liveSha) {
  const fail = reason => ({ knownBaseline:false, changes:[], reason })
  if (!SHA.test(String(manifest?.sha || '')) || !SHA.test(String(liveSha || ''))) {
    return fail('Verified build and Production baseline SHAs are required.')
  }
  if (manifest?.schemaVersion !== RELEASE_HISTORY_SCHEMA
      || manifest?.historyComplete !== true
      || manifest?.historyLimit !== MAX_RELEASE_HISTORY_COMMITS) {
    return fail('The release manifest is missing complete, trusted Git history. Rebuild through approved CI.')
  }
  const commits = manifest?.commits
  if (!Array.isArray(commits) || !commits.length || commits.length > MAX_RELEASE_HISTORY_COMMITS
      || commits[0]?.sha !== manifest.sha) {
    return fail('Release history is missing or outside its supported, bounded window.')
  }
  const all = commits.map(item => item?.sha)
  if (all.some(sha => !SHA.test(String(sha || ''))) || new Set(all).size !== all.length) {
    return fail('Release history contains invalid or duplicate revision identifiers.')
  }
  if (manifest.sha === liveSha) return {knownBaseline:true,changes:[],reason:'',baselineSha:liveSha}
  const baselineIndex = all.indexOf(liveSha)
  if (baselineIndex < 0) {
    return fail('Production baseline is outside the complete review history. Build a smaller release or extend the reviewed history window; approval is blocked.')
  }
  return {knownBaseline:true,changes:commits.slice(0,baselineIndex),reason:'',baselineSha:liveSha}
}

export function completeReleaseSelection(changes, selected) {
  if (!Array.isArray(changes) || !Array.isArray(selected)
      || changes.length > MAX_RELEASE_HISTORY_COMMITS
      || selected.length !== changes.length) return false
  const expected = changes.map(change => change?.sha)
  if (expected.some(sha => !SHA.test(String(sha || '')))
      || new Set(expected).size !== expected.length
      || selected.some(sha => !SHA.test(String(sha || '')))
      || new Set(selected).size !== selected.length) return false
  const accepted = new Set(selected)
  return expected.every(sha => accepted.has(sha))
}
