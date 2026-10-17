// CI-only real PostgreSQL check for the SHA-scoped release editor.
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import {randomBytes,randomUUID} from 'node:crypto'
import {saveCustomerReleaseDraft,publishCustomerReleaseNotes,
 readCustomerReleasePreparation} from '../src/customerReleasePreparation.js'

const url=new URL(process.env.DATABASE_URL||'postgres://invalid/invalid')
if(url.pathname!=='/hi5_rollout_ci'||!['localhost','127.0.0.1'].includes(url.hostname))
 throw Error('Release draft Postgres test refuses any non-disposable CI database.')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2})
test('SHA-scoped editable drafts, immutable publish and atomic rollback in real PostgreSQL',async()=>{
 const client=await pool.connect()
 const sha=randomBytes(20).toString('hex')
 const actor=randomUUID()
 const notes={versionLabel:'2026.10.17',title:'Customer release verification',
  summary:'CI-only immutable application notes',entries:[
   {category:'feature',title:'Release queue improvements',description:'Exact staged tenant scheduling.'},
  ]}
 try{
  await client.query('BEGIN')
  const table=await client.query("SELECT to_regclass('public.platform_release_preparation_drafts') AS rel")
  assert(table.rows[0].rel,'Migration 171 must exist in the isolated schema')
  const saved=await saveCustomerReleaseDraft(client,{sha,actorId:actor,notes})
  assert.equal(saved.buildSha,sha)
  assert.equal(saved.notes.entries[0].category,'feature')
  const read=await readCustomerReleasePreparation(client,{sha})
  assert.equal(read.draft.title,notes.title)
  assert.equal(read.published,null)
  const publication=await publishCustomerReleaseNotes(client,{sha})
  assert.equal(publication.alreadyPublished,false)
  assert.equal((await publishCustomerReleaseNotes(client,{sha,notes})).alreadyPublished,true)
  await assert.rejects(saveCustomerReleaseDraft(client,{
   sha,actorId:actor,notes:{...notes,title:'Other'}}),/immutable/)
  await assert.rejects(publishCustomerReleaseNotes(client,{
   sha,notes:{...notes,title:'Other'}}),/immutable/)
  const published=await readCustomerReleasePreparation(client,{sha})
  assert.equal(published.published.title,notes.title)
  await client.query('ROLLBACK')
  assert.equal((await pool.query(
   'SELECT count(*)::int n FROM platform_release_preparation_drafts WHERE build_sha=$1',
   [sha])).rows[0].n,0,'CI editor smoke must leave no persistent draft')
  assert.equal((await pool.query(
   'SELECT count(*)::int n FROM hi5central_published_release_notes WHERE build_sha=$1',
   [sha])).rows[0].n,0,'CI must not publish any persistent release')
 }finally{
  await client.query('ROLLBACK').catch(()=>{})
  client.release()
  await pool.end()
 }
})
