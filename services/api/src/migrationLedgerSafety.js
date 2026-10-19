/**
 * An application schema with no migration history is NOT a fresh database.
 *
 * A historical schema recovery may have restored tables without restoring the
 * original schema_migrations rows. The generic runner must never infer that
 * it can safely replay every SQL file over those populated tables.
 *
 * A reviewed per-environment baseline reconciliation is required. Do not
 * backfill rows merely because a table or column looks similar.
 */
export function assertHistoricalMigrationLedgerSafe({appliedCount,publicTableCount}){
 if(!Number.isSafeInteger(appliedCount)||appliedCount<0||
    !Number.isSafeInteger(publicTableCount)||publicTableCount<0)
   throw Error('Migration ledger preflight received invalid schema counts.')
 if(publicTableCount>0&&appliedCount===0)
   throw Error([
    'MIGRATION_HISTORY_UNVERIFIED: populated public application schema',
    'with an empty schema_migrations ledger. Refusing to replay historical',
    'migrations. Obtain a restorable database backup and independently',
    'reconcile the exact per-database migration provenance before rerunning.',
    'Never seed historical migration rows from filenames alone.',
   ].join(' '))
 return {safeToProceed:true,freshDatabase:publicTableCount===0}
}

/**
 * A partially reconstructed history is equally dangerous. Example: someone
 * marks only rollback migrations 178–180 as applied while 001–177 remain
 * unverified. Sorting the source filenames must yield an uninterrupted
 * applied prefix followed by unapplied newer migrations, never gaps.
 */
export function assertMigrationHistoryPrefixSafe({appliedVersions,sourceVersions}){
 if(!Array.isArray(appliedVersions)||!Array.isArray(sourceVersions)
   ||appliedVersions.some(x=>typeof x!=='string'||!x.endsWith('.sql'))
   ||sourceVersions.some(x=>typeof x!=='string'||!x.endsWith('.sql')))
   throw Error('MIGRATION_HISTORY_INVALID: expected exact SQL migration filename arrays.')
 const applied=new Set(appliedVersions)
 const source=new Set(sourceVersions)
 if(applied.size!==appliedVersions.length||source.size!==sourceVersions.length)
   throw Error('MIGRATION_HISTORY_INVALID: duplicate historical migration identities.')
 for(const version of applied){
   if(!source.has(version))
     throw Error('MIGRATION_HISTORY_UNVERIFIED: applied migration source unavailable: '+version)
 }
 const sorted=[...source].sort((a,b)=>a.localeCompare(b))
 let firstUnapplied=null
 for(const version of sorted){
   if(!applied.has(version)){
     firstUnapplied??=version
   }else if(firstUnapplied){
     throw Error('MIGRATION_HISTORY_UNVERIFIED: applied '+version+
       ' follows missing historical '+firstUnapplied+
       '. Refusing migration replay against a non-contiguous ledger.')
   }
 }
 return {safeToProceed:true,appliedCount:applied.size}
}
