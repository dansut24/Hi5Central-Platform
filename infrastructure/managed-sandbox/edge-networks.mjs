import { execFileSync } from 'node:child_process'

export const PILOT_EDGE_DEFINITIONS = Object.freeze({
  uat: Object.freeze({name:'hi5central-sandbox-uat-edge',environment:'uat'}),
  test: Object.freeze({name:'hi5central-sandbox-test-edge',environment:'test'}),
})
export const PILOT_LABELS = Object.freeze({
  'com.hi5central.scope':'managed-customer-pilot',
  'com.hi5central.lifecycle':'phase12-network-only',
})

export function assessPilotEdge(network, environment) {
  const def=PILOT_EDGE_DEFINITIONS[environment]
  if(!def) throw new Error('Unsupported sandbox environment.')
  if(!network) return {state:'missing',safe:false}
  const errors=[]
  if(network.Name!==def.name) errors.push('Name mismatch')
  if(network.Driver!=='bridge' || network.Scope!=='local')
    errors.push('Dedicated local bridge driver required')
  if(network.Internal!==true) errors.push('Network must block outside egress')
  if(network.Attachable) errors.push('No attachable/standalone access permitted')
  if(network.Ingress) errors.push('Swarm ingress is forbidden')
  for(const [key,value] of Object.entries(PILOT_LABELS)) {
    if(network.Labels?.[key]!==value) errors.push('Missing reviewed label: '+key)
  }
  if(network.Labels?.['com.hi5central.environment']!==environment)
    errors.push('Environment label does not match')
  const attached=Object.values(network.Containers||{}).filter(Boolean)
  if(attached.length) errors.push('Pilot edge must remain empty before approval')
  return {state:errors.length?'conflict':'prepared_empty',safe:errors.length===0,errors,
    attachedCount:attached.length}
}

export function assessPilotEdges(networks) {
  const entries={}
  for(const [environment,def] of Object.entries(PILOT_EDGE_DEFINITIONS)) {
    entries[environment]=assessPilotEdge(networks?.[def.name]||null,environment)
  }
  const names=Object.values(PILOT_EDGE_DEFINITIONS).map(x=>x.name)
  const existingNames=new Set(Object.keys(networks||{}))
  return {entries,canCreateMissing:Object.values(entries).every(x=>x.state==='missing'||x.state==='prepared_empty'),
    allPreparedEmpty:Object.values(entries).every(x=>x.state==='prepared_empty'),
    noApplicationActivation:true,networkNames:names.filter(name=>existingNames.has(name))}
}

export function dockerNetworkInventory(run=(args)=>execFileSync('docker',args,{encoding:'utf8',timeout:12000,maxBuffer:1024*1024})) {
  const networks={}
  for(const def of Object.values(PILOT_EDGE_DEFINITIONS)){
    const ids=run(['network','ls','--filter','name=^'+def.name+'$','--format','{{.Name}}'])
      .trim().split(/\r?\n/).filter(name=>name===def.name)
    if(ids.length){
      const inspected=JSON.parse(run(['network','inspect',def.name]))
      networks[def.name]=inspected[0]
    }
  }
  return networks
}

export function creationArgs(environment) {
  const def=PILOT_EDGE_DEFINITIONS[environment]
  if(!def) throw new Error('Unsupported environment')
  const args=['network','create','--driver','bridge','--internal']
  for(const [key,value] of Object.entries({...PILOT_LABELS,'com.hi5central.environment':environment})){
    args.push('--label',key+'='+value)
  }
  args.push(def.name)
  return args
}
