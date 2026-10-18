/** Optional, exact SHA40 pin for a QA-only release planner.
 *
 * Unset retains existing generic behaviour. A configured empty, shortened or
 * malformed value always fails closed before PostgreSQL or scheduling starts.
 */
export function parsePinnedQaReleaseSha(raw) {
  if (raw === undefined) return null
  if (typeof raw !== 'string' || !/^[a-f0-9]{40}$/.test(raw))
    throw new Error('RELEASE_QA_BUILD_SHA must be one exact lowercase SHA40.')
  return raw
}
