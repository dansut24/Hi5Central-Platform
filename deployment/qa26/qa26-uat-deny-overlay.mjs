#!/usr/bin/env node
/**
 * QA26 sandbox URL deny overlay. Pure/deterministic: never touches Docker,
 * Caddy or a running customer. Apply only after comparing the proposed Caddy
 * source with the current UAT runtime and staging an independent rollback.
 *
 * Managed QA26 has no UAT entitlement; neither QA tenant has UAT RMM.
 */
import {readFileSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const denyStart='# H5C_QA26_MANAGED_UAT_DENY_BEGIN'
const denyEnd='# H5C_QA26_MANAGED_UAT_DENY_END'
const rmmStart='# H5C_QA26_UAT_RMM_DENY_BEGIN'
const rmmEnd='# H5C_QA26_UAT_RMM_DENY_END'
const initial='http://uat.hi5central.com {\n'
const rmm='http://uat-rmm.hi5central.com {\n  reverse_proxy rmm-web:80\n}'
export function renderQa26UatDeny(source){
  if(typeof source!=='string'||!source)throw Error('Current UAT Caddy source is required.')
  const present=[denyStart,denyEnd,rmmStart,rmmEnd].map(marker=>source.includes(marker))
  if(present.every(Boolean)){
    if(!source.includes('h5c-managed-qa26-uat-portal.hi5central.com')
      ||!source.includes('h5c-custom-qa26-uat-rmm.hi5central.com'))
      throw Error('Existing QA26 deny markers are incomplete.')
    return source
  }
  if(present.some(Boolean))throw Error('Partially applied QA26 deny needs explicit operator reconciliation.')
  if(source.split(initial).length!==2||source.split(rmm).length!==2)
    throw Error('Unexpected UAT gateway source, fail closed.')
  const exact=[
    '  '+denyStart,
    '  @qa26ManagedUatDenied header X-Forwarded-Host h5c-managed-qa26-uat.hi5central.com',
    '  handle @qa26ManagedUatDenied {',
    '    respond 404',
    '  }',
    '  @qa26ManagedUatPortalDenied header X-Forwarded-Host h5c-managed-qa26-uat-portal.hi5central.com',
    '  handle @qa26ManagedUatPortalDenied {',
    '    respond 404',
    '  }',
    '  '+denyEnd,
  ].join('\n')+'\n'
  const rmmDeny=[
    'http://uat-rmm.hi5central.com {',
    '  '+rmmStart,
    '  @qa26ManagedUatRmmDenied header X-Forwarded-Host h5c-managed-qa26-uat-rmm.hi5central.com',
    '  handle @qa26ManagedUatRmmDenied {',
    '    respond 404',
    '  }',
    '  @qa26CustomUatRmmDenied header X-Forwarded-Host h5c-custom-qa26-uat-rmm.hi5central.com',
    '  handle @qa26CustomUatRmmDenied {',
    '    respond 404',
    '  }',
    '  '+rmmEnd,
    '  handle {',
    '    reverse_proxy rmm-web:80',
    '  }',
    '}',
  ].join('\n')
  return source.replace(initial,initial+exact).replace(rmm,rmmDeny)
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  if(process.argv.length!==5||process.argv[2]!=='--render')
    throw Error('Usage: node qa26-uat-deny-overlay.mjs --render <existing.Caddyfile> <candidate.Caddyfile>')
  const [input,output]=process.argv.slice(3)
  if(input===output)throw Error('Never overwrite the source; review candidate before staged application.')
  writeFileSync(output,renderQa26UatDeny(readFileSync(input,'utf8')),{mode:0o600})
}
