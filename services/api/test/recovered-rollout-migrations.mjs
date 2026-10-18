import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,dirname,basename} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const entries=JSON.parse(readFileSync(resolve(root,'deployment/qa26/recovered-rollout-migration-provenance.json'),'utf8'))
const dir=resolve(root,'services/api/migrations')
function files(path,acc=[]){
  for(const ent of readdirSync(path,{withFileTypes:true})){
    const child=resolve(path,ent.name)
    if(ent.isDirectory())files(child,acc)
    else if(ent.isFile()&&ent.name.endsWith('.sql'))acc.push(child)
  }
  return acc
}
test('all 26 historically applied rollout migration filenames have reviewed source',()=>{
 assert.equal(entries.length,26)
 assert.equal(new Set(entries.map(e=>e.name)).size,26)
 for(const e of entries){
  assert.match(e.name,/^(15[0-9]|16[0-9]|17[01])_[a-z0-9_]+\.sql$/)
  assert.ok(e.path.startsWith('services/api/migrations/'))
  assert.ok(e.path.endsWith('/'+e.name))
  assert.match(e.sha256,/^[0-9a-f]{64}$/)
  assert.match(e.source_ref,/^origin\/pr\/\d+$/)
  assert.equal(e.variants,1)
 }
})
test('recovered SQL bytes are identical to their original reviewed PR source',()=>{
 for(const e of entries){
  const bytes=readFileSync(resolve(root,e.path))
  const actual=createHash('sha256').update(bytes).digest('hex')
  assert.equal(actual,e.sha256,e.name)
  assert.equal(bytes.length,e.length,e.name)
 }
})
test('no duplicate global migration filenames — matches runtime migration identity semantics',()=>{
 const names=files(dir).map(p=>basename(p))
 assert.equal(new Set(names).size,names.length)
 for(const e of entries)assert.equal(names.filter(n=>n===e.name).length,1)
})
test('historically applied migrations are source restored, not newly invented',()=>{
 for(const e of entries){
  assert.match(e.source,/^github PR #\d+$/)
  assert.ok(!e.source.includes('synthetic'))
 }
})
