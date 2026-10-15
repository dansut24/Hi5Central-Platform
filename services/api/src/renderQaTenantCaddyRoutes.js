import {createHash} from 'node:crypto'

const SHA256=/^[a-f0-9]{64}$/
const expectedHosts={
  test:/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]-test\.hi5central\.com$/,
  uat:/^[a-z0-9][a-z0-9-]{1,45}[a-z0-9]-uat\.hi5central\.com$/,
}
const target=(suffix,port)=>new RegExp(
  '^hi5pool-[a-z0-9-]+-'+suffix+':'+port+'$'
)

/**
 * QA-only Caddyfile route fragment. The outer wildcard HTTPS gateway is
 * responsible for TLS; these internal QA Caddy listeners use http://.
 *
 * This returns source text ONLY, never writes volumes or reloads Caddy.
 * Host controller must enforce snapshot compare-and-swap and safe reload.
 */
export function renderQaTenantCaddyRoutes(manifest){
  const environment=manifest?.environment
  if(!Object.hasOwn(expectedHosts,environment)||manifest?.schemaVersion!==1
    ||!Array.isArray(manifest.entries)||manifest.entries.length>2000
    ||!SHA256.test(String(manifest.sha256||'')))
    throw Error('Only an exact versioned Test/UAT routing manifest can be rendered.')
  const rows=manifest.entries
  if(rows.some(r=>typeof r?.host!=='string'||!expectedHosts[environment].test(r.host)
    ||!target('api','3001').test(String(r.apiUpstream||''))
    ||!target('web','80').test(String(r.webUpstream||''))
    ||!/^[a-f0-9]{40}$/.test(String(r.buildSha||''))))
    throw Error('Untrusted tenant hostname, release revision or internal upstream.')
  if(new Set(rows.map(r=>r.host)).size!==rows.length
    ||rows.some((r,i)=>i>0&&rows[i-1].host>=r.host))
    throw Error('Tenant routes must be unique and canonically sorted.')
  const canonical=JSON.stringify({
    schemaVersion:1,environment,entries:rows,
  })
  const actual=createHash('sha256').update(canonical).digest('hex')
  if(actual!==manifest.sha256)throw Error('Routing manifest integrity digest mismatch.')
  const blocks=rows.map(row=>[
    'http://'+row.host+' {',
    '    @tenantApi path /api/*',
    '    handle @tenantApi {',
    '        reverse_proxy '+row.apiUpstream,
    '    }',
    '    handle {',
    '        reverse_proxy '+row.webUpstream,
    '    }',
    '}',
  ].join('\n'))
  return [
    '# Hi5Central QA tenant routes — generated, DO NOT edit manually',
    '# environment='+environment+' sha256='+actual,
    ...blocks,
    '',
  ].join('\n')
}
