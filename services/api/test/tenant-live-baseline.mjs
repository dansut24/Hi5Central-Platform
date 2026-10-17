import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveTenantCurrentRevision} from '../src/tenantLiveBaseline.js'

const webSha='a'.repeat(40),apiSha='b'.repeat(40)
const html='<!doctype html><html><head></head><body>Legacy QA ITSM</body></html>'
const legacy={
  environment:'live',tenantSlug:'h5c-managed-qa26',
  versionResponse:html,
  manifestResponse:JSON.stringify({sha:webSha}),
  runtimeConfigResponse:'window.__HI5_CONFIG__ = { apiUrl: "https://api.hi5central.com" }',
  sharedApiVersionResponse:JSON.stringify({sha:apiSha}),
}
test('A real tenant JSON version is authoritative and requires SHA40',()=>{
  assert.deepEqual(resolveTenantCurrentRevision({
    environment:'test',tenantSlug:'any-tenant',
    versionResponse:JSON.stringify({sha:apiSha}),
  }),{sha:apiSha,source:'tenant-api'})
  assert.throws(()=>resolveTenantCurrentRevision({
    ...legacy,versionResponse:'{"sha":"latest"}',
  }),/exact immutable SHA/)
})
test('Both specifically designated legacy QA Live tenants use manifest plus shared API proof',()=>{
  for(const tenantSlug of ['h5c-managed-qa26','h5c-custom-qa26']){
    assert.deepEqual(resolveTenantCurrentRevision({...legacy,tenantSlug}),{
      sha:webSha,source:'legacy-qa-live-frontend',sharedApiSha:apiSha,
    })
  }
})
test('Never allow HTML fallback on arbitrary customer, Test or UAT',()=>{
  for(const value of [
    {...legacy,tenantSlug:'real-paying-customer'},
    {...legacy,environment:'test'},
    {...legacy,environment:'uat'},
  ])assert.throws(()=>resolveTenantCurrentRevision(value),/HTML or invalid JSON/)
})
test('Reject forged, partial or unexpected legacy QA evidence',()=>{
  const bad=[
    {...legacy,versionResponse:'<error>not HTML</error>'},
    {...legacy,manifestResponse:'{"sha":"latest"}'},
    {...legacy,sharedApiVersionResponse:'{"error":"unauthorized"}'},
    {...legacy,runtimeConfigResponse:'apiUrl: "https://malicious.example"'},
    {...legacy,runtimeConfigResponse:'apiUrl: "" || window.location.origin'},
    {...legacy,manifestResponse:'not json'},
  ]
  for(const value of bad)assert.throws(()=>resolveTenantCurrentRevision(value),/Tenant version proof denied/)
})
test('Invalid JSON is never accepted as authoritative API version',()=>{
  for(const versionResponse of ['{"sha":','{"sha":null}','{}','[]'])
    assert.throws(()=>resolveTenantCurrentRevision({
      ...legacy,versionResponse,
    }),/Tenant version proof denied/)
})
