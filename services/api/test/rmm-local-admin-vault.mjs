import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  protectLocalAdminPassword,revealLocalAdminPassword,validLocalAdminPassword,
  validateDedicatedLocalAdminName,revealMfaRecent,rotationMetadata,
} from '../src/rmmLocalAdminVaultCrypto.js'
process.env.RMM_LOCAL_ADMIN_VAULT_KEY=randomBytes(32).toString('hex')
const context={tenantId:randomUUID(),agentId:randomUUID(),accountId:randomUUID(),rotationId:randomUUID()}
const password='AbcdefGHIJKLmnopqr23456789!@#$%&*_-+'
test('encrypts recovery credentials with AES-256-GCM and tenant/record-bound AAD',()=>{
  const e1=protectLocalAdminPassword(password,context)
  const e2=protectLocalAdminPassword(password,context)
  assert.notEqual(e1,e2)
  assert.doesNotMatch(e1,/AbcdefGHIJ/)
  assert.equal(revealLocalAdminPassword(e1,context),password)
  assert.equal(revealLocalAdminPassword(e2,context),password)
})
test('refuses cross-tenant and cross-account ciphertext use',()=>{
  const envelope=protectLocalAdminPassword(password,context)
  assert.throws(()=>revealLocalAdminPassword(envelope,{...context,tenantId:randomUUID()}))
  assert.throws(()=>revealLocalAdminPassword(envelope,{...context,agentId:randomUUID()}))
  assert.throws(()=>revealLocalAdminPassword(envelope,{...context,accountId:randomUUID()}))
  assert.throws(()=>revealLocalAdminPassword(envelope,{...context,rotationId:randomUUID()}))
})
test('rejects ciphertext tampering and malformed key material',()=>{
  const envelope=protectLocalAdminPassword(password,context)
  const parts=envelope.split('.')
  parts[2]=parts[2][0]==='A'?'B'+parts[2].slice(1):'A'+parts[2].slice(1)
  assert.throws(()=>revealLocalAdminPassword(parts.join('.'),context))
  assert.throws(()=>revealLocalAdminPassword('random-string',context))
})
test('requires a long complexity-compliant generated password',()=>{
  assert.equal(validLocalAdminPassword(password),true)
  assert.equal(validLocalAdminPassword('short'),false)
  assert.equal(validLocalAdminPassword('AlllettersonlywouldneverbeacceptedAAAA'),false)
  assert.equal(validLocalAdminPassword(password+' '),false)
})
test('restricts management to a new dedicated account',()=>{
  assert.equal(validateDedicatedLocalAdminName('Hi5Recovery'),'Hi5Recovery')
  for(const name of ['Administrator','Guest','Hi5Administrator','adm','Hi5','Hi5 admin']) {
    assert.throws(()=>validateDedicatedLocalAdminName(name))
  }
})
test('requires a recent session MFA verification and rejects API-token sessions',()=>{
  const now=Date.now()
  const fresh={session_id:randomUUID(),mfa_verified_at:new Date(now-60_000)}
  assert.equal(revealMfaRecent(fresh,now),true)
  assert.equal(revealMfaRecent({...fresh,mfa_verified_at:new Date(now-8*60_000)},now),false)
  assert.equal(revealMfaRecent({...fresh,session_id:null},now),false)
})
test('API metadata never includes password or ciphertext',()=>{
  const rotation={id:randomUUID(),state:'active',credential_ciphertext:protectLocalAdminPassword(password,context),revealed_at:null,reveal_count:0,created_at:new Date()}
  assert.doesNotMatch(JSON.stringify(rotationMetadata(rotation)),/credential_ciphertext|AbcdefGHIJ/)
})
