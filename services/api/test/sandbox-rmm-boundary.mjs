import assert from 'node:assert/strict'
import test from 'node:test'
import { createSandboxRmmGuard,sandboxRmmBlocked } from '../src/sandboxRmmBoundary.js'

test('ITSM Test and UAT cannot operate ANY RMM API namespace',()=>{
  const routes=[
    '/api/v1/rmm/remote-sessions','/api/v1/rmm/devices/123/power',
    '/api/v1/rmm/agent/enrollment-packages','/api/v1/rmm/automations',
    '/api/v1/rmm/devices','/api/v1/agent/enroll',
    '/api/v1/agent/devices/jobs','/api/v1/agent/devices/telemetry',
    '/api/v1/agent/installers',
  ]
  for(const environment of ['test','uat']){
    for(const path of routes)assert.equal(sandboxRmmBlocked(environment,path),true,environment+' '+path)
    for(const path of ['/api/v1/organisation','/api/v1/itsm-records','/api/v1/release-management/configuration-changes','/api/v1/agentular']){
      assert.equal(sandboxRmmBlocked(environment,path),false,path)
    }
  }
})
test('Live RMM and isolated internal Dev remain untouched',()=>{
  for(const environment of ['live','dev']) {
    for(const path of ['/api/v1/rmm/remote-sessions','/api/v1/agent/enroll'])
      assert.equal(sandboxRmmBlocked(environment,path),false)
  }
})
test('Middleware rejects before any downstream side effect',async()=>{
  let called=0
  const next=async()=>{called++;return {passed:true}}
  const c={req:{path:'/api/v1/rmm/devices/123/power'},json:(body,status)=>({status,body})}
  const response=await createSandboxRmmGuard('uat')(c,next)
  assert.equal(response.status,403)
  assert.match(response.body.error,/Live tenant/)
  assert.equal(called,0)
  const normal=await createSandboxRmmGuard('uat')(
    {req:{path:'/api/v1/itsm-records'},json:c.json},next)
  assert.equal(normal.passed,true)
  assert.equal(called,1)
})
