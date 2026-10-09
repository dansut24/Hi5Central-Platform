import test from 'node:test'
import assert from 'node:assert/strict'
import { assessPilotEdge, assessPilotEdges, creationArgs, PILOT_EDGE_DEFINITIONS } from './edge-networks.mjs'

function safe(env){
  return {Name:PILOT_EDGE_DEFINITIONS[env].name,Driver:'bridge',Scope:'local',
    Internal:true,Attachable:false,Ingress:false,Containers:{},
    Labels:{'com.hi5central.scope':'managed-customer-pilot',
      'com.hi5central.lifecycle':'phase12-network-only',
      'com.hi5central.environment':env}}
}
test('both missing edges can be prepared, never equates to an approved customer runtime',()=>{
  const result=assessPilotEdges({})
  assert.equal(result.canCreateMissing,true)
  assert.equal(result.allPreparedEmpty,false)
  assert.equal(result.noApplicationActivation,true)
})
test('only labelled empty internal bridges are considered safely prepared',()=>{
  for(const env of ['uat','test']) assert.equal(assessPilotEdge(safe(env),env).safe,true)
  const result=assessPilotEdges({
    [PILOT_EDGE_DEFINITIONS.uat.name]:safe('uat'),
    [PILOT_EDGE_DEFINITIONS.test.name]:safe('test'),
  })
  assert.equal(result.allPreparedEmpty,true)
  assert.equal(result.noApplicationActivation,true)
  assert.deepEqual(result.networkNames.sort(),[
    PILOT_EDGE_DEFINITIONS.uat.name,PILOT_EDGE_DEFINITIONS.test.name
  ].sort())
})
test('unexpected attachments, sharing, ingress, egress or labels block network preparation',()=>{
  for(const env of ['uat','test']){
    for(const change of [
      n=>{n.Internal=false},
      n=>{n.Driver='overlay'},
      n=>{n.Scope='swarm'},
      n=>{n.Attachable=true},
      n=>{n.Ingress=true},
      n=>{n.Containers={'1':{Name:'hi5central-prod-postgres'}}},
      n=>{n.Labels['com.hi5central.environment']='live'},
      n=>{delete n.Labels['com.hi5central.scope']},
      n=>{n.Name='hi5central'},
    ]){
      const n=safe(env);change(n)
      assert.equal(assessPilotEdge(n,env).safe,false)
      assert.equal(assessPilotEdges({[PILOT_EDGE_DEFINITIONS[env].name]:n}).canCreateMissing,false)
    }
  }
})
test('network creation parameters never expose host ports or permit external attachment',()=>{
  for(const env of ['uat','test']){
    const args=creationArgs(env)
    assert.ok(args.includes('--internal'))
    assert.ok(args.includes('--driver'))
    assert.ok(!args.includes('--attachable'))
    assert.equal(args.at(-1),PILOT_EDGE_DEFINITIONS[env].name)
  }
  assert.throws(()=>creationArgs('prod'))
})
