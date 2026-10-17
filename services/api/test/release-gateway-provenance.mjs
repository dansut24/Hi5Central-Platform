import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyLiveGatewayRuntimeProvenance as verify} from '../src/releaseGatewayProvenance.js'
const baseline={apps:{http:{servers:{srv0:{routes:[
 ...Array.from({length:8},(_,i)=>({match:[{host:['baseline-'+i+'.hi5central.com']}],
   handle:[{handler:'reverse_proxy',upstreams:[{dial:'service-'+i+':80'}]}],terminal:true})),
 {handle:[{handler:'static_response',body:'Misdirected Request',status_code:421}],terminal:true},
]}}}}}
const preview={
 handle:[{handler:'subroute',routes:[
  {match:[{path:['/signup','/signup/*']}],handle:[{handler:'static_response',
    headers:{Location:['https://hi5central.com/signup']},status_code:302}],terminal:true},
  {match:[{path:['/api','/api/*','/auth','/auth/*','/admin','/admin/*']}],
   handle:[{handler:'static_response',body:'Not available on marketing preview',
    status_code:404}],terminal:true},
  {handle:[{handler:'headers',response:{set:{
    'X-Hi5-Marketing-Preview':['pr83'],
    'X-Robots-Tag':['noindex, nofollow, noarchive'],
   }}},{handler:'reverse_proxy',upstreams:[
     {dial:'hi5central-marketing-pr83-preview-real:80'}]}],terminal:true},
 ]}],
 match:[{host:['marketing-preview.hi5central.com']}],terminal:true,
}
function active(){
 const b=structuredClone(baseline)
 b.apps.http.servers.srv0.routes.splice(8,0,structuredClone(preview))
 return b
}
test('pass only when every original route is preserved exactly and one preview is isolated',()=>{
 const r=verify({lastVerified:baseline,active:active()})
 assert.equal(r.verified,true)
 assert.equal(r.verifiedExistingRoutes,9)
 assert.equal(r.activeRoutes,10)
 assert.equal(r.previewPreserved,true)
})
test('reject changed Admin, authentication, RMM or wildcard route upstream',()=>{
 const changed=active()
 changed.apps.http.servers.srv0.routes[0].handle[0].upstreams[0].dial='attacker:80'
 assert.equal(verify({lastVerified:baseline,active:changed}).verified,false)
})
test('reject unexpected active routes or missing known ones',()=>{
 const unexpected=active()
 unexpected.apps.http.servers.srv0.routes.push({
  match:[{host:['other-preview.hi5central.com']}],handle:[]})
 assert.equal(verify({lastVerified:baseline,active:unexpected}).verified,false)
 const dropped=active()
 dropped.apps.http.servers.srv0.routes.splice(3,1)
 assert.equal(verify({lastVerified:baseline,active:dropped}).verified,false)
})
test('preview cannot weaken API denial, change signup or preview upstream',()=>{
 const models=[['api',p=>p.handle[0].routes[1].match[0].path.pop()],
  ['signup',p=>p.handle[0].routes[0].handle[0].headers.Location[0]='https://evil.example'],
  ['robots',p=>p.handle[0].routes[2].handle[0].response.set['X-Robots-Tag']=['index']],
  ['upstream',p=>p.handle[0].routes[2].handle[1].upstreams[0].dial='evil:80']]
 for(const [name,mutate] of models){
  const changed=active();mutate(changed.apps.http.servers.srv0.routes[8])
  assert.equal(verify({lastVerified:baseline,active:changed}).verified,false,name)
 }
})
test('reject ambiguous host matchers or malformed source',()=>{
 const doubled=active()
 doubled.apps.http.servers.srv0.routes.push(
  structuredClone(doubled.apps.http.servers.srv0.routes[0]))
 assert.equal(verify({lastVerified:baseline,active:doubled}).verified,false)
 assert.equal(verify({lastVerified:{},active:active()}).verified,false)
})
