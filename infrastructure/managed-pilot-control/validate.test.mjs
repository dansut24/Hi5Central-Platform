import test from 'node:test'
import assert from 'node:assert/strict'
import {parsePilotEnv,validatePilotEnvironment,validatePilotCompose} from './validate.mjs'

const digest='a'.repeat(64)
const apiImage='ghcr.io/dansut24/hi5central-platform-api@sha256:'+digest
const image=name=>'mirror.gcr.io/library/'+name+'@sha256:'+digest
const secret=(letter)=>letter.repeat(40)
const goodEnv={
  COMPOSE_PROJECT_NAME:'hi5central-pilot-control',
  DEPLOYMENT_MODE:'managed',TENANCY_MODE:'multi',RUNTIME_ENVIRONMENT:'live',
  FEATURE_MODE:'controlled',PLATFORM_ADMIN_MFA_REQUIRED:'true',PILOT_ADMIN_BOOTSTRAP_ENABLED:'true',BACKGROUND_WORKERS_ENABLED:'false',
  ROOT_DOMAIN:'hi5central.com',PRIMARY_TENANT_SLUG:'',COOKIE_DOMAIN:'',
  APP_URL:'',PORTAL_URL:'',RMM_URL:'',TURN_URL:'',
  ADMIN_URL:'https://pilot-admin.hi5central.com',
  API_URL:'https://pilot-control-api.hi5central.com',
  POSTGRES_USER:'pilot_user_a',POSTGRES_DB:'pilot_control_db',
  POSTGRES_PASSWORD:secret('a'),REDIS_PASSWORD:secret('b'),
  MFA_ENCRYPTION_KEY:secret('c'),CONNECT_CODE_HMAC_KEY:secret('d'),POSTGRES_IMAGE:image('postgres'),
  REDIS_IMAGE:image('redis'),API_IMAGE:apiImage,
  ADMIN_IMAGE:'ghcr.io/dansut24/hi5central-platform-admin@sha256:'+digest,
  DATABASE_URL:'postgresql://pilot_user_a:'+secret('a')+'@postgres:5432/pilot_control_db',
  REDIS_URL:'redis://:'+secret('b')+'@redis:6379/0',
}
const goodServices={
  postgres:{image:goodEnv.POSTGRES_IMAGE,networks:{pilot_data:null}},
  redis:{image:goodEnv.REDIS_IMAGE,networks:{pilot_data:null}},
  migrate:{image:apiImage,networks:{pilot_data:null}},
  api:{image:apiImage,networks:{pilot_data:null,pilot_edge:null}},
  admin:{image:goodEnv.ADMIN_IMAGE,networks:{pilot_edge:null}},
}
const goodModel={name:'hi5central-pilot-control',services:goodServices,
  networks:{pilot_data:{internal:true},
    pilot_edge:{external:true,name:'hi5central-pilot-control-edge'}}}
const copy=value=>JSON.parse(JSON.stringify(value))
test('private multi-tenant pilot control topology is accepted only as static plan',()=>{
  assert.deepEqual(validatePilotEnvironment(goodEnv),[])
  assert.deepEqual(validatePilotCompose(goodModel),[])
})
test('cannot target Dev/Live data, use broad cookie or reuse same secrets',()=>{
  const scenarios=[
    {TENANCY_MODE:'single'},
    {PLATFORM_ADMIN_MFA_REQUIRED:'false'},
    {PILOT_ADMIN_BOOTSTRAP_ENABLED:'false'},
    {ROOT_DOMAIN:'other.example.com'},
    {COOKIE_DOMAIN:'.hi5central.com'},
    {BACKGROUND_WORKERS_ENABLED:'true'},
    {ADMIN_URL:'https://admin.hi5central.com'},
    {DATABASE_URL:'postgresql://pilot_user_a:'+secret('a')+'@prod-postgres:5432/pilot_control_db'},
    {REDIS_URL:'redis://:'+secret('b')+'@legacy-redis:6379/0'},
    {REDIS_PASSWORD:secret('a')},
    {MFA_ENCRYPTION_KEY:'REPLACE_MFA_SECRET'},
    {CONNECT_CODE_HMAC_KEY:''},
    {API_IMAGE:'ghcr.io/dansut24/hi5central-platform-api:dev'},
  ]
  for(const override of scenarios){
    assert.notDeepEqual(validatePilotEnvironment({...goodEnv,...override}),[],
      'Expected rejection: '+Object.keys(override)[0])
  }
})
test('cannot add public ports, host mounts, privileged containers or legacy networks',()=>{
  const scenarios=[
    m=>{m.services.api.ports=[{published:3001,target:3001}]},
    m=>{m.services.admin.networks.hi5central=null},
    m=>{m.services.postgres.networks.pilot_edge=null},
    m=>{m.services.redis.privileged=true},
    m=>{m.services.api.volumes=[{source:'/var/run/docker.sock',target:'/var/run/docker.sock'}]},
    m=>{m.networks.pilot_data.internal=false},
    m=>{m.services.migrate.image='ghcr.io/dansut24/hi5central-platform-api:dev'},
    m=>{m.services.extra={image:apiImage,networks:{pilot_edge:null}}},
  ]
  for(const modify of scenarios){
    const altered=copy(goodModel);modify(altered)
    assert.notDeepEqual(validatePilotCompose(altered),[])
  }
})
test('duplicate or malformed operator config lines are forbidden',()=>{
  assert.deepEqual(parsePilotEnv('A=1\nB=\n#comment'),{A:'1',B:''})
  assert.throws(()=>parsePilotEnv('A=1\nA=2'),/Duplicate/)
  assert.throws(()=>parsePilotEnv('INVALID SETTING'),/Invalid/)
})

test('Single-owner bootstrap is allowed only with explicit policy consent in private pilot',()=>{
 assert.deepEqual(validatePilotEnvironment({...goodEnv,
   PILOT_ADMIN_APPROVAL_MODE:'single_owner',
   PILOT_BOOTSTRAP_SINGLE_OWNER_APPROVED:'true'}),[])
 for(const override of [
  {PILOT_ADMIN_APPROVAL_MODE:'single_owner'},
  {PILOT_ADMIN_APPROVAL_MODE:'invalid'},
  {PILOT_ADMIN_APPROVAL_MODE:'dual_control',PILOT_BOOTSTRAP_SINGLE_OWNER_APPROVED:'true'},
  {PILOT_ADMIN_APPROVAL_MODE:'single_owner',PILOT_BOOTSTRAP_SINGLE_OWNER_APPROVED:'false'},
 ]){
  assert.notDeepEqual(validatePilotEnvironment({...goodEnv,...override}),[])
 }
})
