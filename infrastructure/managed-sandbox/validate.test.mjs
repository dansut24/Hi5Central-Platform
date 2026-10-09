import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEnvironment, validateSandboxEnvironment, validateComposeGraph } from './validate.mjs'

const pin = path => path+'@sha256:'+'a'.repeat(64)
function example(environment) {
  const prefix=environment==='uat'?'UAT':'TEST'
  const pwd=prefix+'-example-only-not-for-use-postgres-'+'a'.repeat(32)
  const redis=prefix+'-example-only-not-for-use-redis-'+'b'.repeat(32)
  const p={
    DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',RUNTIME_ENVIRONMENT:environment,
    ROOT_DOMAIN:'hi5central.com',COMPOSE_PROJECT_NAME:`hi5-sandbox-${environment}`,
    EDGE_NETWORK:'hi5central',API_URL:`https://${environment}-api.hi5central.com`,
    MARKETING_URL:'https://hi5central.com',APP_URL:'',PORTAL_URL:'',RMM_URL:'',
    ADMIN_URL:'',COOKIE_DOMAIN:'',PRIMARY_TENANT_SLUG:'',
    FEATURE_MODE:environment==='uat'?'controlled':'all_enabled',
    BACKGROUND_WORKERS_ENABLED:'false',
    POSTGRES_DB:`h5_sandbox_${environment}`,POSTGRES_USER:`h5_${environment}`,
    POSTGRES_PASSWORD:pwd,REDIS_PASSWORD:redis,MFA_ENCRYPTION_KEY:prefix+'-'+'c'.repeat(64),
    POSTGRES_IMAGE:pin('public.ecr.aws/docker/library/postgres'),
    REDIS_IMAGE:pin('public.ecr.aws/docker/library/redis'),
    API_IMAGE:pin('ghcr.io/dansut24/hi5central-platform-api'),
    ITSM_IMAGE:pin('ghcr.io/dansut24/hi5central-platform-itsm'),
  }
  p.DATABASE_URL=`postgresql://${p.POSTGRES_USER}:${encodeURIComponent(pwd)}@postgres:5432/${p.POSTGRES_DB}`
  p.REDIS_URL=`redis://:${encodeURIComponent(redis)}@redis:6379/0`
  return p
}
function rendered(v){
  return {
    name:v.COMPOSE_PROJECT_NAME,
    networks:{
      private_data:{internal:true,name:'private-only'},
      managed_edge:{external:true,name:v.EDGE_NETWORK},
    },
    services:{
      postgres:{networks:{private_data:{}},volumes:[{type:'volume',source:'sandbox_postgres',target:'/var/lib/postgresql/data'}],healthcheck:{}},
      redis:{networks:{private_data:{}},volumes:[{type:'volume',source:'sandbox_redis',target:'/data'}],healthcheck:{}},
      migrate:{networks:{private_data:{}},image:v.API_IMAGE},
      api:{networks:{private_data:{},managed_edge:{}},image:v.API_IMAGE},
      itsm:{networks:{managed_edge:{}},image:v.ITSM_IMAGE,environment:{API_URL:v.API_URL,RMM_URL:''}},
    },
  }
}
test('isolated UAT and Test configuration passes strict read-only checks',()=>{
  const uat=example('uat'), other=example('test')
  assert.deepEqual(validateSandboxEnvironment(uat,other),[])
  assert.deepEqual(validateSandboxEnvironment(other,uat),[])
  assert.deepEqual(validateComposeGraph(rendered(uat),uat),[])
})
test('interpolation, duplicate keys and shell directives are rejected',()=>{
  assert.throws(()=>parseEnvironment('A=1\nA=2'),/Duplicate/)
  assert.throws(()=>parseEnvironment('export A=1'),/Invalid/)
  assert.throws(()=>parseEnvironment('A=$(cat /etc/passwd)'),/forbidden/)
  assert.deepEqual(parseEnvironment('# Comment\nA=hello\nB="testing"\n'),{A:'hello',B:'testing'})
})
test('all sensitive endpoint, cookie, and image regressions are rejected',()=>{
  const peer=example('test')
  for(const [key,value] of [
    ['TENANCY_MODE','single'],['RUNTIME_ENVIRONMENT','live'],
    ['COMPOSE_PROJECT_NAME','hi5central-prod'],
    ['API_URL','https://api.hi5central.com'],
    ['DATABASE_URL','postgresql://user:pw@production-pg:5432/hi5central'],
    ['REDIS_URL','redis://:secret@production-cache:6379/0'],
    ['APP_URL','https://hi5central.com'],
    ['RMM_URL','https://acmeuat-rmm.hi5central.com'],
    ['COOKIE_DOMAIN','.hi5central.com'],
    ['BACKGROUND_WORKERS_ENABLED','true'],
    ['POSTGRES_IMAGE','postgres:17-alpine'],
    ['API_IMAGE','ghcr.io/dansut24/hi5central-platform-api:dev'],
    ['REDIS_PASSWORD',peer.REDIS_PASSWORD],
    ['POSTGRES_DB',peer.POSTGRES_DB],
  ]) {
    const current={...example('uat'),[key]:value}
    assert.ok(validateSandboxEnvironment(current,peer).length, key+' must fail')
  }
})
test('peer reuse and invalid private networking never pass topology validation',()=>{
  const base=example('uat')
  assert.ok(validateSandboxEnvironment(base,{...example('test'),POSTGRES_PASSWORD:base.POSTGRES_PASSWORD}).length)
  for(const mutate of [
    c=>{c.services.postgres.networks.managed_edge={}},
    c=>{c.services.redis.ports=['6379:6379']},
    c=>{c.services.api.ports=['3001:3001']},
    c=>{c.networks.private_data.internal=false},
    c=>{c.networks.managed_edge.external=false},
    c=>{c.services.itsm.environment.API_URL='https://api.hi5central.com'},
    c=>{c.services.rmm={networks:{managed_edge:{}}}},
    c=>{c.services.postgres.volumes=[{type:'bind',source:'/var/run/docker.sock',target:'/host'}]},
  ]){
    const x=rendered(base)
    mutate(x)
    assert.ok(validateComposeGraph(x,base).length)
  }
})
export {example}
