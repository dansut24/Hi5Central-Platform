// The running software version is a platform-wide deployment, not a tenant
// feature flag. Host operator observations are authoritative only while fresh.
export const APPLICATION_OBSERVATION_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const APPLICATION_SHA_PATTERN = /^[a-f0-9]{40}$/
const DEPLOYMENT_ENVIRONMENTS = ['dev','test','uat','live']

export function normaliseDeploymentRow(row, now = new Date()) {
  if (!row) return { status:'unknown', apiSha:null, itsmSha:null, observedAt:null, verified:false, reason:'No host deployment report has been received.' }
  const age = now.getTime() - new Date(row.observed_at).getTime()
  const valid = row.status === 'verified'
    && APPLICATION_SHA_PATTERN.test(String(row.api_sha || ''))
    && APPLICATION_SHA_PATTERN.test(String(row.itsm_sha || ''))
  const fresh = Number.isFinite(age) && age >= 0 && age <= APPLICATION_OBSERVATION_MAX_AGE_MS
  return {
    status: !valid ? String(row.status || 'unknown') : fresh ? 'verified' : 'stale',
    apiSha:row.api_sha || null,
    itsmSha:row.itsm_sha || null,
    releaseRef:row.release_ref || '',
    observedAt:row.observed_at || null,
    verified:valid && fresh,
    reason:!valid ? 'The host has not verified this deployment.' : !fresh ? 'Deployment verification is stale; the operator must recheck the running containers.' : '',
  }
}

export async function applicationDeployments(database, now = new Date()) {
  const result = await database.query(`SELECT environment,status,api_sha,itsm_sha,release_ref,detail,observed_at
    FROM platform_application_deployment_attestations`)
  const rows = new Map(result.rows.map(row => [row.environment, row]))
  return Object.fromEntries(DEPLOYMENT_ENVIRONMENTS.map(name => [name,normaliseDeploymentRow(rows.get(name),now)]))
}

function describeVersion(sha) { return String(sha || '').slice(0,8) || 'unknown' }

export function applicationReadyForPromotion({ uat, live, testedApiSha, testedItsmSha }) {
  if (!APPLICATION_SHA_PATTERN.test(String(testedApiSha || ''))
      || !APPLICATION_SHA_PATTERN.test(String(testedItsmSha || ''))) {
    return { ready:false, reason:'UAT approval does not have a verified application revision. Re-test and approve in UAT.' }
  }
  if (!uat?.verified || !live?.verified) {
    return { ready:false, reason:'Application deployment verification is missing or stale. Run the host deployment operator first.' }
  }
  if (uat.apiSha !== testedApiSha || uat.itsmSha !== testedItsmSha) {
    return { ready:false, reason:'The UAT application changed after acceptance. Repeat UAT testing before promotion.' }
  }
  if (live.apiSha !== testedApiSha || live.itsmSha !== testedItsmSha) {
    return { ready:false, reason:`Production application is ${describeVersion(live.apiSha)}/${describeVersion(live.itsmSha)}; approved UAT is ${describeVersion(testedApiSha)}/${describeVersion(testedItsmSha)}. Deploy the approved API and ITSM images through Platform Admin first.` }
  }
  return { ready:true, reason:'' }
}
