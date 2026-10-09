import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const snippet=readFileSync(new URL('./public-ingress-deny.caddy',import.meta.url),'utf8')
const matcher=snippet.match(/^@unapprovedSandbox expression \{http\.request\.host\}\.matches\('([^']+)'\)$/m)
if(!matcher)throw new Error('Public gateway deny matcher missing or replaced')
const pattern=matcher[1]
if(!pattern.startsWith('(?i)'))throw new Error('Case-insensitive host validation is mandatory')
const reserved=new RegExp(pattern.slice(4),'i')
const fallback=readFileSync(new URL('./public-ingress-unknown-host.caddy',import.meta.url),'utf8')

test('public gateway snippet must use a first-class handle, not a late-sorted respond',()=>{
  assert.match(snippet,/handle @unapprovedSandbox\s*\{\s*respond "Not Found" 404\s*\}/)
  assert.doesNotMatch(snippet,/^respond @unapprovedSandbox/m)
  assert.ok(snippet.includes('BEFORE all @managed'))
})
test('unapproved UAT/Test customer workspace and Portal/RMM/API paths fail closed',()=>{
  for(const host of [
    'acmeuat.hi5central.com','acmetest.hi5central.com',
    'acmeuat-portal.hi5central.com','acmetest-portal.hi5central.com',
    'acmeuat-rmm.hi5central.com','acmetest-rmm.hi5central.com',
    'acmeuat-api.hi5central.com','acmetest-admin.hi5central.com',
    'acmeuat-connect.hi5central.com','acmetest-turn.hi5central.com',
    'pilot-uat-api.hi5central.com','pilot-test-api.hi5central.com',
    'pilot-acmeuat.hi5central.com','pilot-unapproved.hi5central.com',
  ])assert.equal(reserved.test(host),true,host)
})
test('explicit legacy, engineering Dev, Production and normal tenant routes remain permitted',()=>{
  for(const host of [
    'hi5central.com','www.hi5central.com',
    'api.hi5central.com','rmm.hi5central.com','admin.hi5central.com',
    'dev.hi5central.com','dev-api.hi5central.com','dev-rmm.hi5central.com',
    'dev-admin.hi5central.com','test2.hi5central.com',
    'uat.hi5central.com','uat-api.hi5central.com','uat-rmm.hi5central.com',
    'test.hi5central.com','test-api.hi5central.com',
    'test-rmm.hi5central.com','test-admin.hi5central.com',
    'acme.hi5central.com','acme-portal.hi5central.com',
    'acme-rmm.hi5central.com','othercompany.hi5central.com',
  ])assert.equal(reserved.test(host),false,host)
})
test('mixed-case host headers and trailing dots never bypass customer-prefix denial',()=>{
  for(const host of [
    'PiLoT-UaT-Api.Hi5Central.Com',
    'PILOTEXAMPLEUAT.HI5CENTRAL.COM',
    'pilot-uat-api.hi5central.com.',
    'pilotexampleuat.hi5central.com.',
    'AcMeTeSt-RmM.Hi5Central.Com.',
  ])assert.equal(reserved.test(host),true,host)
})
test('public TLS catchall must explicitly reject unmatched virtual hosts without a new CA',()=>{
  assert.match(fallback,/^https:\/\/:443\s*\{\s*respond "Misdirected Request" 421\s*\}/m)
  assert.doesNotMatch(fallback,/tls\s+internal/)
  assert.match(fallback,/OUTSIDE/)
})
test('host denial expressions cannot be escaped with suffix or second-level host trickery',()=>{
  for(const host of [
    'acmeuat.hi5central.com.attacker.invalid','acmetest.hi5central.com.evil',
    'evil.pilot-uat-api.hi5central.com','uat.hi5central.com.attacker.invalid',
  ])assert.equal(reserved.test(host),false,host)
})
