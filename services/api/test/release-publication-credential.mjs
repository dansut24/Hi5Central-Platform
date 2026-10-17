import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {publicationBearerAuthorised,publicationTokenDigests,publicationShaAuthorised,automaticDevPublicationEnabled} from '../src/releasePublicationCredential.js'

const active='A'.repeat(63)+'9', next='B'.repeat(63)+'2'
const sha=v=>createHash('sha256').update(v).digest('hex')
const settings={RELEASE_PUBLICATION_TOKEN_SHA256:sha(active)}
test('Dedicated publication bearer matches only its configured SHA256 hash',()=>{
  assert.deepEqual(publicationTokenDigests(settings),[sha(active)])
  assert.equal(publicationBearerAuthorised('Bearer '+active,settings),true)
  assert.equal(publicationBearerAuthorised('Bearer '+next,settings),false)
  assert.equal(publicationBearerAuthorised('Bearer '+active.slice(1),settings),false)
  assert.equal(publicationBearerAuthorised('Basic '+active,settings),false)
})
test('Rotation accepts either dedicated digest temporarily and rejects previous after cutover',()=>{
  const rotation={...settings,RELEASE_PUBLICATION_TOKEN_SHA256_NEXT:sha(next)}
  assert.equal(publicationBearerAuthorised('Bearer '+active,rotation),true)
  assert.equal(publicationBearerAuthorised('Bearer '+next,rotation),true)
  assert.equal(publicationBearerAuthorised('Bearer '+active,{RELEASE_PUBLICATION_TOKEN_SHA256:sha(next)}),false)
  assert.equal(publicationBearerAuthorised('Bearer '+next,{RELEASE_PUBLICATION_TOKEN_SHA256:sha(next)}),true)
})
test('Missing or malformed digest never falls back to general release operator bearer',()=>{
  const broadToken='Z'.repeat(64)
  for(const invalid of [
    {},{RELEASE_OPERATOR_TOKEN:broadToken},
    {RELEASE_PUBLICATION_TOKEN_SHA256:'bad'},
    {RELEASE_PUBLICATION_TOKEN_SHA256:sha(active),RELEASE_PUBLICATION_TOKEN_SHA256_NEXT:'broken'},
    {RELEASE_PUBLICATION_TOKEN_SHA256:sha(active).toUpperCase()},
  ]){
    assert.deepEqual(publicationTokenDigests(invalid),[])
    assert.equal(publicationBearerAuthorised('Bearer '+active,invalid),false)
    assert.equal(publicationBearerAuthorised('Bearer '+broadToken,invalid),false)
  }
})
test('Reject short, multiline, malformed and partial publication bearer values',()=>{
  for(const bad of [
    null,undefined,'','Bearer ','Bearer '+'short',
    'Bearer '+active+'\n',
    'bearer '+active,'Bearer '+active+' ',
    'Bearer '+active+'!', 'Bearer '+active+'\r\n',
  ])assert.equal(publicationBearerAuthorised(bad,settings),false)
})

test('Publication token is bound to exactly one immutable QA Dev build SHA',()=>{
  const allowed='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
  const settings={RELEASE_PUBLICATION_ALLOWED_SHA:allowed}
  assert.equal(publicationShaAuthorised(allowed,settings),true)
  for(const other of [
    '',null,undefined,'latest',allowed.toUpperCase(),
    '4a363cf9054b0b3667fd450f36e354b704ec2166',
  ])assert.equal(publicationShaAuthorised(other,settings),false)
  assert.equal(publicationShaAuthorised(allowed,{}),false)
  assert.equal(publicationShaAuthorised(allowed,{RELEASE_PUBLICATION_ALLOWED_SHA:'*'}),false)
})

test('Automatic publisher is opt-in with an exact mode, never a wildcard',()=>{
  assert.equal(automaticDevPublicationEnabled({
    RELEASE_PUBLICATION_ALLOWED_SHA:'verified-dev',
    RELEASE_PUBLICATION_AUTOMATIC:'true',
  }),true)
  for(const settings of [
    {},{RELEASE_PUBLICATION_ALLOWED_SHA:'*',RELEASE_PUBLICATION_AUTOMATIC:'true'},
    {RELEASE_PUBLICATION_ALLOWED_SHA:'verified-dev'},
    {RELEASE_PUBLICATION_ALLOWED_SHA:'verified-dev',RELEASE_PUBLICATION_AUTOMATIC:'yes'},
    {RELEASE_PUBLICATION_ALLOWED_SHA:'9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0',
      RELEASE_PUBLICATION_AUTOMATIC:'true'},
  ])assert.equal(automaticDevPublicationEnabled(settings),false)
  assert.equal(publicationShaAuthorised('a'.repeat(40),
    {RELEASE_PUBLICATION_ALLOWED_SHA:'verified-dev',
      RELEASE_PUBLICATION_AUTOMATIC:'true'}),false,
    'Auto mode never weakens the original single-SHA authorisation')
})
