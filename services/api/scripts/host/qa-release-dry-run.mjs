#!/usr/bin/env node
// Safe planning and public observation. No Docker socket, signing keys,
// credentials, database writes or Caddy route activation.
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {makeQaReleasePlan,assessPublicRelease} from '../../src/qaReleasePlan.js'

const args=process.argv.slice(2)
const val=key=>{const i=args.indexOf(key);return i<0?undefined:args[i+1]}
const buildSha=val('--sha'),versionLabel=val('--version'),output=val('--output')||'qa-release-evidence'
if(!/^[a-z0-9][a-z0-9_-]{0,70}$/i.test(output)){
  console.error('Output must be a short local directory name.')
  process.exit(2)
}
const plan=makeQaReleasePlan({buildSha,versionLabel})
const result=await Promise.all(plan.targets.map(async t=>{
  const u=t.origin+'/release-manifest.json'
  try{
    const r=await fetch(u,{redirect:'error',cache:'no-store',
      headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)})
    const contentType=r.headers.get('content-type')||''
    if(r.status!==200||!contentType.includes('application/json'))
      return {host:t.host,httpStatus:r.status,frontendSha:null,
        observed:'missing_json_manifest'}
    const parsed=await r.json()
    return {host:t.host,httpStatus:r.status,
      frontendSha:typeof parsed?.sha==='string'?parsed.sha:null,observed:'json_manifest'}
  }catch(error){
    return {host:t.host,httpStatus:0,frontendSha:null,
      observed:String(error.code||error.name||'network_failure').slice(0,70)}
  }
}))
const assessments=assessPublicRelease(plan,result)
const report={plan,publicObservation:{observedAt:new Date().toISOString(),assessments},
  routingChanged:false,releaseOfferCreated:false,customerProductionChanged:false}
const folder=resolve(process.cwd(),output)
mkdirSync(folder,{recursive:true,mode:0o700})
writeFileSync(resolve(folder,'qa-release-plan.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
const markdown=[
  '# Hi5Central QA release — read-only dry run',
  '',
  '**Version:** '+plan.versionLabel,
  '**Immutable commit:** '+plan.buildSha,
  '**Status:** Proposal only. No routing, release-offer or Production changes were made.',
  '',
  '| Customer lane | Public host | Public frontend SHA | State |',
  '| --- | --- | --- | --- |',
  ...assessments.map(a=>{
    const lane=plan.targets.find(t=>t.host===a.host)
    return '| '+lane.updateMode+' / '+lane.environment.toUpperCase()+' | '+a.host+' | '+
      (a.frontendSha?a.frontendSha.slice(0,12):'Not verified')+
      ' | '+a.state+' |'
  }),
  '',
  '## Required before any public cutover',
  '',
  '- [ ] Immutable API and frontend image digests verified together by an authorised host.',
  '- [ ] Signed tenant-scoped route intent, explicit approval, Caddy baseline and rollback snapshot.',
  '- [ ] Public API + frontend match the approved SHA, login/MFA and tenant isolation verified.',
  '- [ ] Custom UAT evidence for login, navigation, records and mobile; explicit owner Production approval.',
  '- [ ] Managed 24-hour published-release delay and maintenance-window guard.',
  '- [ ] QA-only host audit receipt; independent review before any Production promotion.',
  '',
  'This unsigned dry run is not a release authorisation.',
].join('\n')+'\n'
writeFileSync(resolve(folder,'qa-release-plan.md'),markdown,{mode:0o600})
console.log(markdown)
