import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Hono} from 'hono'
import {masterLegalIdentityScope,readMasterLegalIdentity,applyMasterLegalIdentity,
 protectMasterLegalIdentity,registerMasterLegalIdentityRoutes} from '../src/masterLegalIdentity.js'

const folder=mkdtempSync(join(tmpdir(),'hi5-master-identity-'))
const keyFile=join(folder,'identity-secret')
const secret='identity-test-only-constant-'+ 'A'.repeat(40)
writeFileSync(keyFile,secret,{mode:0o400})
const tenantId='11111111-1111-4111-8111-111111111111'
const test={tenant_id:tenantId,slug:'testing-test'}
const uat={tenant_id:tenantId,slug:'testing-uat'}
const settings={ENV_SHARED_MASTER_PILOT_TENANT_SLUG:'testing',
 ENV_IDENTITY_API_URL:'https://api.hi5central.com',ENV_IDENTITY_SHARED_SECRET_FILE:keyFile}
let lookups=0
const database={async query(sql,args){
 lookups++
 assert.match(sql,/JOIN tenants t ON t.id=ts.tenant_id/)
 assert.match(sql,/COALESCE\(NULLIF\(ts.configuration/)
 assert.match(sql,/NULLIF\(ts.onboarding_data/)
 assert.match(sql,/t.id=\$1 AND t.slug=\$2 AND t.status='active'/)
 assert.deepEqual(args,[tenantId,'testing'])
 return {rowCount:1,rows:[{legal_name:'Example Registered Co Ltd'}]}
}}
const app=new Hono()
registerMasterLegalIdentityRoutes(app,{database,environment:'live',settings})
const path='/api/v1/internal/environment-identity/legal-name'
const body={tenantId,tenantSlug:'testing',environment:'uat'}
const post=(auth,data=body)=>app.request(path,{method:'POST',
 headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(data)})
try{
 assert.deepEqual(masterLegalIdentityScope(uat,{environment:'uat',settings}),
  {tenantId,pilot:'testing',environment:'uat'})
 assert.deepEqual(masterLegalIdentityScope(test,{environment:'test',settings}),
  {tenantId,pilot:'testing',environment:'test'})
 assert.equal(masterLegalIdentityScope({...uat,slug:'another-uat'},{environment:'uat',settings}),null)
 assert.equal(masterLegalIdentityScope(uat,{environment:'live',settings}),null)
 assert.equal((await post('bad')).status,401)
 assert.equal((await post(secret,{...body,tenantSlug:'another'})).status,404)
 assert.equal((await post(secret,{...body,environment:'live'})).status,404)
 const valid=await post(secret)
 assert.equal(valid.status,200)
 assert.deepEqual(await valid.json(),{tenantId,tenantSlug:'testing',legalName:'Example Registered Co Ltd'})
 assert.equal(lookups,1)
 const disabled=new Hono()
 registerMasterLegalIdentityRoutes(disabled,{database,environment:'uat',settings})
 assert.equal((await disabled.request(path,{method:'POST'})).status,403)
 let fetchCount=0
 const fetchImpl=async(url,request)=>{
  fetchCount++
  assert.equal(url,'https://api.hi5central.com'+path)
  assert.equal(request.headers.authorization,'Bearer '+secret)
  assert.equal(request.redirect,'error')
  const payload=JSON.parse(request.body)
  assert.equal(payload.tenantId,tenantId)
  assert.equal(payload.tenantSlug,'testing')
  assert.ok(['test','uat'].includes(payload.environment))
  return new Response(JSON.stringify({tenantId,tenantSlug:'testing',legalName:'Example Registered Co Ltd'}),{status:200})
 }
 for(const [user,env] of [[uat,'uat'],[test,'test']]){
  const identity=await readMasterLegalIdentity(user,{environment:env,settings,fetchImpl})
  const merged=applyMasterLegalIdentity({settings:{company:{legalName:'Stale',industry:'Technology'}}},identity)
  assert.equal(merged.settings.company.legalName,'Example Registered Co Ltd')
  assert.equal(merged.settings.company.industry,'Technology')
  assert.equal(merged.masterIdentity.companyLegalNameReadOnly,true)
  assert.deepEqual(protectMasterLegalIdentity({legalName:identity.legalName,industry:'Tech'},identity),{industry:'Tech'})
  assert.throws(()=>protectMasterLegalIdentity({legalName:'Other registration'},identity),/managed in Production/)
 }
 assert.equal(fetchCount,2)
 assert.equal(await readMasterLegalIdentity(uat,{environment:'live',settings,fetchImpl}),null)
 await assert.rejects(()=>readMasterLegalIdentity(uat,{environment:'uat',settings,
  fetchImpl:async()=>new Response('{}',{status:404})}),/could not be verified/)
 await assert.rejects(()=>readMasterLegalIdentity(uat,{environment:'uat',settings,
  fetchImpl:async()=>new Response(JSON.stringify({tenantId:'wrong',tenantSlug:'testing',legalName:'Fake'}),{status:200})}),/did not match/)
 console.log('PASS: authenticated Production legal identity service, exact tenant boundary, Test/UAT read-through and no duplicate writes')
}finally{rmSync(folder,{recursive:true,force:true})}
