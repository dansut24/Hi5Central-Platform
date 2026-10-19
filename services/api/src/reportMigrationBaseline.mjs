#!/usr/bin/env node
/**
 * Strictly read-only. Each invocation connects to ONE database and inspects
 * only migration object names, not tenant/customer rows or personal records.
 *
 * Run with the database's scoped read credential:
 *   DATABASE_URL=... node src/reportMigrationBaseline.mjs --report
 *
 * The result is a review artefact. It CANNOT authorise deployment, repair a
 * ledger, or assert that an historical migration was actually executed.
 */
import {readdir,readFile} from 'node:fs/promises'
import {join,dirname,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import {migrationFileFootprint,summariseMigrationFootprint} from './migrationBaselineEvidence.js'
const root=join(dirname(fileURLToPath(import.meta.url)),'../migrations')
const list=async dir=>{
 const entries=await readdir(dir,{withFileTypes:true})
 const files=[]
 for(const entry of entries){
  if(entry.isDirectory())files.push(...await list(join(dir,entry.name)))
  else if(entry.isFile()&&entry.name.endsWith('.sql'))
   files.push(join(dir,entry.name))
 }
 return files
}
export const buildFootprintSources=async()=>{
 const paths=(await list(root)).sort()
 return Promise.all(paths.map(async path=>migrationFileFootprint({
  version:path.split('/').at(-1),
  sourcePath:relative(root,path),sql:await readFile(path,'utf8'),
 })))
}
export async function reportDatabaseBaseline(db){
 await db.query('BEGIN READ ONLY')
 try{
  const [names,identity,files]=await Promise.all([
   db.query([
    "SELECT 'table' AS kind,tablename AS name FROM pg_tables WHERE schemaname='public'",
    "UNION ALL SELECT 'index',indexname FROM pg_indexes WHERE schemaname='public'",
    "UNION ALL SELECT 'function',proname FROM pg_proc p",
    "JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'",
   ].join(' ')),
   db.query('SELECT current_database() AS database,(SELECT count(*)::int FROM public.schema_migrations) AS ledger'),
   buildFootprintSources(),
  ])
  const observed={table:new Set(),index:new Set(),function:new Set()}
  for(const row of names.rows)observed[row.kind]?.add(row.name)
  const report=summariseMigrationFootprint({
   database:identity.rows[0].database,
   ledgerCount:identity.rows[0].ledger,files,observed,
  })
  await db.query('ROLLBACK')
  return report
 }catch(error){
  await db.query('ROLLBACK').catch(()=>{})
  throw error
 }
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 if(process.argv.length!==3||process.argv[2]!=='--report')
  throw Error('Read-only migration audit only: use --report. No apply/backfill mode exists.')
 if(!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL||''))
  throw Error('Provide a scoped read-only DATABASE_URL; credentials are never displayed.')
 const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  connectionTimeoutMillis:5000,statement_timeout:20000})
 try{
  await db.connect()
  const report=await reportDatabaseBaseline(db)
  process.stdout.write(JSON.stringify(report,null,2)+'\n')
 }finally{await db.end().catch(()=>{})}
}
