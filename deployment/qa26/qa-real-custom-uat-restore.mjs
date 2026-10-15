#!/usr/bin/env node
// Restore only Custom QA UAT gateway from this job's durable before-snapshot.
// Independent of the in-process watchdog; no Live, Test or shared gateway edits.
import {spawnSync} from 'node:child_process'
const [snapshot,currentSha,previousSha]=process.argv.slice(2)
const SHA=/^[a-f0-9]{40}$/
if(!/^uat-before-real-route-[0-9]+[.]Caddyfile$/.test(String(snapshot||''))
   ||!SHA.test(String(currentSha||''))||!SHA.test(String(previousSha||'')))
  throw Error('Require exact UAT snapshot and current/previous immutable SHA40.')
const gateway='hi5central-uat-gateway'
const currentHost='https://h5c-custom-qa26-uat.hi5central.com/api/v1/updates/version'
const sharedHost='https://uat-api.hi5central.com/api/v1/updates/version'
const backup='hi5central_qa_uat_route_rollback_backups'
const config='hi5central-uat_gateway_runtime_config'
const docker=(args)=>{
  const p=spawnSync('docker',args,{encoding:'utf8',timeout:75000})
  if(p.status!==0)throw Error('Docker restore error: '+String(p.stderr||'').slice(-500))
  return p.stdout
}
const http=url=>{
  const p=spawnSync('curl',['-fsS','--max-time','8',url],{encoding:'utf8',timeout:12000})
  if(p.status!==0)throw Error('UAT public status unavailable')
  return JSON.parse(p.stdout).sha
}
if(http(currentHost)!==currentSha||http(sharedHost)!==previousSha)
  throw Error('Actual UAT route differs from rollback preconditions.')
docker(['run','--rm','--network','none',
  '--mount','type=volume,source='+config+',target=/gateway',
  '--mount','type=volume,source='+backup+',target=/backup',
  'busybox:1.36','sh','-c',
  'set -eu; test -s /backup/'+snapshot+
  '; cp /backup/'+snapshot+' /gateway/Caddyfile; chmod 644 /gateway/Caddyfile'])
docker(['exec',gateway,'caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
if(http(currentHost)!==previousSha||http(sharedHost)!==previousSha)
  throw Error('UAT restore did not return to the previous immutable release.')
console.log('CUSTOM_UAT_RECOVERED',previousSha)
