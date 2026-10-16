import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const fixtureRoot=mkdtempSync(join(tmpdir(),'qa26-six-verify-'))
const script=fileURLToPath(new URL('../../../deployment/qa26/verify-six-qa-test-rollouts.mjs',import.meta.url))
const target='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
const baseline='4a363cf9054b0b3667fd450f36e354b704ec2166'
const slugs=['custom1','custom2','h5c-custom-qa26','h5c-managed-qa26','managed1','managed2']
const canaries=['h5c-custom-qa26','h5c-managed-qa26']
const bin=join(fixtureRoot,'bin')
mkdirSync(bin,{recursive:true})
function fake(name,source){
 const filename=join(bin,name)
 writeFileSync(filename, '#!/usr/bin/env node\n'+source)
 chmodSync(filename,0o755)
}
fake('docker',`
const {readFileSync}=require('node:fs')
if(process.argv[2]!=='exec'||process.argv[3]!=='hi5central-certified-release-planner')process.exit(8)
process.stdout.write(readFileSync(process.env.H5C_TEST_DB_FIXTURE,'utf8'))
`)
fake('curl',`
const {readFileSync}=require('node:fs')
const url=process.argv.at(-1)
const slug=/https:\/\/([a-z0-9-]+)-test\.hi5central\.com\//.exec(url)?.[1]
if(!slug||!url.endsWith('/api/v1/updates/version')&&!url.endsWith('/release-manifest.json'))process.exit(8)
const versions=JSON.parse(readFileSync(process.env.H5C_TEST_VERSIONS_FIXTURE,'utf8'))
if(!versions[slug])process.exit(8)
const type=url.endsWith('release-manifest.json')?'web':'api'
process.stdout.write(JSON.stringify({sha:versions[slug][type]}))
`)
const job=slug=>({slug,id:'11111111-1111-4111-8111-111111111111',
 environment:'test',status:'scheduled',build_sha:target,
 attempt_count:0,completed_at:null,routed_generation:null,
 verified_events:0,assignments:0,scheduled_at:'2026-10-16T13:00:00Z',
 update_mode:slug.startsWith('custom')?'admin_controlled':'hi5_managed'})
function run(statuses,mode,overrides={}){
 const base={paused:true,certification:'approved',gate:null,
 runningJobs:0,jobs:slugs.map(job)}
 const versions=Object.fromEntries(slugs.map(slug=>[slug,{api:baseline,web:baseline}]))
 for(const slug of statuses){
  const item=base.jobs.find(j=>j.slug===slug)
  Object.assign(item,{status:'succeeded',attempt_count:1,
    verified_events:1,completed_at:'2026-10-16T14:10:00Z',
    routed_generation:1790000000000,assignments:0})
  versions[slug]={api:target,web:target}
 }
 if(overrides.badVerifiedEvent){
  base.jobs.find(j=>j.slug===overrides.badVerifiedEvent).verified_events=0
 }
 if(overrides.badWeb){
  versions[overrides.badWeb].web=baseline
 }
 const db=join(fixtureRoot,'db.json'),web=join(fixtureRoot,'web.json')
 writeFileSync(db,JSON.stringify(base))
 writeFileSync(web,JSON.stringify(versions))
 const p=spawnSync(process.execPath,[script,mode],{encoding:'utf8',timeout:16000,
  env:{...process.env,PATH:bin+':'+process.env.PATH,
   H5C_TEST_DB_FIXTURE:db,H5C_TEST_VERSIONS_FIXTURE:web}})
 const result=JSON.parse(p.stdout)
 return {code:p.status,result}
}
test('snapshot supports six healthy baseline tenants before their windows',()=>{
 const {code,result}=run([],'--snapshot')
 assert.equal(code,0)
 assert.equal(result.passed,true)
 assert.equal(result.completed,0)
})
test('two verified Test canaries PASS without Test runtime assignment rows',()=>{
 const {code,result}=run(canaries,'--expect-canaries')
 assert.equal(code,0)
 assert.equal(result.passed,true)
 assert.equal(result.completed,2)
 assert.equal(result.reports.find(r=>r.tenant===canaries[0]).assignmentCount,0)
})
test('six verified Test tenants PASS despite Test assignment table being unused',()=>{
 const {code,result}=run(slugs,'--expect-six')
 assert.equal(code,0)
 assert.equal(result.passed,true)
 assert.equal(result.completed,6)
})
test('claiming success without fenced verified event is rejected',()=>{
 const {code,result}=run(slugs,'--expect-six',{badVerifiedEvent:'custom1'})
 assert.notEqual(code,0)
 assert.match(result.errors.join(' '),/custom1/)
})
test('public web/build disagreement is rejected for a succeeded job',()=>{
 const {code,result}=run(slugs,'--expect-six',{badWeb:'managed1'})
 assert.notEqual(code,0)
 assert.match(result.errors.join(' '),/managed1/)
})
test('unverified scheduled tenants do not count as upgraded',()=>{
 const {code,result}=run(canaries,'--expect-six')
 assert.notEqual(code,0)
 assert.equal(result.completed,2)
})
process.on('exit',()=>rmSync(fixtureRoot,{recursive:true,force:true}))
