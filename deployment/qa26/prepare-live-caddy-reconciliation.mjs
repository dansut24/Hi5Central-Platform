#!/usr/bin/env node
/**
 * Create a reviewable, PRIVATE reconciliation candidate from the verified
 * October 15 gateway source and the independently verified PR83 marketing
 * preview. NEVER replaces Caddy, reloads Caddy, starts a worker, or changes
 * customer data. Refuses any additional live-route drift.
 *
 * The active gateway's Caddyfile is a read-only bind mount; applying this
 * candidate requires a separately reviewed, recoverable container remount
 * inside an approved maintenance window. This script NEVER attempts it.
 */
import {execFileSync,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {verifyLiveGatewayRuntimeProvenance} from '../../services/api/src/releaseGatewayProvenance.js'

if(process.argv.length!==2)throw Error('This reconciliation preparation is read-only outside private archive volume.')
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,maxBuffer:5000000})
const hash=x=>createHash('sha256').update(String(x)).digest('hex')
const oldPath='/tmp/staff-verified-upgrade-1792092421202.Caddyfile'
const source=docker('exec','hi5central-web','cat',oldPath)
if(hash(source)!=='bb1948f14d920cfa49d3d7e8265b2693f1718bac67fa78b59d2969bdd04f7234')
 throw Error('Last verified gateway Caddyfile has changed since source review.')
const active=JSON.parse(docker('exec','hi5central-web','wget','-q','-O','-','http://127.0.0.1:2019/config/'))
const previous=JSON.parse(docker('exec','hi5central-web','caddy','adapt',
 '--config',oldPath,'--adapter','caddyfile'))
const proof=verifyLiveGatewayRuntimeProvenance({lastVerified:previous,active})
if(!proof.verified)throw Error('Actual gateway runtime is not the verified 11-route baseline plus PR83 preview.')
const appended=`
# PR83 preview: only separately reviewed addition to 11 verified routes.
marketing-preview.hi5central.com {
    @signup path /signup /signup/*
    handle @signup {
        redir https://hi5central.com/signup 302
    }
    @blocked path /api /api/* /auth /auth/* /admin /admin/*
    handle @blocked {
        respond "Not available on marketing preview" 404
    }
    handle {
        header {
            X-Hi5-Marketing-Preview pr83
            X-Robots-Tag "noindex, nofollow, noarchive"
        }
        reverse_proxy hi5central-marketing-pr83-preview-real:80
    }
}
`
const candidate=source.trimEnd()+'\n'+appended
const candidatePath='/tmp/h5c79-review-candidate.Caddyfile'
const tmp=spawnSync('docker',['exec','-i','hi5central-web','sh','-c',
 'umask 077; cat > '+candidatePath],{input:candidate,encoding:'utf8',timeout:15000})
if(tmp.status!==0)throw Error('Could not write review-only candidate into Caddy tmpfs.')
const parsed=JSON.parse(docker('exec','hi5central-web','caddy','adapt',
 '--config',candidatePath,'--adapter','caddyfile'))
const valid=spawnSync('docker',['exec','hi5central-web','caddy','validate',
 '--config',candidatePath,'--adapter','caddyfile'],{encoding:'utf8',timeout:30000})
if(valid.status!==0)throw Error('Candidate failed Caddy validate; not archived.')
const routes=x=>x?.apps?.http?.servers?.srv0?.routes||[]
const key=r=>r.match?.[0]?.host?.join(',')||'<catch-all>'
function normalized(value){
 const groups=new Map()
 const visit=x=>{
  if(Array.isArray(x))return x.map(visit)
  if(!x||typeof x!=='object')return x
  const result={}
  for(const k of Object.keys(x).sort()){
   let v=x[k]
   if(k==='group'&&typeof v==='string'&&/^group\d+$/.test(v)){
    if(!groups.has(v))groups.set(v,'group-'+groups.size)
    v=groups.get(v)
   }
   // Caddy injects its config source pathname into file_server.hide. This
   // must be reconciled separately before a container remount; no hidden
   // path is removed from any live configuration in this preparation step.
   if(k==='hide'&&Array.isArray(v))v=v.map(y=>typeof y==='string'
    &&(y===oldPath||y===candidatePath)?'<candidate-caddy-source>':y)
   result[k]=visit(v)
  }
  return result
 }
 return visit(value)
}
const desired=new Map(routes(parsed).map(r=>[key(r),r]))
const prior=routes(previous)
const matches=prior.filter(r=>JSON.stringify(normalized(r))===
 JSON.stringify(normalized(desired.get(key(r))))).length
const preview=JSON.stringify(desired.get('marketing-preview.hi5central.com')||{})
const previewVerified=routes(parsed).length===12
 &&['hi5central-marketing-pr83-preview-real:80','/signup/*','/api/*',
 '/auth/*','/admin/*','noindex, nofollow, noarchive',
 'X-Hi5-Marketing-Preview','X-Robots-Tag']
 .every(word=>preview.includes(word))
if(matches!==11||!previewVerified)
 throw Error('Candidate does not preserve 11 normalized original routes and protected preview.')
const archive=spawnSync('docker',['run','--rm','-i','--network','none','--mount',
 'type=volume,source=h5c_release79_live_caddy_20261017,target=/backup',
 'busybox:1.36','sh','-c','umask 077; cat >/backup/reconciliation-candidate.Caddyfile && chmod 600 /backup/reconciliation-candidate.Caddyfile'],
 {input:candidate,encoding:'utf8',timeout:20000})
if(archive.status!==0)throw Error('Private candidate volume archive failed.')
console.log(JSON.stringify({status:'CANDIDATE_READY_FOR_REVIEW_NOT_APPLIED',
 sourceSha256:hash(source),candidateSha256:hash(candidate),
 runtimeProvenanceApproved:true,existingRoutesPreservedNormalized:matches,
 candidateHostRoutes:routes(parsed).length,marketingPreviewIncluded:true,
 candidateArchivedInPrivateBackupVolume:true,
 requiresControlledReadOnlyGatewayRemount:true,
 gatewayReloaded:false,customerDataChanged:false,rolloutUnpaused:false}))
