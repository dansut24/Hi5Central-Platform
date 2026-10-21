import test from 'node:test'
import assert from 'node:assert/strict'
import {correctPublishedReleaseVersion} from '../src/publishedReleaseVersionCorrection.js'

const input={
 buildSha:'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
 expectedVersionLabel:'2026.10.20.1',
 newVersionLabel:'2026.10.21.1',
 reason:'Release numbers must be unique',
 confirmation:'CORRECT_HI5CENTRAL_RELEASE_NUMBER',
 actorId:'11111111-1111-4111-8111-111111111111',
 sessionId:'22222222-2222-4222-8222-222222222222',
}

function fixture({conflict=false,stale=false}={}){
 const sql=[]
 const db={async query(statement,params){
  sql.push({statement,params})
  if(statement.includes('pg_advisory_xact_lock'))return {rowCount:1,rows:[]}
  if(statement.includes('FOR UPDATE'))return {rowCount:1,
    rows:[{version_label:stale?'2026.10.20.2':'2026.10.20.1',title:'Improvements'}]}
  if(statement.startsWith('SELECT 1'))return {rowCount:conflict?1:0,rows:conflict?[{}]:[]}
  if(statement.startsWith('UPDATE '))return {rowCount:1,rows:[{title:'Improvements'}]}
  if(statement.startsWith('INSERT '))return {rowCount:1,rows:[]}
  throw Error('Unexpected statement')
 }}
 return {db,sql}
}

test('correction updates the label and inserts two audit records',async()=>{
 const {db,sql}=fixture()
 const result=await correctPublishedReleaseVersion(db,input)
 assert.equal(result.versionLabel,'2026.10.21.1')
 assert.equal(result.deploymentsStarted,0)
 assert.equal(sql.filter(q=>q.statement.startsWith('INSERT ')).length,2)
 assert.equal(sql.filter(q=>q.statement.startsWith('UPDATE ')).length,1)
})
test('existing target and stale expected version refuse the edit',async()=>{
 for(const opts of [{conflict:true},{stale:true}]){
  const {db,sql}=fixture(opts)
  await assert.rejects(correctPublishedReleaseVersion(db,input))
  assert.equal(sql.some(q=>q.statement.startsWith('UPDATE ')),false)
 }
})
test('reason and authenticated session are required',async()=>{
 for(const change of [{reason:'short'},{sessionId:''},{actorId:''},{confirmation:'NO'},
  {newVersionLabel:'2026.10.20.1'}]){
  const {db,sql}=fixture()
  await assert.rejects(correctPublishedReleaseVersion(db,{...input,...change}))
  assert.equal(sql.length,0)
 }
})
