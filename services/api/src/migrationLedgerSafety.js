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
