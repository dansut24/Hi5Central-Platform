#!/usr/bin/env node
import { readFileSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseEnvironment, validateSandboxEnvironment, validateComposeGraph } from './validate.mjs'

const home=dirname(fileURLToPath(import.meta.url))
const current=resolve(home,'runtime.env')
const args=process.argv.slice(2)
if(args.length!==2 || args[0]!=='--peer-env' || !args[1]) {
  console.error('Usage: node preflight.mjs --peer-env /absolute/path/to/other/runtime.env')
  process.exit(2)
}
const peerPath=resolve(args[1])
function readProtected(path){
  const stat=lstatSync(path)
  if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)!==0){
    throw new Error('Sandbox runtime.env must be a regular file with chmod 600 and no symlink.')
  }
  return parseEnvironment(readFileSync(path,'utf8'))
}
try {
  const currentEnv=readProtected(current)
  const peerEnv=readProtected(peerPath)
  const errors=[
    ...validateSandboxEnvironment(currentEnv,peerEnv),
    ...validateSandboxEnvironment(peerEnv,currentEnv).map(x=>'Peer: '+x),
  ]
  if(errors.length){
    console.error('Sandbox configuration blocked:\n'+errors.map(x=>' - '+x).join('\n'))
    process.exit(1)
  }
  const run=spawnSync('docker',[
    'compose','--project-name',currentEnv.COMPOSE_PROJECT_NAME,
    '--env-file',current,'-f',resolve(home,'compose.yml'),'config','--format','json'
  ],{cwd:home,encoding:'utf8',timeout:30000,maxBuffer:1024*1024*10})
  if(run.status!==0){
    // Docker Compose's stderr may contain expanded secrets. Do not echo.
    throw new Error('Docker Compose configuration failed. Check file paths and variable interpolation locally.')
  }
  const config=JSON.parse(run.stdout)
  errors.push(...validateComposeGraph(config,currentEnv))
  if(errors.length){
    console.error('Sandbox topology blocked:\n'+errors.map(x=>' - '+x).join('\n'))
    process.exit(1)
  }
  // This is only static validation. It neither changes infrastructure nor
  // proves external DNS, certificates, independent operators or Redis ACLs.
  console.log(JSON.stringify({
    status:'static_preflight_passed',environment:currentEnv.RUNTIME_ENVIRONMENT,
    project:currentEnv.COMPOSE_PROJECT_NAME,
    peer:peerEnv.RUNTIME_ENVIRONMENT,
    noChangesMade:true,activationApproved:false,
    stillRequired:['Independent database and Redis instance verification',
      'Separate reviewed DNS/TLS changes','Two authenticated human approvals',
      'Full authenticated browser and RMM isolation tests'],
  },null,2))
} catch(error){
  console.error('Sandbox preflight failed:',error.message)
  process.exitCode=1
}
