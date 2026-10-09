/**
 * Regression checks for the tenant-scoped, combined task queue without
 * requiring a live database.
 *
 * Run: node scripts/test-unified-task-queue.mjs
 */
import assert from 'node:assert/strict'
import { unifiedTaskQueue, projectTeamVisibilitySql } from '../src/unifiedTaskQueue.js'

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const person = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const team = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const viewer = { id: person, team_ids: [team], external_key:'USR-001', name:'Test Technician', email:'test@example.invalid' }

function mockDatabase() {
  const queries = []
  return {
    queries,
    async query(sql, params) {
      queries.push({sql,params})
      if (sql.includes('SELECT q.* FROM queue q WHERE')) return {rows:[
        {id:'PRJ-00001-T01',source:'project',title:'Test project work',status:'To Do',priority:'High',assignee:'Test Technician',assignee_email:viewer.email,team:'Unassigned',due_at:null,updated_at:new Date(),parent_id:'PRJ-00001',parent_title:'Example project'},
      ]}
      if (sql.includes('SELECT count(*)::int total FROM queue')) return {rows:[{total:1}]}
      return {rows:[{all:1,mine:1,team:1,project:1,unassigned:0,blocked:0,completed:0,statuses:['To Do'],priorities:['High'],teams:['Unassigned'],assignees:['Test Technician'],services:['Project']}]}
    },
  }
}
function paramsOf(object) { return (key) => object[key] }
async function check(label, scope, access, assertions) {
  const db = mockDatabase()
  const result = await unifiedTaskQueue({tenant_id:tenant,name:'Test',email:viewer.email,access:{permissions:access}},paramsOf({scope,limit:'25',offset:'0'}),viewer,db)
  assert.equal(result.total,1,label+' total')
  assert.equal(result.items[0].source,'project',label+' source')
  assert.equal(result.items[0].project.id,'PRJ-00001',label+' parent')
  assert.equal(result.views.project,1,label+' project count')
  assert.equal(db.queries.length,3,label+' queries')
  const page = db.queries.find(item=>item.sql.includes('SELECT q.* FROM queue q WHERE'))
  const count = db.queries.find(item=>item.sql.includes('SELECT count(*)::int total FROM queue'))
  assert.ok(page,label+' page query')
  assert.ok(count,label+' count query')
  assert.deepEqual(page.params.slice(0,3),[tenant,person,[team]],label+' tenant viewer params')
  assert.deepEqual(page.params.slice(-2),[25,0],label+' pagination params')
  assertions(page.sql,count.sql)
  console.log('PASS '+label)
}
assert.match(projectTeamVisibilitySql,/q\.assignee_person_id=\$2::uuid/,'assignment to logged-in user')
assert.match(projectTeamVisibilitySql,/organisation_team_memberships/,'assignees team memberships')
assert.match(projectTeamVisibilitySql,/assignment_team\.tenant_id=\$1/,'team lookup tenant scoping')
console.log('PASS assigned task/team visibility SQL')
await check('Team Queue includes assigned project tasks','team',['itsm.tasks.view','projects.view'],(page,count)=>{
  for (const sql of [page,count]) {
    assert.match(sql,/q\.team_id=ANY\(\$3::uuid\[\]\)/)
    assert.match(sql,/q\.assignee_person_id=\$2::uuid/)
    assert.match(sql,/assignment_team\.person_id=q\.assignee_person_id/)
  }
})
await check('My Tasks uses assigned technician','mine',['itsm.tasks.view','projects.view'],(page)=>{
  assert.match(page,/q\.assignee_person_id=\$2::uuid/)
})
await check('Project Tasks view returns all active projects','project',['itsm.tasks.view','projects.view'],(page)=>{
  assert.match(page,/q\.source='project'/)
  assert.match(page,/NOT q\.is_complete/)
})
{
  const db = mockDatabase()
  const result = await unifiedTaskQueue(
    {tenant_id:tenant,access:{permissions:['itsm.tasks.view']}},
    paramsOf({scope:'project'}),viewer,db,
  )
  const page = db.queries.find(item=>item.sql.includes('SELECT q.* FROM queue q WHERE'))
  assert.match(page.sql,/AND FALSE/,'project source cannot be queried without projects.view')
  assert.deepEqual(result.filters.sources,['service-request'])
  console.log('PASS project source suppressed without projects.view')
}
{
  const db = mockDatabase()
  const invalid = await unifiedTaskQueue({tenant_id:tenant,access:{permissions:['*']}},paramsOf({scope:'invalid'}),viewer,db)
  assert.match(invalid.error,/Unsupported task queue/)
  assert.equal(db.queries.length,0)
  console.log('PASS invalid scope rejected before SQL')
}
console.log('Unified Tasks queue tests: 6/6 passed')
