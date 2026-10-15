const SHA=/^[a-f0-9]{40}$/
const RUN_URL=/^https:\/\/github[.]com\/dansut24\/Hi5Central-Platform\/actions\/runs\/([0-9]{4,16})$/
const RELEASE_WORKFLOW='Real Hi5Central Dev Release Candidate (QA)'
const EXPECTED_JOBS=new Set([
  'Dev candidate release compatibility',
  'Security and migration compatibility',
  'Publish api immutable Dev candidate',
  'Publish itsm immutable Dev candidate',
  'Verify exact API+ITSM Dev release pair',
])
const failed=msg=>Object.assign(new Error(msg),{code:'RELEASE_CERTIFICATION_DENIED'})
const successful=res=>res&&res.status===200&&res.ok===true
const request=async(fetcher,url,headers={})=>{
  const response=await fetcher(url,{headers,redirect:'error',
    signal:AbortSignal.timeout(15000)})
  if(!successful(response))throw failed('Official GitHub Actions result is unavailable.')
  return response.json()
}
/** Verify exact immutable GitHub run, both images, tests, security & migrations.
 * A browser-supplied "checksPassed:true" is never accepted as verification.
 */
export async function verifyOfficialReleaseRun({sha,runUrl,token,fetcher=fetch}={}){
  if(!SHA.test(String(sha||'')))throw failed('Exact immutable SHA40 required.')
  const id=RUN_URL.exec(String(runUrl||''))?.[1]
  if(!id)throw failed('Use an official Hi5Central Actions run URL.')
  // GitHub's public Actions run/job metadata is independently accessible
  // without a credential for this public repository. Prefer a read-only token
  // to avoid anonymous API rate limits, but never accept user-supplied proof.
  // A private repository automatically fails closed if no token is configured.
  const headers={'Accept':'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
    'User-Agent':'Hi5Central-Release-Auditor'}
  if(token){
    if(String(token).length<10)throw failed('Invalid configured GitHub release credential.')
    headers.Authorization='Bearer '+token
  }
  const root='https://api.github.com/repos/dansut24/Hi5Central-Platform/actions/runs/'+id
  const run=await request(fetcher,root,headers)
  if(run.head_sha!==sha||run.name!==RELEASE_WORKFLOW||
    run.status!=='completed'||run.conclusion!=='success')
    throw failed('GitHub workflow identity, SHA or result does not match the proposed release.')
  const jobs=await request(fetcher,root+'/jobs?per_page=100',headers)
  if(!Array.isArray(jobs.jobs)||jobs.total_count>100)
    throw failed('The release contains jobs outside the verified CI result page.')
  const byName=new Map(jobs.jobs.map(job=>[job.name,job]))
  for(const job of EXPECTED_JOBS){
    const found=byName.get(job)
    if(found?.status!=='completed'||found?.conclusion!=='success')
      throw failed('Missing required verified CI gate: '+job)
  }
  return {ciRunUrl:runUrl,buildSha:sha,
    jobs:[...EXPECTED_JOBS],verifiedAt:new Date().toISOString(),
    evidence:{build:true,ci:true,security:true,migrations:true,smoke:false}}
}
/** Real Dev API+browser must serve the same image revision, over HTTPS. */
export async function verifyDevReleaseSmoke({sha,fetcher=fetch}={}){
  if(!SHA.test(String(sha||'')))throw failed('An immutable SHA is required.')
  async function getJson(url){
    const response=await fetcher(url,{redirect:'error',
      signal:AbortSignal.timeout(12000),cache:'no-store'})
    if(!successful(response))throw failed('Dev release smoke resource is unreachable.')
    return response.json()
  }
  const api=await getJson('https://dev-api.hi5central.com/api/v1/updates/version')
  const manifest=await getJson('https://dev.hi5central.com/release-manifest.json')
  const login=await fetcher('https://dev.hi5central.com/login',{
    redirect:'error',signal:AbortSignal.timeout(12000),cache:'no-store'})
  if(api.sha!==sha||manifest.sha!==sha||login.status!==200)
    throw failed('Real Dev API, frontend and sign-in do not match the official revision.')
  return {verifiedAt:new Date().toISOString(),smoke:true}
}
