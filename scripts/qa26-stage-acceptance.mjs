/**
 * Read-only public verification AFTER an operator-approved QA26 deployment.
 * Never authenticates, creates sessions, modifies tenant data, or targets devices.
 * Does not assert PR code has deployed without the backend perimeter checks.
 */
const checks=[
  {
    label:'Managed Test RMM API is blocked before authentication',
    url:'https://test-api.hi5central.com/api/v1/rmm/devices',
    origin:'https://h5c-managed-qa26-test.hi5central.com',
    expected:403,
  },
  {
    label:'Custom Test RMM API is blocked before authentication',
    url:'https://test-api.hi5central.com/api/v1/rmm/devices',
    origin:'https://h5c-custom-qa26-test.hi5central.com',
    expected:403,
  },
  {
    label:'Custom UAT RMM API is blocked before authentication',
    url:'https://uat-api.hi5central.com/api/v1/rmm/devices',
    origin:'https://h5c-custom-qa26-uat.hi5central.com',
    expected:403,
  },
  {
    label:'Custom UAT ITSM change-history endpoint exists and requires a session',
    url:'https://uat-api.hi5central.com/api/v1/release-management/configuration-changes',
    origin:'https://h5c-custom-qa26-uat.hi5central.com',
    expected:401,
  },
  {
    label:'Managed Test ITSM history endpoint exists and requires a session',
    url:'https://test-api.hi5central.com/api/v1/release-management/configuration-changes',
    origin:'https://h5c-managed-qa26-test.hi5central.com',
    expected:401,
  },
  {
    label:'Unrelated Test tenants retain their original API route',
    url:'https://test-api.hi5central.com/api/v1/organisation',
    origin:'https://testing-test.hi5central.com',
    expected:401,
  },
  {
    label:'Unrelated UAT tenants retain their original API route',
    url:'https://uat-api.hi5central.com/api/v1/organisation',
    origin:'https://testing-uat.hi5central.com',
    expected:401,
  }
]
const results=[]
for(const check of checks){
  try {
    const response=await fetch(check.url,{
      method:'GET',headers:{Origin:check.origin,Accept:'application/json'},
      redirect:'manual',signal:AbortSignal.timeout(8000),
    })
    const correct=response.status===check.expected
    results.push({label:check.label,status:correct?'PASS':'BLOCKED',
      actual:response.status,expected:check.expected})
    await response.body?.cancel().catch(()=>{})
  } catch(error) {
    results.push({label:check.label,status:'BLOCKED',
      error:String(error?.cause?.code||error?.name||'NETWORK_UNAVAILABLE')})
  }
}
const pass=results.filter(x=>x.status==='PASS').length
console.log(JSON.stringify({scope:'QA26 public API staging only',method:'Unauthenticated GET, no side effects',
  passed:pass,total:results.length,checks:results},null,2))
if(pass!==results.length)process.exitCode=1
