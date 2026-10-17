import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyReleaseGatewaySourceAgreement as check} from '../src/releaseGatewaySourceAgreement.js'
const runtime={apps:{http:{servers:{srv0:{routes:[
 {match:[{host:['alpha.hi5central.com']}],handle:[{handler:'subroute',routes:[{
  handle:[{handler:'reverse_proxy',upstreams:[{dial:'test:80'}]}]}]}]},
]}}}}}
test('exact host/mount/runtime equality is required for any Live cutover',()=>{
 assert.equal(check({hostSource:'one',mountedSource:'one',
  adaptedRuntime:runtime,loadedRuntime:runtime}).agreed,true)
 assert.match(check({hostSource:'one',mountedSource:'two',
  adaptedRuntime:runtime,loadedRuntime:runtime}).reason,/Host and mounted/)
})
test('runtime-only route blocks cutover even when both disk Caddyfiles agree',()=>{
 const more=structuredClone(runtime)
 more.apps.http.servers.srv0.routes.push({
  match:[{host:['marketing-preview.hi5central.com']}],
  handle:[{handler:'subroute',routes:[]}]})
 const result=check({hostSource:'same',mountedSource:'same',
  adaptedRuntime:runtime,loadedRuntime:more})
 assert.equal(result.agreed,false)
 assert.equal(result.loadedMatchesMounted,false)
 assert.match(result.reason,/Currently loaded Caddy routes/)
})
test('JSON key order is ignored but route order and upstream targets are not',()=>{
 const differentlyOrdered={apps:{http:{servers:{
  srv0:{routes:structuredClone(runtime.apps.http.servers.srv0.routes)},
 }}}}
 assert.equal(check({hostSource:'x',mountedSource:'x',
  adaptedRuntime:runtime,loadedRuntime:JSON.stringify(differentlyOrdered)}).agreed,true)
 differentlyOrdered.apps.http.servers.srv0.routes[0].handle[0].routes[0]
  .handle[0].upstreams[0].dial='other:80'
 assert.equal(check({hostSource:'x',mountedSource:'x',
  adaptedRuntime:runtime,loadedRuntime:differentlyOrdered}).agreed,false)
})
test('invalid or missing active JSON denies the operation',()=>{
 assert.equal(check({hostSource:'x',mountedSource:'x',
  adaptedRuntime:runtime,loadedRuntime:'<html></html>'}).agreed,false)
})
