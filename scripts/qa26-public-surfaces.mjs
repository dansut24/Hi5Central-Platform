/**
 * Unauthenticated, read-only, public QA26 availability check.
 * It tests CURRENTLY deployed QA pages; it does NOT test PR code or sign in.
 */
const cases=[
  ['Managed Live ITSM','https://h5c-managed-qa26.hi5central.com/login'],
  ['Managed ITSM Test','https://h5c-managed-qa26-test.hi5central.com/login'],
  ['Custom Live ITSM','https://h5c-custom-qa26.hi5central.com/login'],
  ['Custom ITSM Test','https://h5c-custom-qa26-test.hi5central.com/login'],
  ['Custom ITSM UAT','https://h5c-custom-qa26-uat.hi5central.com/login'],
  ['Managed Live RMM','https://h5c-managed-qa26-rmm.hi5central.com/'],
  ['Custom Live RMM','https://h5c-custom-qa26-rmm.hi5central.com/'],
]
const rows=[]
for(const [name,url] of cases){
  try{
    const result=await fetch(url,{
      method:'GET',redirect:'follow',headers:{Accept:'text/html'},
      signal:AbortSignal.timeout(12000),
    })
    const destination=new URL(result.url||url)
    const safe=destination.protocol==='https:'&&
      (destination.hostname==='hi5central.com'||destination.hostname.endsWith('.hi5central.com'))
    const good=safe&&result.status>=200&&result.status<400
    rows.push({name,status:good?'PASS':'BLOCKED',httpStatus:result.status,
      redirect:safe&&destination.hostname!==new URL(url).hostname?'first-party redirect':'none',
      ...(!good?{reason:safe?'Unexpected HTTP status':'Unexpected redirect host'}:{})})
    await result.body?.cancel().catch(()=>{})
  }catch(error){
    rows.push({name,status:'BLOCKED',reason:String(error?.cause?.code||error?.code||'NETWORK_UNAVAILABLE')})
  }
}
console.log(JSON.stringify({scope:'public QA26 surfaces only',method:'unauthenticated GET',checks:rows},null,2))
if(rows.some(row=>row.status!=='PASS'))process.exitCode=1
