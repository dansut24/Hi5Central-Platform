/**
 * Exact, reviewed Test-only QA26 release cohort. Not a general customer
 * rollout permit. Scope by BOTH immutable job UUID and exact tenant slug.
 *
 * No credentials, queue changes, or tenant activation in this module.
 */
export const qaTestBuildSha='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
const cohort=Object.freeze([
  Object.freeze({slug:'h5c-managed-qa26',id:'2ab0c800-f01d-40f7-b1db-a624b4543b2a',
    mode:'hi5_managed',baseline:'4a363cf9054b0b3667fd450f36e354b704ec2166',
    window:'afternoon'}),
  Object.freeze({slug:'h5c-custom-qa26',id:'fb97dd79-fdbe-47ed-ac82-d2b1419f73b2',
    mode:'admin_controlled',baseline:'4a363cf9054b0b3667fd450f36e354b704ec2166',
    window:'afternoon'}),
  Object.freeze({slug:'managed1',id:'f34cfcf2-1536-4417-8779-437ce96fd1c0',
    mode:'hi5_managed',baseline:'9041ed0fc0908badfd1ceb9d638215caef5e431b',
    window:'overnight'}),
  Object.freeze({slug:'managed2',id:'ad325517-6c8d-4d36-879a-ee144de4adea',
    mode:'hi5_managed',baseline:'9041ed0fc0908badfd1ceb9d638215caef5e431b',
    window:'overnight'}),
  Object.freeze({slug:'custom1',id:'ff87e5b0-2ed5-4f0a-9f5c-015a0b433755',
    mode:'admin_controlled',baseline:'9041ed0fc0908badfd1ceb9d638215caef5e431b',
    window:'overnight'}),
  Object.freeze({slug:'custom2',id:'1e56ca13-33a4-4603-b723-9f4951120101',
    mode:'admin_controlled',baseline:'9041ed0fc0908badfd1ceb9d638215caef5e431b',
    window:'overnight'}),
])
const byId=new Map(cohort.map(entry=>[entry.id,entry]))
const bySlug=new Map(cohort.map(entry=>[entry.slug,entry]))

/** Returns a frozen, known record or throws BEFORE any DB transaction. */
export function requireQaTestJob({jobId,slug,environment,buildSha}={}){
  const e=byId.get(jobId)
  if(!e||e.slug!==slug||environment!=='test'||buildSha!==qaTestBuildSha)
    throw Object.assign(new Error('Unlisted tenant, job or environment: Test-only QA permit denied.'),
      {code:'QA_TEST_COHORT_DENIED'})
  return e
}
export function byQaTestSlug(slug){
  const e=bySlug.get(slug)
  if(!e)throw Object.assign(new Error('Tenant is outside reviewed six-Test cohort.'),
    {code:'QA_TEST_COHORT_DENIED'})
  return e
}
export function qaTestEntries(){return [...cohort]}
