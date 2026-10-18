import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto'
import {validateReleaseNotes} from './releaseNotesValidation.js'
import {normaliseCustomerReleaseDraft} from './customerReleasePreparation.js'
import {listOfficialReleaseCandidates,verifyOfficialReleaseRun,verifyDevReleaseSmoke} from './officialReleaseCertification.js'

const SHA=/^[a-f0-9]{40}$/
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const reject=message=>Object.assign(new Error(message),{status:409})
const secret=()=>process.env.H5C_DEV_HANDOFF_SECRET||''
function key(){
 const value=secret()
 if(!/^[0-9a-f]{64}$/.test(value))throw reject('Dev release handoff credential is not configured.')
 return value
}
export function signDevHandoff(body,{timestamp=Date.now(),nonce=randomUUID(),secretValue=key()}={}){
 const payload=JSON.stringify(body)
 const head=String(timestamp)+'.'+nonce+'.'
 const signature=createHmac('sha256',secretValue).update(head+payload).digest('hex')
 return {payload,headers:{'Content-Type':'application/json',
  'X-H5C-Dev-Time':String(timestamp),'X-H5C-Dev-Nonce':nonce,'X-H5C-Dev-Signature':signature}}
}
export function verifyDevHandoff({payload,headers,now=Date.now(),secretValue=key()}={}){
 const stamp=String(headers?.time||'')
 const nonce=String(headers?.nonce||'')
 const signature=String(headers?.signature||'')
 const timestamp=Number(stamp)
 if(!/^\d{13}$/.test(stamp)||!UUID.test(nonce)||!/^[0-9a-f]{64}$/.test(signature)
  ||Math.abs(now-timestamp)>120000||payload.length>75000)throw reject('Invalid or expired Dev handoff request.')
 const expected=createHmac('sha256',secretValue).update(stamp+'.'+nonce+'.'+payload).digest('hex')
 if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))
  throw reject('Invalid Dev handoff signature.')
 const body=JSON.parse(payload)
 if(!['candidates','read','save','submit'].includes(body?.action)||body?.devSlug!=='dev'
   ||!UUID.test(String(body?.authorId||'')))
  throw reject('Only an authenticated internal Dev author may prepare customer releases.')
 if(body.action!=='candidates'&&!SHA.test(String(body?.sha||'')))
  throw reject('Choose an exact GitHub release SHA.')
 return {...body,nonce}
}
export async function callCentralDevHandoff(body,{fetcher=fetch}={}){
 const signed=signDevHandoff(body)
 const response=await fetcher('https://api.hi5central.com/api/platform/v1/releases/dev-handoff',{
  method:'POST',redirect:'error',headers:signed.headers,body:signed.payload,
  signal:AbortSignal.timeout(25000)})
 const data=await response.json().catch(()=>({}))
 if(!response.ok)throw reject(data.error||'Central release handoff is temporarily unavailable.')
 return data
}
export async function processDevHandoff(db,request,{token=process.env.GITHUB_RELEASE_READ_TOKEN}={}){
 const {action,sha,notes,authorId,devSlug,ciRunUrl}=request
 if(devSlug!=='dev'||!UUID.test(String(authorId||'')))throw reject('Internal Dev author required.')
 if(action==='candidates')return {candidates:await listOfficialReleaseCandidates({token})}
 if(!SHA.test(String(sha||'')))throw reject('Exact GitHub SHA required.')
 if(action==='read'){
  const r=await db.query('SELECT build_sha,notes,ci_run_url,status,edited_at,submitted_at,reviewed_at,rejection_reason FROM platform_dev_release_submissions WHERE build_sha=$1',[sha])
  return {submission:r.rows[0]||null}
 }
 if(action==='save'){
  const formatted=normaliseCustomerReleaseDraft({sha,notes})
  const result=await db.query([
   'INSERT INTO platform_dev_release_submissions(build_sha,notes,dev_author_id,dev_author_slug)',
   "VALUES($1,$2::jsonb,$3,'dev') ON CONFLICT(build_sha) DO UPDATE",
   'SET notes=EXCLUDED.notes,dev_author_id=EXCLUDED.dev_author_id,',
   "status='draft',edited_at=now(),rejection_reason=NULL,",
   'reviewed_at=NULL,reviewed_by=NULL',
   "WHERE platform_dev_release_submissions.status IN ('draft','rejected')",
   'RETURNING build_sha,status,edited_at',
  ].join(' '),[sha,JSON.stringify(formatted),authorId])
  if(!result.rowCount)throw reject('Submitted or published notes are locked; Admin must review them.')
  return {submission:result.rows[0]}
 }
 if(action==='submit'){
  // Verify immutable Dev candidate before changing the central record.
  const candidates=await listOfficialReleaseCandidates({token})
  const selected=candidates.find(item=>item.buildSha===sha&&item.ciRunUrl===ciRunUrl)
  if(!selected)throw reject('Select a verified official GitHub release candidate.')
  await verifyOfficialReleaseRun({sha,runUrl:ciRunUrl,token})
  await verifyDevReleaseSmoke({sha})
  const pending=await db.query([
   'SELECT notes,status FROM platform_dev_release_submissions',
   'WHERE build_sha=$1 FOR UPDATE',
  ].join(' '),[sha])
  if(pending.rows[0]?.status!=='draft')throw reject('Save a draft before submitting, or this build was already submitted.')
  validateReleaseNotes({buildSha:sha,...pending.rows[0].notes})
  const result=await db.query([
   'UPDATE platform_dev_release_submissions',
   "SET status='submitted',submitted_at=now(),ci_run_url=$2,edited_at=now()",
   "WHERE build_sha=$1 AND status='draft' RETURNING build_sha,status,submitted_at",
  ].join(' '),[sha,ciRunUrl])
  return {submission:result.rows[0]}
 }
 throw reject('Unsupported release handoff action.')
}
