import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {signDevHandoff,verifyDevHandoff,processDevHandoff} from '../src/devReleaseHandoff.js'
const secretValue='b'.repeat(64)
const sha='9b33de48d41bd975ad6eb7043296fc0c838d64ba'
const authorId='bf640983-5537-426c-9d95-741d23dcdb74'
const sample={action:'save',sha,authorId,devSlug:'dev',
 notes:{versionLabel:'2026.10.19.1',title:'ITSM changes',summary:'Updated ITSM',
 entries:[{category:'improvement',title:'Updated maintenance screen',description:'Selected windows'}]}}
test('HMAC authorises only untampered Dev preparation requests',()=>{
 const time=1771198812345
 const s=signDevHandoff(sample,{timestamp:time,secretValue})
 const headers={time:s.headers['X-H5C-Dev-Time'],nonce:s.headers['X-H5C-Dev-Nonce'],
  signature:s.headers['X-H5C-Dev-Signature']}
 const verified=verifyDevHandoff({payload:s.payload,headers,now:time,secretValue})
 assert.equal(verified.sha,sha)
 assert.equal(verified.devSlug,'dev')
 assert.throws(()=>verifyDevHandoff({payload:s.payload.replace('ITSM changes','Forged changes'),
   headers,now:time,secretValue}),/signature/)
 assert.throws(()=>verifyDevHandoff({payload:s.payload,headers,now:time+121000,secretValue}),/expired/)
 assert.throws(()=>verifyDevHandoff({payload:s.payload,headers:{...headers,signature:'a'.repeat(64)},now:time,secretValue}),/signature/)
})
test('Dev author cannot supply an Admin certification or arbitrary author tenant',()=>{
 const time=1771198812345
 for(const wrong of [{...sample,devSlug:'customer'}, {...sample,action:'approve'},
  {...sample,authorId:'not-a-user'}]){
  const s=signDevHandoff(wrong,{timestamp:time,secretValue})
  const headers={time:s.headers['X-H5C-Dev-Time'],nonce:s.headers['X-H5C-Dev-Nonce'],
   signature:s.headers['X-H5C-Dev-Signature']}
  assert.throws(()=>verifyDevHandoff({payload:s.payload,headers,now:time,secretValue}))
 }
})
test('Dev draft saves in single central release table with separate submission state',async()=>{
 const calls=[]
 const db={async query(sql,args=[]){
  assert.equal(typeof sql,'string');calls.push({sql,args})
  if(sql.includes('RETURNING build_sha,status,edited_at'))return {rows:[{build_sha:sha,status:'draft'}],rowCount:1}
  throw Error('unexpected query')
 }}
 const result=await processDevHandoff(db,sample)
 assert.equal(result.submission.status,'draft')
 assert.equal(calls.length,1)
 assert.match(calls[0].sql,/platform_dev_release_submissions/)
 assert.match(calls[0].sql,/status IN \('draft','rejected'\)/)
})
test('only Admin can release a submitted Dev record; source code prevents browser-supplied notes',()=>{
 const central=readFileSync(new URL('../src/certifiedTenantReleaseRoutes.js',import.meta.url),'utf8')
 const dev=readFileSync(new URL('../src/applicationUpdates.js',import.meta.url),'utf8')
 const admin=readFileSync(new URL('../../../apps/admin/src/features/admin/CertifiedReleaseControls.jsx',import.meta.url),'utf8')
 const editor=readFileSync(new URL('../../../apps/itsm/src/production/ProductionApplicationUpdates.jsx',import.meta.url),'utf8')
 assert.match(central,/record\?\.status!=='submitted'/)
 assert.match(central,/record\.ci_run_url!==runUrl/)
 assert.match(central,/publishCustomerReleaseNotes\(db,\{sha,notes:record\.notes\}\)/)
 assert.match(central,/if\(body\?\.releaseNotes!==undefined\)/)
 assert.match(central,/releaseToCustomers:true/)
 assert.match(dev,/auth\.session\.slug!=='dev'/)
 assert.match(dev,/Legacy local publication is retired/)
 assert.match(admin,/Approve & release to customers/)
 assert.doesNotMatch(admin,/releaseNotes:notes/)
 assert.match(editor,/Submit for Platform Admin approval/)
 assert.doesNotMatch(editor,/onClick=\{\(\)=>save\(true\)\}/)
})
