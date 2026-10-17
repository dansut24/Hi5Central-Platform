import pg from 'pg'
import {readFileSync} from 'node:fs'

const SHA=/^[a-f0-9]{40}$/
const fail=message=>Object.assign(new Error(message),{code:'RELEASE_PUBLICATION_BLOCKED'})
const canonical=value=>{
  if(Array.isArray(value))return value.map(canonical)
  if(value&&typeof value==='object')return Object.fromEntries(
    Object.keys(value).sort().map(k=>[k,canonical(value[k])]))
  return value
}
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b))

/** Dual-network Docker relays must never resolve generic "postgres" to the
 * Live database. Explicitly target the known isolated Dev PostgreSQL service.
 * Keep the credential itself in a read-only secret file.
 */
export function pinnedDevDatabaseUrl(raw){
  if(typeof raw!=='string'||!/^postgres(?:ql)?:\/\//.test(raw))
    throw fail('A valid Dev PostgreSQL secret is required.')
  let parsed
  try{parsed=new URL(raw)}
  catch{throw fail('Dev PostgreSQL connection URL is malformed.')}
  if(!['postgres','hi5central-dev-postgres-1'].includes(parsed.hostname)
    ||!parsed.username||!parsed.password||parsed.pathname!=='/hi5central'
    ||!(parsed.port===''||parsed.port==='5432'))
    throw fail('Dev database secret must point to the expected isolated Dev service.')
  parsed.hostname='hi5central-dev-postgres-1'
  parsed.port='5432'
  return parsed.toString()
}


/** Only a previously authenticated Dev author's explicit publication request
 * can reach the central protected publication API. This does not certify any
 * GitHub run, queue a tenant deployment or unpause global rollouts.
 * The caller must hold a database transaction until this call completes.
 */
export async function relayOneRequestedRelease({
  db,fetcher,authority,token,allowedSha,reconcileOnly=false,
}={}){
  const automatic=allowedSha==='verified-dev'
  if(!automatic&&!SHA.test(String(allowedSha||'')))
    throw fail('A pinned SHA or the independently verified Dev-only mode is required.')
  if(authority!=='http://hi5central-api:3001')
    throw fail('Only the trusted internal central API endpoint is allowed.')
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{48,256}$/.test(token.trim()))
    throw fail('Dedicated publication-only token is missing.')
  if(typeof fetcher!=='function'||typeof db?.query!=='function')
    throw fail('Trusted database and HTTP capabilities are required.')

  // The dynamic selector does not trust a pending row's supplied SHA.
  // It first pins the request to the actual HTTPS Dev API build.
  let pinnedSha=allowedSha
  if(automatic){
    const dev=await fetcher('https://dev-api.hi5central.com/api/v1/updates/version',{
      headers:{Accept:'application/json'},redirect:'error',
      signal:AbortSignal.timeout(8000),cache:'no-store'})
    if(!dev.ok)throw fail('Actual Dev build identity is unavailable.')
    const detail=await dev.json().catch(()=>null)
    if(!SHA.test(String(detail?.sha||''))||detail.environment!=='dev')
      throw fail('Actual Dev API does not serve a verified versioned build.')
    pinnedSha=detail.sha
  }
  const selected=await db.query([
    'SELECT build_sha,version_label,title,summary,entries,status,requested_at,',
    'requested_at::text AS requested_at_exact,edited_by',
    'FROM hi5central_release_note_drafts',
    "WHERE status='publication_requested' AND build_sha=$1",
    'AND requested_at IS NOT NULL AND edited_by IS NOT NULL',
    'FOR UPDATE SKIP LOCKED',
  ].join(' '),[pinnedSha])
  if(selected.rowCount===0)return {status:'no_pending',buildSha:pinnedSha}
  if(selected.rowCount!==1)throw fail('Unexpected duplicate Dev release request.')
  const row=selected.rows[0]
  if(row.build_sha!==pinnedSha||row.status!=='publication_requested'
    ||!row.requested_at||typeof row.requested_at_exact!=='string'
    ||!row.requested_at_exact||!row.edited_by||!Array.isArray(row.entries)
    ||row.entries.length<1||row.entries.length>35)
    throw fail('Dev release request is incomplete or changed.')
  const request={
    buildSha:row.build_sha,versionLabel:row.version_label,title:row.title,
    summary:row.summary,entries:row.entries,
  }
  // A lost SSH session can interrupt Dev acknowledgement after the central
  // authority commits the immutable notes. Reconcile from the public central
  // catalogue in that case; never DELETE/re-INSERT an existing release.
  // Normal mode can also recover an HTTP 409, but ONLY after exact readback.
  let ack={}
  let alreadyPublished=false
  if(!reconcileOnly){
    const response=await fetcher(authority+'/api/platform-operator/v1/releases/publish',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token.trim()},
      body:JSON.stringify(request),signal:AbortSignal.timeout(10000),
    })
    ack=await response.json().catch(()=>({}))
    if(response.status===409)alreadyPublished=true
    else if(!response.ok||ack.published!==true||ack.buildSha!==pinnedSha)
      throw fail('Central authority refused Dev publication (HTTP '+response.status+').')
    alreadyPublished ||= ack.alreadyPublished===true
  }else{
    alreadyPublished=true
  }

  const readback=await fetcher(authority+'/api/v1/updates/published',{
    headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000),
  })
  if(!readback.ok)throw fail('Central publication readback unavailable.')
  const body=await readback.json().catch(()=>({}))
  const persisted=body.releases?.find(x=>x.buildSha===pinnedSha)
  if(!persisted||!equal({
    buildSha:persisted.buildSha,versionLabel:persisted.versionLabel,
    title:persisted.title,summary:persisted.summary,entries:persisted.entries,
  },request)||!persisted.publishedAt)
    throw fail('Central publication content/immutable SHA did not match the Dev request.')

  const updated=await db.query([
    'UPDATE hi5central_release_note_drafts',
    "SET status='published',published_at=$2",
    "WHERE build_sha=$1 AND status='publication_requested'",
    'AND version_label=$3 AND title=$4 AND summary=$5',
    'AND entries=$6::jsonb AND requested_at=$7::timestamptz AND edited_by=$8',
    'RETURNING build_sha,status,published_at',
  ].join(' '),[
    pinnedSha,persisted.publishedAt,row.version_label,row.title,row.summary,
    JSON.stringify(row.entries),row.requested_at_exact,row.edited_by,
  ])
  if(updated.rowCount!==1)throw fail('Dev request changed before central acknowledgement.')
  return {status:'published',buildSha:pinnedSha,publishedAt:persisted.publishedAt,
    alreadyPublished}
}

