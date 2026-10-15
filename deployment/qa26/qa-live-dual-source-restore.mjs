#!/usr/bin/env node
// Restore the exact QA26 Managed Production cutover, preserving original
// running and host-on-disk Caddyfile sources separately. Fails closed if either
// gateway was edited since the QA route switch; never reverts a peer's release.
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const prefix=process.argv[2]
if(!/^managed-live-[0-9]{12,16}$/.test(String(prefix||'')))
 throw Error('Usage: node qa-live-dual-source-restore.mjs managed-live-<timestamp>')
const backupVolume='hi5central_qa_live_route_rollback_backups'
const diskPath='/opt/hi5central/deployment/Caddyfile'
const sha=x=>createHash('sha256').update(x).digest('hex')
const docker=(args,input)=>{
 const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:90000,maxBuffer:10*1024*1024})
 if(r.status!==0)throw Error('docker '+args.slice(0,2).join(' ')+': '+String(r.stderr||r.stdout||'').slice(-400))
 return r.stdout
}
const helper=(cmd,input)=>docker(['run','--rm','-i','--network','none',
 '--mount','type=bind,source='+diskPath+',target=/host/Caddyfile',
 '--mount','type=volume,source='+backupVolume+',target=/backup',
 'busybox:1.36','sh','-c',cmd],input)
const originalActive=helper('cat /backup/'+prefix+'.live.Caddyfile')
const originalDisk=helper('cat /backup/'+prefix+'.disk.Caddyfile')
const running=docker(['exec','hi5central-web','cat','/etc/caddy/Caddyfile'])
const hostCurrent=helper('cat /host/Caddyfile')
const marker='    # QA26 LIVE CANARY BEGIN - exact Managed QA host, no other tenant'
const tail='    # QA26 LIVE CANARY END\n\n'
const restoreCandidate=(value,previous)=>{
 const start=value.indexOf(marker),end=value.indexOf(tail)
 if(start<0||end<start||value.indexOf(marker,start+5)>=0)throw Error('Expected exactly one QA Managed Live route.')
 const recovered=value.slice(0,start)+value.slice(end+tail.length)
 if(sha(recovered)!==sha(previous))
   throw Error('Existing gateway had independent changes; scoped rollback must be manually reviewed.')
 return recovered
}
restoreCandidate(running,originalActive)
restoreCandidate(hostCurrent,originalDisk)
const manifest=url=>{
 const p=spawnSync('curl',['-fsS','--max-time','8',url],{encoding:'utf8',timeout:12000})
 if(p.status!==0)throw Error('Cannot verify customer Live route.')
 return JSON.parse(p.stdout).sha
}
if(manifest('https://h5c-managed-qa26.hi5central.com/release-manifest.json')!==
   '4a363cf9054b0b3667fd450f36e354b704ec2166')
 throw Error('Actual Managed Production no longer at expected release.')
console.log('MANAGED_LIVE_RESTORE_PRECONDITIONS_PASS')
helper('set -eu; cat /backup/'+prefix+'.disk.Caddyfile > /host/Caddyfile')
docker(['exec','-i','hi5central-web','sh','-c',
 'cat >/tmp/qa-managed-restore-'+prefix+'.Caddyfile && caddy reload --config /tmp/qa-managed-restore-'+prefix+'.Caddyfile --adapter caddyfile'],
 originalActive)
const restoredActive=docker(['exec','hi5central-web','cat','/etc/caddy/Caddyfile'])
const restoredDisk=helper('cat /host/Caddyfile')
if(sha(restoredActive)!==sha(originalActive)||sha(restoredDisk)!==sha(originalDisk))
 throw Error('Independent Managed Live gateway recovery is incomplete.')
const actual=manifest('https://h5c-managed-qa26.hi5central.com/release-manifest.json')
if(actual==='4a363cf9054b0b3667fd450f36e354b704ec2166')
 throw Error('Managed QA Production is still routing to failed release.')
console.log('MANAGED_PROD_SCOPED_ROLLBACK_PASS',actual,sha(originalActive),sha(originalDisk))
