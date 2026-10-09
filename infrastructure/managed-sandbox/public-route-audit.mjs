import { resolve4 } from 'node:dns/promises'
import { request } from 'node:https'

const ROOT='hi5central.com'
const HOSTS=[
  {hostname:'uat-api.hi5central.com',class:'legacy-api'},
  {hostname:'test-api.hi5central.com',class:'legacy-api'},
  {hostname:'pilot-uat-api.hi5central.com',class:'pilot-api-unpublished'},
  {hostname:'pilot-test-api.hi5central.com',class:'pilot-api-unpublished'},
  {hostname:'pilotexampleuat.hi5central.com',class:'unapproved-customer'},
  {hostname:'pilotexampletest.hi5central.com',class:'unapproved-customer'},
]

export function auditRouteEvidence(results) {
  if(!Array.isArray(results) || !results.length) return {
    ready:false,flags:['No DNS/TLS measurements available.'],approvalAllowed:false,
  }
  const flags=[]
  for(const r of results){
    if(!r.hostname.endsWith('.'+ROOT)) flags.push('Foreign or malformed hostname')
    if(!Array.isArray(r.addresses)||!r.addresses.length) flags.push(r.hostname+': DNS resolution failed')
    if(r.error) flags.push(r.hostname+': HTTPS probe failed ('+r.error+')')
    if(!r.tlsAuthorized) flags.push(r.hostname+': TLS certificate not validated')
    if(r.class==='pilot-api-unpublished' && [200,201,202,204].includes(r.httpStatus))
      flags.push(r.hostname+': unapproved pilot API already responds successfully')
    if(r.class==='unapproved-customer' && r.httpStatus>=200 && r.httpStatus<400)
      flags.push(r.hostname+': unapproved customer hostname serves or redirects a page')
    if(r.locationHost && (r.locationHost===ROOT
      || r.locationHost==='api.'+ROOT || r.locationHost==='dev.'+ROOT))
      flags.push(r.hostname+': possible live/dev fallback redirect')
    if(r.class==='unapproved-customer' && r.setCookie)
      flags.push(r.hostname+': unapproved hostname sets a cookie')
  }
  return {ready:false,flags,approvalAllowed:false,
    evidenceOnly:true,requiresGatewayTlsAndWildcardReview:true}
}

function httpsHead(hostname,timeoutMs=6500){
  return new Promise(resolve=>{
    let finished=false
    let cert=null
    const done=value=>{if(!finished){finished=true;resolve({hostname,...value,...cert})}}
    const req=request({
      hostname,port:443,path:'/live',method:'HEAD',
      agent:false,rejectUnauthorized:true,
      headers:{'user-agent':'Hi5Central-readonly-route-audit/1.0'},
      timeout:timeoutMs,
    },res=>{
      let locationHost=null
      if(res.headers.location){
        try{locationHost=new URL(res.headers.location,`https://${hostname}`).hostname}catch{}
      }
      res.resume()
      done({httpStatus:res.statusCode||null,locationHost,
        setCookie:Boolean(res.headers['set-cookie']),tlsAuthorized:cert?.tlsAuthorized===true})
    })
    req.on('socket',socket=>{
      socket.on('secureConnect',()=>{
        const peer=socket.getPeerCertificate()
        cert={tlsAuthorized:socket.authorized===true,
          certificateCommonName:String(peer?.subject?.CN||'').slice(0,200),
          certificateSanNames:String(peer?.subjectaltname||'').slice(0,500)}
      })
    })
    req.on('timeout',()=>req.destroy(new Error('timeout')))
    req.on('error',err=>done({error:err.code||err.message||'connection_error',
      httpStatus:null,tlsAuthorized:cert?.tlsAuthorized===true}))
    req.end()
  })
}

export async function probePublicRoutes(){
  const results=await Promise.all(HOSTS.map(async item=>{
    let addresses=[]
    try{addresses=(await resolve4(item.hostname)).slice(0,6)}catch{}
    const probe=await httpsHead(item.hostname)
    return {...item,addresses,...probe}
  }))
  return {results,summary:auditRouteEvidence(results),
    probeMethod:'read-only DNS A lookup, TLS verified HTTPS HEAD /live',
    noCredentialsUsed:true,noChangesMade:true}
}

if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href){
  if(process.argv.length!==3||process.argv[2]!=='--read-only'){
    console.error('Usage: node public-route-audit.mjs --read-only')
    process.exitCode=2
  }else{
    probePublicRoutes().then(report=>console.log(JSON.stringify(report,null,2)))
      .catch(err=>{console.error('Public route audit could not complete:',err.message);process.exitCode=1})
  }
}
