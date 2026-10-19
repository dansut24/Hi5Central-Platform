/**
 * Opt-in execution of the existing stage worker's rollback poller.
 * A global flag is insufficient: explicitly name the stage(s) to activate.
 * Unknown values fail closed. No new daemon, scheduler or queue.
 */
export function rollbackExecutorEnabledForStage({stage,enabled,stages}={}){
 if(enabled!=='true'||!['uat','live'].includes(stage)||typeof stages!=='string')return false
 const values=stages.split(',').map(s=>s.trim()).filter(Boolean)
 if(!values.length||values.some(s=>!['uat','live'].includes(s)))return false
 return new Set(values).has(stage)
}
