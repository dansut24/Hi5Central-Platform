/**
 * Migration recovery evidence only. A matching object does not prove its
 * historical SQL executed. No backfill, approval, or migration execution.
 */
import {createHash} from 'node:crypto'
const OBJECT=/\bCREATE\s+(?:(?:UNIQUE|CONCURRENTLY)\s+)?(?:OR\s+REPLACE\s+)?(TABLE|INDEX|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi
const SUPPORTED=new Set(['table','index','function'])
export function migrationFileFootprint({version,sourcePath,sql}){
 if(typeof sql!=='string'||!/^([0-9]{3})_[a-z0-9_-]+\.sql$/.test(version)
   ||typeof sourcePath!=='string'||sourcePath.startsWith('/')
   ||sourcePath.includes('..'))throw Error('Invalid migration source identity.')
 const objects=[...sql.matchAll(OBJECT)].map(m=>({
  kind:m[1].toLowerCase(),name:m[2].toLowerCase(),
 }))
 return {version,sourcePath,sha256:createHash('sha256').update(sql).digest('hex'),objects}
}
export function summariseMigrationFootprint({database,ledgerCount,files,observed}){
 if(!/^[a-z][a-z0-9_]{1,62}$/.test(String(database||''))
   ||!Number.isSafeInteger(ledgerCount)||ledgerCount<0
   ||!Array.isArray(files)||files.length<1
   ||files.some(x=>!x||typeof x.version!=='string'||!Array.isArray(x.objects))
   ||!observed||[...SUPPORTED].some(k=>!(observed[k] instanceof Set)))
   throw Error('Invalid read-only migration-footprint evidence.')
 const versions=new Set(files.map(f=>f.version))
 if(versions.size!==files.length)
   throw Error('Duplicate migration source filenames invalidate reconciliation.')
 const objectEvidence=[]
 for(const file of files){
  for(const {kind,name} of file.objects){
   if(!SUPPORTED.has(kind)||!/^[a-z_][a-z0-9_]*$/.test(name))
    throw Error('Invalid SQL object footprint.')
   objectEvidence.push({
    source:file.version,kind,name,present:observed[kind].has(name),
    unappliedCustomerRollbackMigration:/^(178|179|180)_/.test(file.version),
   })
  }
 }
 const missingHistorical=objectEvidence.filter(o=>!o.present&&!o.unappliedCustomerRollbackMigration)
 const missingNew=objectEvidence.filter(o=>!o.present&&o.unappliedCustomerRollbackMigration)
 const historicalTotal=objectEvidence.filter(o=>!o.unappliedCustomerRollbackMigration).length
 return {
  database,status:'HISTORY_UNVERIFIED',readOnly:true,
  appliedHistoryMayBeInferred:false,backfillAllowed:false,
  historicalLedgerCount:ledgerCount,sourceFileCount:files.length,
  historicalObjectRefs:historicalTotal,
  historicalPresent:historicalTotal-missingHistorical.length,
  missingHistorical,missingNew,
  observedObjectCounts:Object.fromEntries([...SUPPORTED].map(k=>[k,observed[k].size])),
  migrationSources:files.map(({version,sourcePath,sha256})=>({version,sourcePath,sha256})),
  interpretation:'Object presence is structural evidence, not proof of historical migration execution. Each database must be independently reviewed.',
 }
}
