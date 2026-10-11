import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {masterLegalIdentityScope,readMasterLegalIdentity,applyMasterLegalIdentity,
 protectMasterLegalIdentity} from '../src/masterLegalIdentity.js'

const folder=mkdtempSync(join(tmpdir(),'hi5-master-identity-'))
const path=join(folder,'master-connection')
writeFileSync(path,'postgresql://ci-only:ci-only@localhost:5432/isolated-master',{mode:0o400})
const id='11111111-1111-4111-8111-111111111111'
const uat={tenant_id:id,slug:'testing-uat'}
const test={tenant_id:id,slug:'testing-test'}
const settings={ENV_SHARED_MASTER_PILOT_TENANT_SLUG:'testing',ENV_MASTER_DATABASE_URL_FILE:path}
let connectCount=0,lookupCount=0,closed=0
const connect=connection=>{
 assert.equal(connection,'postgresql://ci-only:ci-only@localhost:5432/isolated-master')
 connectCount++
 return {
  async connect(){},
  async query(sql,params){
   lookupCount++
   assert.match(sql,/JOIN tenants t ON t.id=ts.tenant_id/)
   assert.match(sql,/t.id=\$1 AND t.slug=\$2 AND t.status='active'/)
   assert.deepEqual(params,[id,'testing'])
   return {rowCount:1,rows:[{legal_name:'Registered Company Ltd'}]}
  },
  async end(){closed++},
 }
}
try{
 assert.deepEqual(masterLegalIdentityScope(uat,{environment:'uat',settings}),{tenantId:id,pilot:'testing'})
 assert.deepEqual(masterLegalIdentityScope(test,{environment:'test',settings}),{tenantId:id,pilot:'testing'})
 assert.equal(masterLegalIdentityScope({...uat,slug:'another-uat'},{environment:'uat',settings}),null)
 assert.equal(masterLegalIdentityScope(uat,{environment:'live',settings}),null)
 assert.equal(masterLegalIdentityScope({...uat,tenant_id:'invalid'},{environment:'uat',settings}),null)
 assert.equal(masterLegalIdentityScope(uat,{environment:'uat',settings:{...settings,ENV_SHARED_MASTER_PILOT_TENANT_SLUG:''}}),null)
 assert.equal(await readMasterLegalIdentity(uat,{environment:'live',settings,connect}),null)
 for(const [session,environment] of [[uat,'uat'],[test,'test']]){
  const identity=await readMasterLegalIdentity(session,{environment,settings,connect})
  assert.deepEqual(identity,{legalName:'Registered Company Ltd'})
  const merged=applyMasterLegalIdentity({settings:{company:{legalName:'Stale UAT',industry:'Technology'}}},identity)
  assert.equal(merged.settings.company.legalName,'Registered Company Ltd')
  assert.equal(merged.settings.company.industry,'Technology','No other company setting is overwritten')
  assert.equal(merged.masterIdentity.companyLegalNameReadOnly,true)
  assert.deepEqual(protectMasterLegalIdentity({industry:'Technology'},identity),
    {industry:'Technology'})
  assert.deepEqual(protectMasterLegalIdentity({industry:'Technology',legalName:identity.legalName},identity),
    {industry:'Technology'},'Sandbox must never store its own duplicate legal name')
  assert.throws(()=>protectMasterLegalIdentity({legalName:'Sandbox forged registration'},identity),
    /managed in Production/)
 }
 assert.equal(connectCount,2)
 assert.equal(lookupCount,2)
 assert.equal(closed,2)
 let noRowClosed=0
 await assert.rejects(()=>readMasterLegalIdentity(uat,{environment:'uat',settings,
  connect:()=>({async connect(){},async query(){return {rowCount:0,rows:[]}},
    async end(){noRowClosed++}})}),/unavailable/)
 assert.equal(noRowClosed,1)
 await assert.rejects(()=>readMasterLegalIdentity(uat,{environment:'uat',
  settings:{...settings,ENV_MASTER_DATABASE_URL_FILE:''},connect}),/unavailable/)
 console.log('PASS: legal company name always reads master by tenant ID/slug, is protected from sandbox overwrites and fails closed')
}finally{rmSync(folder,{recursive:true,force:true})}
