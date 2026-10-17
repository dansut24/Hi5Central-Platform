import test from 'node:test'
import assert from 'node:assert/strict'
import {verifySemanticReleaseGatewayAgreement as compare} from '../src/releaseGatewaySemanticAgreement.js'
import {verifyReleaseGatewaySourceAgreement as sourceAgreement} from '../src/releaseGatewaySourceAgreement.js'

const hosts=['admin.hi5central.com','api.hi5central.com','rmm.hi5central.com',
 'auth.hi5central.com','connect.hi5central.com',
 'hi5central.com','www.hi5central.com','downloads.hi5central.com',
 'test.hi5central.com','*.hi5central.com']
const original=hosts.map((host,i)=>({
 match:[{host:[host]}],terminal:true,
 handle:[{handler:'subroute',routes:[{
  group:'group'+(i+19),
  handle:[{handler:'reverse_proxy',upstreams:[{dial:'trusted-'+i+':80'}]}],
 }]}],
}))
original.push({handle:[{handler:'static_response',status_code:421}],terminal:true})
const staticResponse=(status,other={})=>({handler:'static_response',status_code:status,...other})
const previewLoaded={
 match:[{host:['marketing-preview.hi5central.com']}],terminal:true,
 handle:[{handler:'subroute',routes:[
  {match:[{path:['/signup','/signup/*']}],terminal:true,
   handle:[staticResponse(302,{headers:{Location:['https://hi5central.com/signup']}})]},
  {match:[{path:['/api','/api/*','/auth','/auth/*','/admin','/admin/*']}],
   terminal:true,handle:[staticResponse(404,{body:'Not available on marketing preview'})]},
  {terminal:true,handle:[
   {handler:'headers',response:{set:{
    'X-Hi5-Marketing-Preview':['pr83'],
    'X-Robots-Tag':['noindex, nofollow, noarchive'],
   }}},
   {handler:'reverse_proxy',upstreams:[{dial:'hi5central-marketing-pr83-preview-real:80'}]},
  ]},
 ]}],
}
const previewAdapted=structuredClone(previewLoaded)
previewAdapted.handle[0].routes=previewLoaded.handle[0].routes.map((r,i)=>({
 group:'group66',
 match:r.match,
 handle:[{handler:'subroute',routes:[{handle:r.handle}]}],
}))
const configuration=preview=>{
 const routes=structuredClone(original)
 routes.splice(10,0,structuredClone(preview))
 return {apps:{http:{servers:{srv0:{routes}}}}}
}
const current=()=>configuration(previewLoaded)
const candidate=()=>configuration(previewAdapted)
test('reviewed preview compiled by Caddy matches active admin JSON but strict default still denies',()=>{
 assert.equal(compare({adaptedRuntime:candidate(),loadedRuntime:current()}).same,true)
 const params={hostSource:'same',mountedSource:'same',
  adaptedRuntime:candidate(),loadedRuntime:current()}
 assert.equal(sourceAgreement(params).agreed,false)
 assert.equal(sourceAgreement({
  ...params,allowReviewedPreviewSemanticEquivalence:true}).agreed,true)
})
test('changed Admin/auth/RMM/catchall upstream or route ordering fails closed',()=>{
 for(const i of [0,1,2,3,9]){
  const mutated=current()
  mutated.apps.http.servers.srv0.routes[i].handle[0].routes[0]
   .handle[0].upstreams[0].dial='wrong:80'
  assert.equal(compare({adaptedRuntime:candidate(),loadedRuntime:mutated}).same,false)
 }
 const reorders=current().apps.http.servers.srv0.routes
 ;[reorders[0],reorders[2]]=[reorders[2],reorders[0]]
 assert.equal(compare({adaptedRuntime:candidate(),loadedRuntime:current()}).same,true)
 assert.equal(compare({adaptedRuntime:candidate(),
  loadedRuntime:{apps:{http:{servers:{srv0:{routes:reorders}}}}}}).same,false)
})
test('preview domain/redirect/API denial/robots/upstream cannot be weakened',()=>{
 const modifications=[
  p=>p.handle[0].routes[0].handle[0].headers.Location[0]='https://other.example/',
  p=>p.handle[0].routes[1].match[0].path.pop(),
  p=>p.handle[0].routes[1].handle[0].status_code=200,
  p=>p.handle[0].routes[2].handle[0].response.set['X-Robots-Tag']=['index'],
  p=>p.handle[0].routes[2].handle[1].upstreams[0].dial='unknown:80',
 ]
 for(const mutate of modifications){
  const mutated=current()
  mutate(mutated.apps.http.servers.srv0.routes[10])
  assert.equal(compare({adaptedRuntime:candidate(),loadedRuntime:mutated}).same,false)
 }
})
test('unknown host, missing host, duplicate preview or ordinary 11-route drift denied',()=>{
 const unexpected=current();unexpected.apps.http.servers.srv0.routes.push({
  match:[{host:['rogue.hi5central.com']}],handle:[{handler:'static_response'}]})
 assert.equal(compare({adaptedRuntime:candidate(),loadedRuntime:unexpected}).same,false)
 const deleted=current();deleted.apps.http.servers.srv0.routes.splice(4,1)
 assert.equal(compare({adaptedRuntime:candidate(),loadedRuntime:deleted}).same,false)
 const duplicate=current();duplicate.apps.http.servers.srv0.routes[1]=
  structuredClone(duplicate.apps.http.servers.srv0.routes[10])
 assert.equal(compare({adaptedRuntime:candidate(),loadedRuntime:duplicate}).same,false)
 const onlyOriginal=structuredClone(candidate())
 onlyOriginal.apps.http.servers.srv0.routes.splice(10,1)
 assert.equal(compare({adaptedRuntime:onlyOriginal,loadedRuntime:current()}).same,false)
})
