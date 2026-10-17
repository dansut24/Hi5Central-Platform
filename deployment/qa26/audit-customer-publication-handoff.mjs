#!/usr/bin/env node
/**
 * Read-only Dev author -> central publisher -> officially certified release
 * -> ten-tenant queue diagnosis. Never publishes, certifies, approves, or
 * unpauses. Any missing trust boundary returns BLOCKED (nonzero exit).
 */
import {execFileSync} from 'node:child_process'
const SHA=/^[a-f0-9]{40}$/
const docker=(...args)=>execFileSync('docker',args,{
  encoding:'utf8',timeout:20000,maxBuffer:500000,
})
const dev=await fetch('https://dev-api.hi5central.com/api/v1/updates/version',{
  signal:AbortSignal.timeout(8500),cache:'no-store'}).then(x=>{
    if(!x.ok)throw Error('Dev version is not reachable.')
    return x.json()
  })
if(!SHA.test(dev.sha))throw Error('Dev does not serve a full immutable build SHA.')
const readRows=(container,sql,params=[])=>{
 const code=`import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
 try{const x=await p.query(${JSON.stringify(sql)},${JSON.stringify(params)});
 console.log(JSON.stringify(x.rows))}finally{await p.end()}`
 return JSON.parse(docker('exec',container,'node','--input-type=module','-e',code).trim())
}
const draft=readRows('hi5pool-dev-'+dev.sha.slice(0,12)+'-api',
 'SELECT status,version_label,title,requested_at,published_at FROM hi5central_release_note_drafts WHERE build_sha=$1',
 [dev.sha])
const published=readRows('hi5central-certified-release-planner',
 'SELECT version_label,title,published_at FROM hi5central_published_release_notes WHERE build_sha=$1',
 [dev.sha])
const certification=readRows('hi5central-certified-release-planner',
 'SELECT status,ci_run_url,approved_at FROM platform_certified_application_releases WHERE build_sha=$1',
 [dev.sha])
const queue=readRows('hi5central-certified-release-planner',
 'SELECT environment,status,count(*)::int AS n FROM tenant_release_rollout_jobs WHERE build_sha=$1 GROUP BY environment,status',
 [dev.sha])
const rollout=readRows('hi5central-certified-release-planner',
 'SELECT paused FROM platform_release_rollout_control WHERE singleton=true')
const names=docker('ps','--format','{{.Names}}').split('\n')
const relayActive=names.some(x=>x.includes('release-publication-relay'))
const allowed=docker('exec','hi5central-api','node','-e',
 'console.log(process.env.RELEASE_PUBLICATION_ALLOWED_SHA===process.argv[1])',dev.sha).trim()==='true'
const blockers=[]
if(draft.length!==1)blockers.push('Dev has no unique release-note draft for the running build.')
else if(draft[0].status!=='published')blockers.push('Dev author request is '+draft[0].status+'.')
if(published.length!==1)blockers.push('Central authority has not published this exact build.')
if(!allowed)blockers.push('Central publication-only token scope does not allow the Dev build.')
if(!relayActive)blockers.push('Dedicated publication relay is not running.')
if(certification.length!==1||certification[0].status!=='approved')
 blockers.push('Official CI-verified staff release certification is missing.')
if(queue.length===0)blockers.push('No tenant rollout jobs are queued for this build.')
if(rollout[0]?.paused!==false)blockers.push('Global release worker remains paused.')
const report={
 audit:'H5C_DEV_RELEASE_PUBLICATION_HANDOFF_V1',
 sha:dev.sha,environment:dev.environment,
 authorRequestStatus:draft[0]?.status||'missing',
 authorRequestedAt:draft[0]?.requested_at||null,
 customerVersion:draft[0]?.version_label||null,
 centralPublication:published.length===1?'published':'missing',
 publisherScopeMatches:allowed,publisherRelayRunning:relayActive,
 centralCertification:certification[0]?.status||'missing',
 queuedJobs:queue,globallyPaused:rollout[0]?.paused??null,
 actualCustomerUpgradeClaimed:false,
 status:blockers.length?'BLOCKED':'READY_FOR_INDEPENDENT_HOST_ACCEPTANCE',
 blockers,
}
console.log(JSON.stringify(report,null,2))
if(blockers.length)process.exitCode=2
