// Generates a synthetic, exact-host Caddyfile for syntax validation against
// the same major/minor Caddy version used by QA on the IONOS VPS.
// Never writes to a running proxy or uses customer data.
import {buildHostRoutingManifest} from '../src/runtimePoolControl.js'
import {renderQaTenantCaddyRoutes,renderQaTenantTrustedHostHandles} from '../src/renderQaTenantCaddyRoutes.js'

const now=new Date('2026-10-15T11:30:00Z'),sha='d'.repeat(40)
const entries=['ci-managed-a','ci-custom-a','ci-managed-b','ci-custom-b'].map((slug,index)=>{
  const pool='hi5pool-test-'+slug
  return {
    tenant_id:'11111111-1111-4111-8111-111111111111',
    slug,itsm_entitled:true,
    update_mode:index%2?'admin_controlled':'hi5_managed',
    environment:'test',pool_id:pool,build_sha:sha,pool_build_sha:sha,
    pool_state:'verified',
    api_target:pool+'-api:3001',web_target:pool+'-web:80',
    verified_at:'2026-10-15T11:28:00Z',last_seen_at:'2026-10-15T11:29:00Z',
  }
})
const manifest=buildHostRoutingManifest({environment:'test',rows:entries,now})
if(process.argv.includes('--trusted')){
  process.stdout.write([
    'http://test.hi5central.com {',
    renderQaTenantTrustedHostHandles(manifest),
    '    @fallbackApi path /api/*',
    '    handle @fallbackApi {',
    '        reverse_proxy control-server:3001',
    '    }',
    '    handle {',
    '        reverse_proxy itsm-web:80',
    '    }',
    '}','',
  ].join('\n'))
}else process.stdout.write(renderQaTenantCaddyRoutes(manifest))
