import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const source=readFileSync(new URL('../deployment/runtime-config-entrypoint.sh',import.meta.url),'utf8')

function render(overrides={}){
  const dir=mkdtempSync(join(tmpdir(),'hi5-sandbox-frontend-'))
  const output=join(dir,'runtime-config.js')
  try{
    const script=join(dir,'entrypoint.sh')
    const modified=source.replace('cat > /srv/runtime-config.js <<EOF',
      'cat > '+JSON.stringify(output)+' <<EOF')
    assert.notEqual(modified,source,'Entrypoint output anchor changed; review this test.')
    writeFileSync(script,modified)
    const run=spawnSync('sh',[script,'true'],{
      encoding:'utf8',timeout:5000,
      env:{
        PATH:process.env.PATH,
        DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',
        RUNTIME_ENVIRONMENT:'uat',FEATURE_MODE:'controlled',
        ROOT_DOMAIN:'hi5central.com',
        PRIMARY_TENANT_SLUG:'',
        API_URL:'https://pilot-uat-api.hi5central.com',
        RMM_URL:'',ADMIN_URL:'',APP_URL:'',PORTAL_URL:'',TURN_URL:'',
        ...overrides,
      },
    })
    assert.equal(run.status,0,run.stderr)
    const text=readFileSync(output,'utf8')
    assert.match(text,/window\.__HI5_CONFIG__/)
    return text
  }finally{
    rmSync(dir,{recursive:true,force:true})
  }
}
test('managed UAT has no inferred tenant or RMM/admin URL',()=>{
  const text=render()
  assert.match(text,/primaryTenantSlug: ""/)
  assert.match(text,/runtimeEnvironment: "uat"/)
  assert.match(text,/apiUrl: "https:\/\/pilot-uat-api\.hi5central\.com"/)
  assert.match(text,/rmmUrl: ""/)
  assert.match(text,/adminUrl: ""/)
})
test('managed Test also forces blank primary slug, including when a demo value is passed',()=>{
  const text=render({
    RUNTIME_ENVIRONMENT:'test',
    API_URL:'https://pilot-test-api.hi5central.com',
    PRIMARY_TENANT_SLUG:'demo-tenant',
  })
  assert.match(text,/primaryTenantSlug: ""/)
  assert.match(text,/runtimeEnvironment: "test"/)
  assert.match(text,/apiUrl: "https:\/\/pilot-test-api\.hi5central\.com"/)
})
test('existing internal single-tenant and Live behaviour is unaffected',()=>{
  for(const env of [
    {DEPLOYMENT_MODE:'managed',TENANCY_MODE:'single',RUNTIME_ENVIRONMENT:'dev'},
    {DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',RUNTIME_ENVIRONMENT:'live'},
    {DEPLOYMENT_MODE:'self_hosted',TENANCY_MODE:'single',RUNTIME_ENVIRONMENT:'live'},
  ]){
    const text=render({...env,PRIMARY_TENANT_SLUG:''})
    assert.match(text,/primaryTenantSlug: "demo-tenant"/)
  }
})
