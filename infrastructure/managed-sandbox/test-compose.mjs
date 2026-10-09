import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if(process.env.GITHUB_ACTIONS!=='true' && process.env.HI5_PHASE10_SMOKE!=='true') {
  throw new Error('This synthetic preflight test must be explicitly requested.')
}
const source=dirname(fileURLToPath(import.meta.url))
const root=mkdtempSync(join(tmpdir(),'hi5-phase10-preflight-'))
const digest = name => name+'@sha256:'+'b'.repeat(64)

function values(environment) {
  const token=environment.toUpperCase()
  const p={
    COMPOSE_PROJECT_NAME:`hi5-sandbox-${environment}`,EDGE_NETWORK:`hi5central-sandbox-${environment}-edge`,
    DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',RUNTIME_ENVIRONMENT:environment,
    ROOT_DOMAIN:'hi5central.com',API_URL:`https://${environment}-api.hi5central.com`,
    MARKETING_URL:'https://hi5central.com',BACKGROUND_WORKERS_ENABLED:'false',
    POSTGRES_USER:`sandbox_${environment}`,POSTGRES_DB:`sandbox_${environment}`,
    POSTGRES_PASSWORD:token+'-'+'p'.repeat(64),REDIS_PASSWORD:token+'-'+'r'.repeat(64),
    MFA_ENCRYPTION_KEY:token+'-'+'m'.repeat(64),
    API_IMAGE:digest('ghcr.io/dansut24/hi5central-platform-api'),
    ITSM_IMAGE:digest('ghcr.io/dansut24/hi5central-platform-itsm'),
    POSTGRES_IMAGE:digest('public.ecr.aws/docker/library/postgres'),
    REDIS_IMAGE:digest('public.ecr.aws/docker/library/redis'),
    APP_URL:'',PORTAL_URL:'',ADMIN_URL:'',RMM_URL:'',
    COOKIE_DOMAIN:'',PRIMARY_TENANT_SLUG:'',
    FEATURE_MODE:environment==='uat'?'controlled':'all_enabled',
  }
  p.DATABASE_URL=`postgresql://${p.POSTGRES_USER}:${encodeURIComponent(p.POSTGRES_PASSWORD)}@postgres:5432/${p.POSTGRES_DB}`
  p.REDIS_URL=`redis://:${encodeURIComponent(p.REDIS_PASSWORD)}@redis:6379/0`
  return p
}
try {
  for(const env of ['uat','test']){
    const target=join(root,env)
    mkdirSync(target)
    for(const file of ['preflight.mjs','validate.mjs','compose.yml']) {
      copyFileSync(join(source,file),join(target,file))
    }
    const lines=Object.entries(values(env)).map(([k,v])=>`${k}=${v}`).join('\n')+'\n'
    const envPath=join(target,'runtime.env')
    writeFileSync(envPath,lines,{mode:0o600})
    chmodSync(envPath,0o600)
  }
  for(const env of ['uat','test']){
    const current=join(root,env)
    const peer=join(root,env==='uat'?'test':'uat','runtime.env')
    const passed=spawnSync(process.execPath,['preflight.mjs','--peer-env',peer],{
      cwd:current,encoding:'utf8',timeout:30000,
    })
    assert.equal(passed.status,0,`${env}: ${passed.stderr}`)
    const summary=JSON.parse(passed.stdout)
    assert.equal(summary.status,'static_preflight_passed')
    assert.equal(summary.activationApproved,false)
    assert.equal(summary.noChangesMade,true)
  }
  const wrong=join(root,'uat','runtime.env')
  // This error is checked before Docker Compose: the preflight must fail closed.
  writeFileSync(wrong,writeOf(values('uat')).replace('COOKIE_DOMAIN=','COOKIE_DOMAIN=.hi5central.com'),{mode:0o600})
  const failed=spawnSync(process.execPath,['preflight.mjs','--peer-env',join(root,'test','runtime.env')],{
    cwd:join(root,'uat'),encoding:'utf8',timeout:30000,
  })
  assert.notEqual(failed.status,0)
  assert.match(failed.stderr,/COOKIE_DOMAIN/)
  console.log('Phase 10 Compose static preflight: both environments PASS; unsafe domain rejected')
} finally {
  rmSync(root,{recursive:true,force:true})
}
function writeOf(o) {return Object.entries(o).map(([k,v])=>`${k}=${v}`).join('\n')+'\n'}
