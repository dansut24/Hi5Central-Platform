#!/usr/bin/env node
/**
 * Only prepares and archives a narrow QA cohort entitlement overlay.
 * Never reloads active Caddy, replaces its bind mount, or changes tenant
 * data. The host gateway requires an independent protected deployment.
 */
import {execFileSync,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {renderQaGatewayEntitlementOverlay,expectedQaDeniedAliases}
 from '../../services/api/src/qaGatewayEntitlementOverlay.js'
import {verifyLiveGatewayRuntimeProvenance}
 from '../../services/api/src/releaseGatewayProvenance.js'
if(process.argv.length!==2)throw Error('No mutating CLI options are accepted.')
const docker=(...args)=>execFileSync('docker',args,{
 encoding:'utf8',maxBuffer:6_000_000,timeout:35000,
})
const SHA=x=>createHash('sha256').update(String(x)).digest('hex')
const volume='h5c_release79_live_caddy_20261017'
const candidate=docker('run','--rm','--network','none','--mount',
 'type=volume,source='+volume+',target=/backup,readonly',
 'busybox:1.36','cat','/backup/reconciliation-candidate.Caddyfile')
if(SHA(candidate)!=='30d4905f0f32463fc9de5237a893ce5942a35e94c8aabd976c1bbe17ad4f0d17')
 throw Error('Independently reviewed Caddy reconciliation candidate changed.')
const basePath='/tmp/staff-verified-upgrade-1792092421202.Caddyfile'
const baseline=JSON.parse(docker('exec','hi5central-web','caddy',
 'adapt','--config',basePath,'--adapter','caddyfile'))
const actual=JSON.parse(docker('exec','hi5central-web','wget','-q',
 '-O','-','http://127.0.0.1:2019/config/'))
const proof=verifyLiveGatewayRuntimeProvenance({
 lastVerified:baseline,active:actual,
})
if(!proof.verified)
 throw Error('Live gateway changed since reviewed 11-route baseline; no overlay preparation.')
const slugs=[
 'h5c-managed-qa26','managed1','managed2','h5c-custom-qa26','custom1',
 'custom2','h5c-managed-rmm-qa27','qa27-managed-itsm-qa27',
 'qa27-custom-rmm-qa27','qa27-custom-itsm-qa27',
]
const query=`import pg from 'pg'
 const p=new pg.Pool({connectionString:process.env.DATABASE_URL})
 try{
  const rows=await p.query(
   "SELECT t.slug,p.update_mode AS mode,coalesce((s.modules->>'rmm')::boolean,false) AS rmm "+
   "FROM tenants t JOIN tenant_release_preferences p ON p.tenant_id=t.id "+
   "JOIN tenant_settings s ON s.tenant_id=t.id "+
   "WHERE t.status='active' AND t.slug=ANY($1::text[]) ORDER BY t.slug",
   [${JSON.stringify(slugs)}])
  console.log(JSON.stringify(rows.rows))
 }finally{await p.end()}`
const tenants=JSON.parse(docker('exec','hi5central-certified-release-planner',
 'node','--input-type=module','-e',query).trim())
const rules=expectedQaDeniedAliases(tenants)
const rendered=renderQaGatewayEntitlementOverlay(candidate,tenants)
const dest='/tmp/h5c79-qa-entitlement-review.Caddyfile'
const put=spawnSync('docker',['exec','-i','hi5central-web','sh','-c',
 'umask 077; cat > '+dest],{input:rendered,encoding:'utf8',timeout:15000})
if(put.status!==0)throw Error('Could not write disposable Caddy review file.')
const parse=(path)=>JSON.parse(docker('exec','hi5central-web','caddy',
 'adapt','--config',path,'--adapter','caddyfile'))
const priorPath='/tmp/h5c79-review-candidate.Caddyfile'
const prior=parse(priorPath)
const next=parse(dest)
const valid=spawnSync('docker',['exec','hi5central-web','caddy','validate',
 '--config',dest,'--adapter','caddyfile'],{encoding:'utf8',timeout:30000})
if(valid.status!==0)throw Error('Entitlement candidate failed Caddy validation.')
const routes=x=>x?.apps?.http?.servers?.srv0?.routes||[]
const k=r=>r.match?.[0]?.host?.join(',')||'<catch-all>'
const norm=x=>{
 const groups=new Map()
 const visit=v=>{
  if(Array.isArray(v))return v.map(visit)
  if(!v||typeof v!=='object')return v
  const out={}
  for(const key of Object.keys(v).sort()){
   let value=v[key]
   if(key==='group'&&typeof value==='string'&&/^group\d+$/.test(value)){
    if(!groups.has(value))groups.set(value,'group-'+groups.size)
    value=groups.get(value)
   }
   if(key==='hide'&&Array.isArray(value))value=value.map(y=>
     typeof y==='string'&&(y===priorPath||y===dest)
      ?'<reconciled-source>':y)
   out[key]=visit(value)
  }
  return out
 }
 return visit(x)
}
const parent=routes(prior),overlay=routes(next)
const changed=[]
const map=new Map(overlay.map(r=>[k(r),r]))
for(const original of parent){
 const other=map.get(k(original))
 if(!other)throw Error('Gateway route disappeared under QA overlay.')
 if(JSON.stringify(norm(original))!==JSON.stringify(norm(other)))
  changed.push({key:k(original),before:original,after:other})
}
if(parent.length!==12||overlay.length!==12||changed.length!==1)
 throw Error('QA overlay changed a route other than the one wildcard routing block.')
const changedText=JSON.stringify(changed[0].after)
if(!changedText.includes('hi5central-prod-rmm:80')
 ||!changedText.includes('hi5central-uat-gateway:80')
 ||!changedText.includes('UAT is not enabled for this tenant')
 ||!changedText.includes('RMM is not enabled for this tenant'))
 throw Error('QA overlay unexpectedly replaced a customer upstream or deny clause.')
const saved=spawnSync('docker',['run','--rm','-i','--network','none',
 '--mount','type=volume,source='+volume+',target=/backup',
 'busybox:1.36','sh','-c',
 'umask 077; cat >/backup/qa-entitlement-candidate.Caddyfile; chmod 600 /backup/qa-entitlement-candidate.Caddyfile'],
 {input:rendered,encoding:'utf8',timeout:20000})
if(saved.status!==0)throw Error('QA entitlement candidate not archived.')
console.log(JSON.stringify({
 status:'QA_ENTITLEMENT_GATEWAY_CANDIDATE_READY_NOT_APPLIED',
 allTenantsFromReadOnlyDb:tenants.length,
 verifiedManagedUatAliasesDenied:rules.managedUat.length,
 verifiedNonRmmAliasesDenied:rules.nonRmm.length,
 entitledRmmAliasesStillAllowed:rules.rmmAllowed.length,
 hostRulesUnchanged:parent.length-changed.length,
 intendedModifiedRouteOnly:changed[0].key,
 CaddySyntaxValid:true,
 candidateSha256:SHA(rendered),
 backupVolume:volume,
 productionGatewayReloaded:false,
 customerDataChanged:false,
 stageWorkersUnpaused:false,
}))
