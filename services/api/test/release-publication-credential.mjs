import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {publicationBearerAuthorised,publicationTokenDigests} from '../src/releasePublicationCredential.js'

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
