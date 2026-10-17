#!/usr/bin/env node
/**
 * Safe, reproducible overnight QA acceptance checks. Run on authorised VPS.
 *
 * This script NEVER:
 *  - unpauses releases, approves releases/tenants, or claims queue jobs;
 *  - copies/reloads Production Caddy, creates SQL accounts, or deploys images;
 *  - changes Production customer data.
 *
 * It tests the LIVE release preconditions and, independently, executes a
 * disposable Caddy cutover/rollback smoke using its own isolated network
 * and volumes. A PASS from the smoke is NOT a customer Live rollback.
 */
import {spawnSync} from 'node:child_process'

if(process.argv.length!==2)throw Error('Read-only overnight acceptance accepts no arguments.')
const stages=[]
const run=(command,args,timeoutMs=170000)=>{
 const p=spawnSync(command,args,{encoding:'utf8',timeout:timeoutMs,
  maxBuffer:2_000_000})
 return {status:p.status,stdout:p.stdout||'',stderr:p.stderr||'',
  signal:p.signal||null}
}
const handoff=run('node',['deployment/qa26/audit-customer-publication-handoff.mjs'],60000)
let publication=null
try{publication=JSON.parse(handoff.stdout)}catch{}
stages.push({name:'DEV_TO_CENTRAL_RELEASE_PUBLICATION_HANDOFF',
 passed:handoff.status===0&&publication?.status==='READY_FOR_INDEPENDENT_HOST_ACCEPTANCE',
 result:publication?.status||'ERROR',
 buildSha:publication?.sha||null,
 requestedAt:publication?.authorRequestedAt||null,
 devRequestStatus:publication?.authorRequestStatus||null,
 centralPublication:publication?.centralPublication||'unknown',
 centralCertification:publication?.centralCertification||'unknown',
 queuedJobs:publication?.queuedJobs||[],
 blockers:publication?.blockers||['Could not parse release publication handoff audit.'],
})
const readiness=run('node',['deployment/qa26/audit-release-host-readiness.mjs'],90000)
let gate=null
try{gate=JSON.parse(readiness.stdout)}catch{}
stages.push({name:'LIVE_RELEASE_READINESS',result:gate?.status||'ERROR',
 passed:readiness.status===0&&gate?.status==='review_ready',
 blockers:gate?.reasons||['Could not parse live readiness JSON.'],
 tenQA:gate?.controls?.qaTenants||0,
 liveApiMatched:(gate?.customers||[]).filter(
  x=>x.environment==='live'&&x.exactApiFrontendMatch===true).length,
 liveBaselineAssignments:gate?.controls?.liveAssignments||0,
 globallyPaused:gate?.controls?.globallyPaused??null,
 activeDeploymentJobs:gate?.controls?.activeDeploymentJobs??null,
})
// This audit checks that the current active Caddy runtime is the same set
// of 11 independently verified routes plus the isolated marketing preview.
const provenance=run('node',['deployment/qa26/verify-active-caddy-provenance.mjs'],65000)
let proof=null
try{proof=JSON.parse(provenance.stdout)}catch{}
stages.push({name:'ACTIVE_CADDY_PROVENANCE',result:proof?.verified?'PASS':'FAIL',
 passed:provenance.status===0&&proof?.verified===true,
 verifiedHostRoutes:proof?.compared?.exactHostRuleMatches??0,
 reviewedMarketingPreview:proof?.compared?.onlyAdditionalActiveHost||null,
})
// The Docker image must be BUILT from the same reviewed checkout. It uses
// Docker only inside a disposable, internal network; no shared routes.
const built=run('docker',['build','--pull=false','-q',
 '-f','deployment/qa26/Dockerfile.host-rollback-smoke',
 '-t','h5c-overnight-qa-rollback:local','.'],100000)
let smoke={status:'SKIPPED',reason:'Isolated rollback Docker image did not build.'}
if(built.status===0){
 const result=run('docker',['run','--rm','--network','none',
  '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly',
  '--tmpfs','/tmp:rw,size=80m','h5c-overnight-qa-rollback:local'],110000)
 smoke={status:result.status===0?'PASS':'FAIL',
  evidence:result.stdout.trim().slice(-1200),
  error:result.status===0?null:result.stderr.slice(-450)}
}
stages.push({name:'DISPOSABLE_CADDY_TWO_TENANT_UPGRADE_AND_ROLLBACK',
 passed:smoke.status==='PASS',...smoke,
 productionGatewayAffected:false,customerTrafficChanged:false})
const output={
 audit:'H5C_OVERNIGHT_TEN_TENANT_UPGRADE_ACCEPTANCE_V1',
 timestamp:new Date().toISOString(),qaMode:'safe-preflight',
 productionReleaseTriggered:false,
 actualCustomerUpgradePerformed:false,
 actualCustomerRollbackPerformed:false,
 preflightPassed:stages.every(stage=>stage.passed),
 overnightReleaseOperational:false,
 noGoReason:'Only a real customer deployment and trusted host rollback can prove operational release readiness.',
 stages,
}
console.log(JSON.stringify(output,null,2))
// Return nonzero until the real release is enabled and passing; CI/operations
// must not treat isolated rollback success as a green Production update.
// The script deliberately never performs a real customer deployment;
 // therefore it must never report an operational Production rollout.
 process.exitCode=2
