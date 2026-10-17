/**
 * QA-cohort-only Caddy entitlement guard, for review before the protected
 * shared gateway remount. Pure / deterministic: no Docker, SQL, or reload.
 *
 * This overlays precise forbidden QA aliases only. It does NOT change
 * tenant permissions and must not be confused with a generic entitlement
 * service for unlisted future customers.
 */
const slugPattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
const hostnamePattern=/^[a-z0-9-]+[.]hi5central[.]com$/
const afterUat='    @tenantUatWorkspace expression'
const afterRmm='    @tenantRmm expression'
const markers=['# QA_ENTITLEMENT_GUARD_UAT_BEGIN',
 '# QA_ENTITLEMENT_GUARD_UAT_END',
 '# QA_ENTITLEMENT_GUARD_RMM_BEGIN',
 '# QA_ENTITLEMENT_GUARD_RMM_END']
const rows=(tenants)=>{
 if(!Array.isArray(tenants)||tenants.length!==10)
  throw Error('Exactly ten verified QA tenants required for this narrowly scoped overlay.')
 const named=new Set()
 const modes={managed:0,custom:0}
 let rmmCount=0
 const values=tenants.map(t=>{
  const slug=String(t?.slug||'')
  if(!slugPattern.test(slug)||named.has(slug))
   throw Error('Invalid or duplicate QA slug.')
  named.add(slug)
  if(t.mode!=='hi5_managed'&&t.mode!=='admin_controlled')
   throw Error('Unrecognised QA delivery mode.')
  modes[t.mode==='hi5_managed'?'managed':'custom']++
  if(typeof t.rmm!=='boolean')throw Error('QA RMM entitlement must be verified.')
  if(t.rmm)rmmCount++
  return {slug,mode:t.mode,rmm:t.rmm}
 })
 if(modes.managed!==5||modes.custom!==5||rmmCount!==2)
  throw Error('QA cohort must have 5 Managed, 5 Custom and 2 Live RMM.')
 return values.sort((a,b)=>a.slug.localeCompare(b.slug))
}
function hosts(values){
 if(!values.length)throw Error('Refusing an empty deny matcher.')
 if(values.some(x=>!hostnamePattern.test(x)))
  throw Error('Only explicit Hi5Central tenant hostnames allowed.')
 return values.join(' ')
}
export function renderQaGatewayEntitlementOverlay(source,verifiedTenants){
 if(typeof source!=='string'||source.length<2000)
  throw Error('Full independently reviewed source required.')
 const cohort=rows(verifiedTenants)
 if(markers.some(m=>source.includes(m)))
  throw Error('Entitlement overlay already present or partly applied.')
 if(source.split(afterUat).length!==2||source.split(afterRmm).length!==2)
  throw Error('Missing expected unique tenant workspace / RMM gateway matcher.')
 const managedUat=hosts(cohort.filter(x=>x.mode==='hi5_managed')
  .flatMap(x=>[x.slug+'-uat.hi5central.com',
   x.slug+'-uat-portal.hi5central.com']))
 const missingRmm=hosts([
  ...cohort.filter(x=>!x.rmm).map(x=>x.slug+'-rmm.hi5central.com'),
  // Live-only RMM means *all* UAT/Test RMM host aliases are forbidden,
  // even for the two customers entitled to their one Live RMM instance.
  ...cohort.flatMap(x=>[x.slug+'-test-rmm.hi5central.com',
   x.slug+'-uat-rmm.hi5central.com']),
 ])
 const uat=[
  '    '+markers[0],
  '    @qaManagedUatDenied host '+managedUat,
  '    handle @qaManagedUatDenied {',
  '        respond "UAT is not enabled for this tenant" 404',
  '    }',
  '    '+markers[1],
  '',
 ].join('\n')
 const rmm=[
  '    '+markers[2],
  '    @qaRmmDenied host '+missingRmm,
  '    handle @qaRmmDenied {',
  '        respond "RMM is available only on entitled Live tenants" 404',
  '    }',
  '    '+markers[3],
  '',
 ].join('\n')
 return source.replace(afterUat,uat+afterUat)
  .replace(afterRmm,rmm+afterRmm)
}
export function expectedQaDeniedAliases(verifiedTenants){
 const cohort=rows(verifiedTenants)
 return {
  managedUat:cohort.filter(x=>x.mode==='hi5_managed')
   .flatMap(x=>[x.slug+'-uat.hi5central.com',x.slug+'-uat-portal.hi5central.com']),
  nonRmm:cohort.filter(x=>!x.rmm).map(x=>x.slug+'-rmm.hi5central.com'),
  sandboxRmm:cohort.flatMap(x=>[x.slug+'-test-rmm.hi5central.com',
    x.slug+'-uat-rmm.hi5central.com']),
  rmmAllowed:cohort.filter(x=>x.rmm).map(x=>x.slug+'-rmm.hi5central.com'),
 }
}
