import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readOperatorTrustFile, verifyOperatorPair } from '../src/managedOperatorEvidence.js'

const signer=fileURLToPath(new URL('../scripts/tenant-environment-sign-attestation.mjs',import.meta.url))
const uuids={
  controlRequestId:'11111111-1111-4111-8111-111111111111',
  localTenantId:'22222222-2222-4222-8222-222222222222',
  databaseInstanceId:'33333333-3333-4333-8333-333333333333',
  redisInstanceId:'44444444-4444-4444-8444-444444444444',
}
const scope={action:'approve',actor:'operator-one',reviewer:'reviewer-one',
  tenantSlug:'acme',environment:'uat',...uuids}

test('three independent ephemeral operator keys sign verified, tenant-scoped assertions',t=>{
  const directory=mkdtempSync(join(tmpdir(),'h5-offline-operator-'))
  t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const people=[
    {id:'operator-one',roles:['operator']},
    {id:'reviewer-one',roles:['reviewer']},
    {id:'operator-two',roles:['executor','operator']},
  ]
  for(const person of people){
    const pair=generateKeyPairSync('ed25519')
    person.keyId='ci-'+person.id
    person.publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'})
    person.keyFile=join(directory,person.id+'.private.pem')
    writeFileSync(person.keyFile,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600})
  }
  const trustFile=join(directory,'trust.json')
  writeFileSync(trustFile,JSON.stringify({version:1,
    principals:people.map(({id,keyId,publicKeyPem,roles})=>({id,keyId,publicKeyPem,roles}))}),{mode:0o600})
  const trust=readOperatorTrustFile(trustFile)
  function offline(person,role,action='approve',env='uat'){
    const output=join(directory,randomBytes(8).toString('hex')+'.assertion')
    const result=spawnSync(process.execPath,[signer,'--sign'],{
      encoding:'utf8',timeout:5000,
      env:{...process.env,SANDBOX_SIGNING_PRIVATE_KEY_FILE:person.keyFile,
        SANDBOX_SIGNING_OUTPUT_FILE:output,SANDBOX_SIGNING_KEY_ID:person.keyId,
        SANDBOX_SIGNING_OPERATOR_ID:person.id,SANDBOX_SIGNING_ROLE:role,
        SANDBOX_SIGNING_ACTION:action,TENANT_SLUG:'acme',
        TARGET_ENVIRONMENT:env,PROVISION_REQUEST_ID:uuids.controlRequestId,
        LOCAL_TENANT_ID:uuids.localTenantId,
        DATABASE_INSTANCE_ID:uuids.databaseInstanceId,
        REDIS_INSTANCE_ID:uuids.redisInstanceId},
    })
    assert.equal(result.status,0,result.stderr)
    const token=readFileSync(output,'utf8').trim()
    assert.ok(token.startsWith('{"keyId":'))
    assert.ok(!result.stdout.includes(token),'Signature must never appear in console output')
    assert.equal(statSync(output).mode&0o077,0,'Assertion must be owner-only')
    return token
  }
  const actorToken=offline(people[0],'operator')
  const reviewerToken=offline(people[1],'reviewer')
  const pair=verifyOperatorPair({actorToken,reviewerToken,trust,expected:scope})
  assert.equal(pair.actor.operatorId,'operator-one')
  assert.equal(pair.reviewer.operatorId,'reviewer-one')
  assert.match(pair.actor.digest,/^[a-f0-9]{64}$/)
  assert.notEqual(pair.actor.keyId,pair.reviewer.keyId)

  assert.throws(()=>verifyOperatorPair({actorToken,reviewerToken,trust,
    expected:{...scope,environment:'test'}}),/attestation/i)
  assert.throws(()=>verifyOperatorPair({actorToken,reviewerToken,trust,
    expected:{...scope,databaseInstanceId:uuids.redisInstanceId}}),/attestation/i)
  const altered=JSON.parse(reviewerToken)
  altered.signature=(altered.signature[0]==='A'?'B':'A')+altered.signature.slice(1)
  assert.throws(()=>verifyOperatorPair({actorToken,reviewerToken:JSON.stringify(altered),trust,
    expected:scope}),/attestation/i)
  assert.throws(()=>verifyOperatorPair({actorToken,reviewerToken,trust,
    expected:scope,now:new Date(Date.now()+300000)}),/attestation/i)
  assert.throws(()=>verifyOperatorPair({actorToken,reviewerToken:actorToken,trust,
    expected:scope}),/attestation/i)
  const otherEnv=offline(people[1],'reviewer','approve','test')
  assert.throws(()=>verifyOperatorPair({actorToken,reviewerToken:otherEnv,trust,
    expected:scope}),/attestation/i)

  chmodSync(trustFile,0o666)
  assert.throws(()=>readOperatorTrustFile(trustFile),/attestation/i)
  chmodSync(trustFile,0o600)
  const duplicate=join(directory,'duplicate-trust.json')
  const aliases={version:1,principals:people.map(({id,keyId,publicKeyPem,roles})=>({
    id,keyId,publicKeyPem,roles,
  }))}
  aliases.principals[2].publicKeyPem=aliases.principals[0].publicKeyPem
  writeFileSync(duplicate,JSON.stringify(aliases),{mode:0o600})
  assert.throws(()=>readOperatorTrustFile(duplicate),/attestation/i)
})

test('offline signer refuses incorrectly protected private signing keys',t=>{
  const directory=mkdtempSync(join(tmpdir(),'h5-unsafe-operator-'))
  t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const pair=generateKeyPairSync('ed25519')
  const key=join(directory,'unsafe.pem')
  writeFileSync(key,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o644})
  const r=spawnSync(process.execPath,[signer,'--sign'],{encoding:'utf8',timeout:5000,
    env:{...process.env,SANDBOX_SIGNING_PRIVATE_KEY_FILE:key,
      SANDBOX_SIGNING_OUTPUT_FILE:join(directory,'assertion.json')}})
  assert.notEqual(r.status,0)
  assert.match(r.stderr,/owner-only/)
})
