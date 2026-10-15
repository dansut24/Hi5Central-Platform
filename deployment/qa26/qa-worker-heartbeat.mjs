import {spawnSync} from 'node:child_process'

const allowedWorkers=new Map([
  ['qa26-test-release-operator','test'],
  ['qa26-custom-uat-release-operator','uat'],
  ['qa26-managed-live-release-operator','live'],
])
const SHA=/^[a-f0-9]{40}$/
/** One small durable heartbeat per worker poll; never logs DB credentials. */
export function heartbeat(workerId,state,versionSha=null){
  const gateway=allowedWorkers.get(workerId)
  if(!gateway||!['idle','busy','paused','error'].includes(state)
    ||(versionSha&&!SHA.test(versionSha)))
    throw Error('Unrecognised release worker heartbeat.')
  const qs=x=>"'"+x+"'"
  const statement=[
    'INSERT INTO platform_release_worker_heartbeats',
    '(worker_id,gateway,state,version_sha,last_poll_at,last_success_at,last_error)',
    'VALUES('+qs(workerId)+','+qs(gateway)+','+qs(state)+','+
      (versionSha?qs(versionSha):'NULL')+",now(),"+
      (state==='error'?'NULL':'now()')+",'')",
    'ON CONFLICT(worker_id) DO UPDATE SET',
    'gateway=excluded.gateway,state=excluded.state,',
    'version_sha=excluded.version_sha,last_poll_at=now(),updated_at=now(),',
    "last_success_at=CASE WHEN excluded.state='error'",
    'THEN platform_release_worker_heartbeats.last_success_at ELSE now() END',
  ].join(' ')
  const call=spawnSync('docker',['exec','-i','hi5central-postgres','sh','-c',
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -At -v ON_ERROR_STOP=1'],
    {encoding:'utf8',input:statement+'\n',timeout:15000,maxBuffer:8192})
  if(call.status!==0)throw Error('Durable worker heartbeat failed: '+(call.stderr||'').slice(-180))
}
