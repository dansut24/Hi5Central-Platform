import test from 'node:test'
import assert from 'node:assert/strict'
import {relayOneRequestedRelease,runRelayCycle,pinnedDevDatabaseUrl,verifyCentralPublicationCredential} from '../src/releasePublicationRelay.mjs'
const sha='9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0'
const token='x'.repeat(64),authority='http://hi5central-api:3001'
const data={
  build_sha:sha,version_label:'2026.10.15',title:'October 2026 Platform Update',
  summary:'Improvements to ITSM release and configuration management.',
  status:'publication_requested',requested_at:'2026-10-15T21:27:42.797Z',
  edited_by:'860dbd10-a968-4029-a724-fe6b2f697a8b',
  entries:[{title:'ITSM settings audit history',category:'improvement',
    description:'Previous and current values where available.'}],
}
const asExpected={
  buildSha:sha,versionLabel:data.version_label,title:data.title,
  summary:data.summary,entries:data.entries,
}
function scenario({changed=false,centralFails=false,readbackFails=false,selected=data}={}){
  let posted=0,updated=0;
  const db={query:async(q,args)=>{
    if(q.startsWith('SELECT build_sha'))return {rowCount:selected?1:0,rows:selected?[selected]:[]}
    if(q.startsWith('UPDATE hi5central_release_note_drafts')){
      updated++;
      assert.deepEqual(args.slice(0,1),[sha]);
      assert.equal(args[6],data.requested_at);
      return {rowCount:changed?0:1,rows:changed?[]:[{build_sha:sha,status:'published'}]}
    }
    throw Error('Unexpected SQL '+q)
  }}
  const fetcher=async(url,opts)=>{
    if(url.endsWith('/releases/publish')){
      posted++;
      assert.equal(opts.method,'POST')
      assert.equal(opts.headers.Authorization,'Bearer '+token)
      assert.deepEqual(JSON.parse(opts.body),asExpected)
      return {ok:!centralFails,status:centralFails?503:201,
        json:async()=>centralFails?{error:'Unavailable'}:{published:true,buildSha:sha}}
    }
    assert.equal(url,authority+'/api/v1/updates/published')
    return {ok:true,status:200,json:async()=>({
      releases:[{...asExpected,publishedAt:'2026-10-15T21:29:00.000Z',
        ...(readbackFails?{title:'Tampered'}:{})}],
    })}
  }
  return {db,fetcher,counters:()=>({posted,updated})}
}
test('Trusted Dev-requested release is posted, verified and acknowledged once',async()=>{
  const s=scenario()
  const a=await relayOneRequestedRelease({db:s.db,fetcher:s.fetcher,authority,
    token,allowedSha:sha})
  assert.equal(a.status,'published')
  assert.deepEqual(s.counters(),{posted:1,updated:1})
})
test('Missing explicit Dev publication request never calls central',async()=>{
  const s=scenario({selected:null})
  const a=await relayOneRequestedRelease({db:s.db,fetcher:s.fetcher,authority,
    token,allowedSha:sha})
  assert.equal(a.status,'no_pending')
  assert.deepEqual(s.counters(),{posted:0,updated:0})
})
test('Central publisher failure never marks Dev notes published',async()=>{
  const s=scenario({centralFails:true})
  await assert.rejects(()=>relayOneRequestedRelease({db:s.db,fetcher:s.fetcher,
    authority,token,allowedSha:sha}),/refused/)
  assert.deepEqual(s.counters(),{posted:1,updated:0})
})
test('Central readback mismatch keeps Dev pending (no false publication)',async()=>{
  const s=scenario({readbackFails:true})
  await assert.rejects(()=>relayOneRequestedRelease({db:s.db,fetcher:s.fetcher,
    authority,token,allowedSha:sha}),/did not match/)
  assert.deepEqual(s.counters(),{posted:1,updated:0})
})
test('Concurrent editorial change prevents acknowledgement',async()=>{
  const s=scenario({changed:true})
  await assert.rejects(()=>relayOneRequestedRelease({db:s.db,fetcher:s.fetcher,
    authority,token,allowedSha:sha}),/changed before central acknowledgement/)
})
test('Fail closed on arbitrary authority, missing operator credential or wrong SHA',async()=>{
  const s=scenario()
  for(const invalid of [{authority:'https://untrusted.example'},
    {token:'short'}, {allowedSha:'latest'}])
    await assert.rejects(()=>relayOneRequestedRelease({db:s.db,
      fetcher:s.fetcher,authority,token,allowedSha:sha,...invalid}),/trusted|missing|pinned/)
  assert.deepEqual(s.counters(),{posted:0,updated:0})
})
test('DB transaction rolls back if central API fails; no generic deployment action',async()=>{
  const events=[]
  const s=scenario({centralFails:true})
  const p={connect:async()=>({query:async(q,args)=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(q)){events.push(q);return {rows:[]}}
    if(q.startsWith('SET LOCAL'))return {rows:[]}
    return s.db.query(q,args)
  },release:()=>events.push('release')})}
  await assert.rejects(()=>runRelayCycle({pool:p,fetcher:s.fetcher,
    authority,token,allowedSha:sha}),/refused/)
  assert.deepEqual(events,['BEGIN','ROLLBACK','release'].flatMap((x,i)=>
    i===0?[x]:[x]).filter(Boolean)) // SET statements excluded
})

test('Dual-network relay pins the Dev Postgres container, never the Live DB',()=>{
  const original='postgresql://qa_user:only_for_tests@postgres:5432/hi5central'
  const trusted=pinnedDevDatabaseUrl(original)
  assert.equal(new URL(trusted).hostname,'hi5central-dev-postgres-1')
  assert.equal(new URL(trusted).username,'qa_user')
  assert.equal(pinnedDevDatabaseUrl(trusted),trusted)
  for(const unsafe of [
    'postgresql://qa_user:fake@hi5central-postgres:5432/hi5central',
    'postgresql://qa_user:fake@postgres:5432/production',
    'postgresql://qa_user:fake@localhost:5432/hi5central',
    'postgresql://qa_user:fake@postgres:5433/hi5central',
    'postgresql://postgres:5432/hi5central',
    'not-a-postgres-url',
  ])assert.throws(()=>pinnedDevDatabaseUrl(unsafe),/Dev PostgreSQL|Dev database/)
})

test('Nonpublishing central credential preflight accepts only HTTP 400',async()=>{
  const seen=[]
  const fetcher=async(url,opts)=>{
    seen.push({url,method:opts.method,body:opts.body})
    return {status:400}
  }
  assert.equal(await verifyCentralPublicationCredential({fetcher,
    authority,token}),true)
  assert.deepEqual(seen,[{url:authority+'/api/platform-operator/v1/releases/publish',
    method:'POST',body:'{}'}])
  for(const status of [201,202,204,401,403,404,502]){
    await assert.rejects(()=>verifyCentralPublicationCredential({
      authority,token,fetcher:async()=>({status}),
    }),/preflight failed/)
  }
})
