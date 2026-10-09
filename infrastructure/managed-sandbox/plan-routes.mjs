#!/usr/bin/env node
// Read-only gateway planning: NEVER writes DNS, Caddyfile or Docker state.
// The operator must independently verify DNS/TLS and explicitly approve routes.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { isValidCustomerSlug, managedTenantUrls } from '../../services/api/src/tenantEnvironmentHostnames.js'

export function planRoutes(environment, tenantSlug, rootDomain='hi5central.com') {
  if(!['uat','test'].includes(environment)) throw new Error('Only UAT/Test can use the pilot route plan.')
  if(!isValidCustomerSlug(tenantSlug)) throw new Error('Invalid or reserved customer slug.')
  if(rootDomain!=='hi5central.com') throw new Error('Root domain must be independently reviewed before use.')
  const urls=managedTenantUrls(tenantSlug,rootDomain,environment,{rmm:false})
  const apiHost=`${environment}-api.${rootDomain}`
  return {
    status:'route_plan_only',environment,tenantSlug,
    customerWorkspace:urls.tenantUrl,customerPortal:urls.portalUrl,
    apiOrigin:`https://${apiHost}`,
    expectedProxyTargets:{
      api:`hi5-sandbox-${environment}-api:3001`,
      workspace:`hi5-sandbox-${environment}-itsm:80`,
    },
    expectedEdgeNetwork:`hi5central-sandbox-${environment}-edge`,
    rmmHost:null,turnHost:null,
    deploymentChanges:false,dnsChanges:false,tlsChanges:false,
    operatorGates:[
      'Confirm customer hostname is not claimed by legacy or Production routing',
      'Review DNS and TLS certificate ownership, SANs and renewals',
      'Check gateway edge network is attached only to the approved runtime',
      'Ensure unmatched reserved UAT/Test hosts never fall back to Production',
      'Verify independently approved sandbox identity, MFA and session revocation',
    ],
  }
}
const script=fileURLToPath(import.meta.url)
if(process.argv[1] && script===resolve(process.argv[1])) {
  const args=process.argv.slice(2)
  if(args.length!==4 || args[0]!=='--environment' || args[2]!=='--tenant'){
    console.error('Usage: node plan-routes.mjs --environment uat|test --tenant validated-slug')
    process.exit(2)
  }
  try{console.log(JSON.stringify(planRoutes(args[1],args[3]),null,2))}
  catch(error){console.error('Route plan rejected:',error.message);process.exitCode=1}
}
