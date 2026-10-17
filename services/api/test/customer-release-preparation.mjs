import test from 'node:test'
import assert from 'node:assert/strict'
import {normaliseCustomerReleaseDraft,saveCustomerReleaseDraft,
 readCustomerReleasePreparation,publishCustomerReleaseNotes} from '../src/customerReleasePreparation.js'
import {listOfficialReleaseCandidates} from '../src/officialReleaseCertification.js'

const sha='a'.repeat(40)
const actorId='ea124f44-223f-440b-8827-9b40d0000001'
const notes={versionLabel:'1.2.3',title:'Incident and service request improvements',
 summary:'Customer-facing improvements',entries:[{category:'feature',
 title:'Improved incident assignment',description:'Use the updated panel.'}]}
const rows=({published=null,draft=null}={})=>{
 const statements=[],insertions=[]
 const db={query:async(sql,args=[])=>{
  const q=String(sql);statements.push(q)
  if(q.includes("pg_advisory_xact_lock"))return {rows:[{}],rowCount:1}
  if(q.includes('FROM hi5central_published_release_notes')&&q.includes('FOR UPDATE'))
   return {rows:published?[published]:[],rowCount:published?1:0}
  if(q.includes('SELECT build_sha FROM hi5central_published_release_notes'))
   return {rows:published?[{build_sha:sha}]:[],rowCount:published?1:0}
  if(q.includes('SELECT notes FROM platform_release_preparation_drafts'))
   return {rows:draft?[{notes:draft}]:[],rowCount:draft?1:0}
  if(q.includes('SELECT notes,edited_at FROM platform_release_preparation_drafts'))
   return {rows:draft?[{notes:draft,edited_at:new Date()}]:[],rowCount:draft?1:0}
  if(q.includes('SELECT version_label,title,summary,entries,published_at'))
   return {rows:published?[published]:[],rowCount:published?1:0}
  if(q.startsWith('INSERT INTO hi5central_published_release_notes')){
   insertions.push({type:'published',args});return {rows:[],rowCount:1}
  }
  if(q.startsWith('INSERT INTO platform_release_preparation_drafts')){
   insertions.push({type:'draft',args})
   return {rows:[{notes:JSON.parse(args[1]),edited_at:new Date()}],rowCount:1}
  }
  throw Error('Unexpected statement: '+q)
 }}
 return {db,statements,insertions}
}
test('incomplete notes save by exact SHA, never publish or deploy',async()=>{
 const state=rows()
 const result=await saveCustomerReleaseDraft(state.db,{
  sha,actorId,notes:{...notes,title:'',entries:[]}})
 assert.equal(result.notes.title,'')
 assert.equal(state.insertions.length,1)
 assert.equal(state.insertions[0].type,'draft')
 assert(state.statements.every(q=>!q.includes('tenant_release_rollout_jobs')))
})
test('valid release notes publish exactly once and retain immutable entries',async()=>{
 const state=rows()
 const result=await publishCustomerReleaseNotes(state.db,{sha,notes})
 assert.equal(result.alreadyPublished,false)
 assert.equal(state.insertions[0].type,'published')
 assert.deepEqual(JSON.parse(state.insertions[0].args[4]),notes.entries)
})
test('previously published notes are immutable even with same SHA',async()=>{
 const published={version_label:notes.versionLabel,title:notes.title,
  summary:notes.summary,entries:notes.entries}
 const same=rows({published})
 assert.equal((await publishCustomerReleaseNotes(same.db,{sha,notes})).alreadyPublished,true)
 assert.equal(same.insertions.length,0)
 const changed=rows({published})
 await assert.rejects(publishCustomerReleaseNotes(changed.db,{
  sha,notes:{...notes,title:'Different release title'}}),/immutable/)
 assert.equal(changed.insertions.length,0)
})
test('draft read includes an independently published immutable release',async()=>{
 const published={version_label:notes.versionLabel,title:notes.title,
  summary:notes.summary,entries:notes.entries,published_at:new Date()}
 const result=await readCustomerReleasePreparation(rows({draft:notes,published}).db,{sha})
 assert.equal(result.draft.versionLabel,notes.versionLabel)
 assert.equal(result.published.title,notes.title)
})
test('invalid SHA, unsupported category or missing mandatory publish entry are denied',async()=>{
 assert.throws(()=>normaliseCustomerReleaseDraft({
  sha:'oops',notes}),/exact GitHub commit/)
 assert.throws(()=>normaliseCustomerReleaseDraft({
  sha,notes:{...notes,entries:[{category:'admin',title:'Unsupported'}]}}),/Unsupported/)
 await assert.rejects(publishCustomerReleaseNotes(rows().db,{
  sha,notes:{...notes,entries:[]}}),/between 1 and 35/)
})
test('read-only GitHub candidate picker excludes failed or unrelated workflows',async()=>{
 const response={status:200,ok:true,json:async()=>({workflow_runs:[
  {id:123456,head_sha:sha,status:'completed',conclusion:'success',
   name:'Real Hi5Central Dev Release Candidate (QA)',head_branch:'develop',
   created_at:'2026-10-17T10:00:00Z'},
  {id:123457,head_sha:'b'.repeat(40),status:'completed',conclusion:'failure',
   name:'Real Hi5Central Dev Release Candidate (QA)'},
  {id:123458,head_sha:'c'.repeat(40),status:'completed',conclusion:'success',
   name:'Unrelated build'},
 ]})}
 const seen=[]
 const candidates=await listOfficialReleaseCandidates({
  fetcher:async(url,options)=>{seen.push({url,options});return response},
 })
 assert.equal(candidates.length,1)
 assert.equal(candidates[0].buildSha,sha)
 assert.match(candidates[0].ciRunUrl,/actions\/runs\/123456$/)
 assert.equal(seen[0].options.redirect,'error')
})
