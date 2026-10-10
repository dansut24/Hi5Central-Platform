#!/usr/bin/env node
// Static-only inspection. This program never creates containers, DNS or users.
import { readFileSync, lstatSync } from 'node:fs'
import { dirname,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parsePilotEnv,validatePilotEnvironment,validatePilotCompose } from './validate.mjs'

if(process.argv.length!==3 || process.argv[2]!=='--check'){
  console.error('Usage: node preflight.mjs --check')
  process.exit(2)
}
const root=dirname(fileURLToPath(import.meta.url))
const runtime=resolve(root,'runtime.env')
try {
  const stat=lstatSync(runtime)
  if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0){
    throw new Error('Pilot runtime.env must be an owner-only regular file (chmod 600).')
  }
  const env=parsePilotEnv(readFileSync(runtime,'utf8'))
  const errors=validatePilotEnvironment(env)
  if(errors.length)throw new Error(errors.join('; '))
  const docker=spawnSync('docker',['compose','--env-file',runtime,'-f',
    resolve(root,'compose.yml'),'config','--format','json'],{
      cwd:root,encoding:'utf8',timeout:30000,maxBuffer:6*1024*1024,
    })
  if(docker.status!==0){
    // Compose diagnostics may expand credentials, so do not echo stderr.
    throw new Error('Compose failed to parse private pilot configuration.')
  }
  const graph=JSON.parse(docker.stdout)
  const topologyErrors=validatePilotCompose(graph)
  if(topologyErrors.length)throw new Error(topologyErrors.join('; '))
  console.log(JSON.stringify({
    status:'static_preflight_passed',
    project:env.COMPOSE_PROJECT_NAME,
    publicRoutesCreated:false,containersCreated:false,
    dataAccessAllowed:false,readyForCustomerActivation:false,
    blockers:[
      'Human verified platform administrator enrolment and MFA',
      'Protected operator key custody, backup and disaster recovery tests',
      'Independent operator approvals and separately audited live ingress',
      'Scoped SMTP relay, exact DNS/TLS and browser tests',
    ],
  },null,2))
}catch(error){
  console.error('Managed pilot control plane is NOT ready:',error.message)
  process.exitCode=1
}
