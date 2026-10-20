import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {publishedCustomerVersion,customerVersionForBuild,
  customerVersionOrUnpublished} from '../../../apps/itsm/src/lib/customerReleaseVersion.js'

const installed='96b9edbcf1631ce9719884c3e3f1700907a6eff0'
const older='d05e592ef6e43a494e685f77964b4f9a4eef2c30'
const notes=[
 {buildSha:installed,versionLabel:'2026.10.19.5',title:'Rollback again'},
 {buildSha:older,versionLabel:'2026.10.19.4',title:'Rollback test 2'},
]
const customerPage=readFileSync(new URL('../../../apps/itsm/src/features/settings/TenantRuntimeUpdates.jsx',import.meta.url),'utf8')
const management=readFileSync(new URL('../../../apps/itsm/src/features/settings/ProductionReleaseManagement.jsx',import.meta.url),'utf8')
const updates=readFileSync(new URL('../../../apps/itsm/src/production/ProductionApplicationUpdates.jsx',import.meta.url),'utf8')
const tenantApi=readFileSync(new URL('../src/tenantRelease.js',import.meta.url),'utf8')

test('customers see only Hi5Central published versions, never abbreviated Git commit SHAs',()=>{
 assert.equal(customerVersionForBuild(installed,notes),'2026.10.19.5')
 assert.equal(customerVersionForBuild(older,notes),'2026.10.19.4')
 assert.equal(customerVersionOrUnpublished('a0504d0bff117a4d2fd5452d82da4ef0a7e16a9c',notes),
  'Version not published')
 assert.equal(customerVersionOrUnpublished('unknown',notes),'Version not published')
 assert.equal(customerVersionForBuild(installed,[]),null)
 assert.equal(publishedCustomerVersion('2026.10.19.5+96b9edbc'),'2026.10.19.5')
 for(const value of ['',installed,'96b9edbc','sha-96b9edbc','build 96b9edbc']){
  assert.equal(publishedCustomerVersion(value),null)
 }
})

test('customer UAT offer, recovery request, history and Production offer never render Git SHAs',()=>{
 assert.match(customerPage,/customerVersionOrUnpublished\(rollback\.installedBuildSha,published\)/)
 assert.match(customerPage,/customerVersionOrUnpublished\(rollback\.previousBuildSha,published\)/)
 assert.match(customerPage,/customerVersionOrUnpublished\(rollback\.latestRequest\.source_build_sha,published\)/)
 assert.match(customerPage,/customerVersionOrUnpublished\(rollback\.latestRequest\.target_build_sha,published\)/)
 assert.match(customerPage,/publishedCustomerVersion\(offer\.versionLabel\)/)
 assert.doesNotMatch(customerPage,/short\(offer\.buildSha\)|short\(rollback\.|build prefix/)
 assert.match(customerPage,/Type ROLLBACK UAT to confirm/)
 // Exact build SHA and generation remain attached to the authenticated request.
 assert.match(customerPage,/fromBuildSha:rollback\.installedBuildSha/)
 assert.match(customerPage,/toBuildSha:rollback\.previousBuildSha/)
 assert.match(customerPage,/routeGeneration:Number\(rollback\.sourceRouteGeneration\)/)
})

test('customer maintenance and sandbox views use published labels, not Git commit prefixes',()=>{
 assert.match(tenantApi,/LEFT JOIN hi5central_published_release_notes notes ON notes\.build_sha=j\.build_sha/)
 assert.match(tenantApi,/versionLabel:row\.version_label/)
 assert.match(management,/publishedCustomerVersion\(job\.versionLabel\)/)
 assert.match(management,/customerVersionForBuild\(matching\?\.activeReleaseRef,releases\)/)
 assert.doesNotMatch(management,/String\(job\.buildSha\)\.slice\(0,8\)/)
 assert.doesNotMatch(management,/state\.releaseRef/)
})

test('customer-facing installed version and release history never show raw frontend SHA',()=>{
 const customer=updates.slice(updates.indexOf('export function Hi5CentralUpdatesPanel'))
 assert.match(customer,/displayVersion\(installed\?\.versionLabel\)/)
 assert.match(customer,/Published Hi5Central release/)
 assert.doesNotMatch(customer,/Frontend build \{short\(installedSha\)\}/)
 assert.match(updates,/function displayVersion\(value\)\{return publishedCustomerVersion\(value\)\|\|''\}/)
 // Developer commit selection is explicitly left intact, not shown to customers.
 assert.match(updates,/DevReleaseEditor/)
 assert.match(updates,/Verified GitHub commit/)
})