export async function runRelayCycle({pool,fetcher,authority,token,allowedSha,reconcileOnly=false}){
  const client=await pool.connect()
  try{
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='4000ms'")
    await client.query("SET LOCAL statement_timeout='35000ms'")
    const result=await relayOneRequestedRelease({db:client,fetcher,authority,token,allowedSha,reconcileOnly})
    await client.query('COMMIT')
    return result
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{})
    throw error
  }finally{client.release()}
}

/** Nonpublishing credential check: the central endpoint authenticates first,
 * then rejects invalid notes with HTTP 400. A 201 here is unsafe.
 */
export async function verifyCentralPublicationCredential({fetcher,authority,token}){
  if(authority!=='http://hi5central-api:3001'||typeof token!=='string'||!/^[A-Za-z0-9_-]{48,256}$/.test(token))
    throw fail('The central publication credential or authority is invalid.')
  const probe=await fetcher(authority+'/api/platform-operator/v1/releases/publish',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:'{}',signal:AbortSignal.timeout(7500),
  })
  if(probe.status!==400)
    throw fail('Protected central publication preflight failed (HTTP '+probe.status+').')
  return true
}

export async function startReleasePublicationRelay({
  databaseUrlFile,publicationTokenFile,allowedSha,authority,
  once=false,preflight=false,reconcileOnly=false,fetcher=fetch,
}={}){
  if(allowedSha!=='verified-dev'&&!SHA.test(String(allowedSha||'')))
    throw fail('Pin a legitimate Dev SHA or verified-dev publication mode.')
  if(reconcileOnly&&(!once||preflight))throw fail('Reconciliation must be one-shot and separate from preflight.')
  if(authority!=='http://hi5central-api:3001')throw fail('Untrusted central authority.')
  if(!databaseUrlFile||!publicationTokenFile)throw fail('Mounted secret files are required.')
  const databaseUrl=pinnedDevDatabaseUrl(readFileSync(databaseUrlFile,'utf8').trim())
  const token=readFileSync(publicationTokenFile,'utf8').trim()
  if(!/^postgres(?:ql)?:\/\//.test(databaseUrl)||!/^[A-Za-z0-9_-]{48,256}$/.test(token))
    throw fail('Configured database URL/token are invalid.')
  const pool=new pg.Pool({connectionString:databaseUrl,max:2,
    idleTimeoutMillis:15000,connectionTimeoutMillis:5000,
    application_name:'hi5central_release_publication_relay'})
  let running=true
  const stop=()=>{running=false}
  process.once('SIGTERM',stop);process.once('SIGINT',stop)
  try{
    const schema=await pool.query(
      "SELECT to_regclass('public.hi5central_release_note_drafts') IS NOT NULL AS ready")
    if(schema.rows[0]?.ready!==true)throw fail('Dev release-note migrations missing.')
    if(preflight){
      await verifyCentralPublicationCredential({fetcher,authority,token})
      if(allowedSha==='verified-dev'){
        const proof=await fetcher(authority+
          '/api/platform-operator/v1/releases/publication-capability',{
            headers:{Authorization:'Bearer '+token},
            signal:AbortSignal.timeout(7500),
          })
        const detail=await proof.json().catch(()=>({}))
        if(!proof.ok||detail.automaticDevPublication!==true
          ||detail.centralAuthority!==true)
          throw fail('Central release authority is not enabled for verified Dev auto-publication.')
      }
      return {status:'preflight_pass',allowedSha}
    }
    do{
      try{
        const result=await runRelayCycle({pool,fetcher,authority,token,allowedSha,reconcileOnly})
        if(result.status==='published')
          console.log(JSON.stringify({type:reconcileOnly?'release_notes_reconciled':'release_notes_published',...result}))
        if(once)return result
      }catch(error){
        console.error(JSON.stringify({type:'publication_relay_error',
          message:String(error.message||error).slice(0,260),allowedSha}))
        if(once)throw error
      }
      if(running)await new Promise(resolve=>setTimeout(resolve,15000))
    }while(running)
    return {status:'stopped'}
  }finally{await pool.end()}
}
