import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {validateHostRequest,requestTrustedHostAction} from '../src/releaseHostTransport.js'

const sha='a'.repeat(40)
const jobId='e70768bc-228c-4f41-8654-743808086c4d'
const leaseToken='64776720-ab12-49c7-922f-c13f7b5ddd18'
const request={mode:'apply',environment:'uat',slug:'h5c-custom-qa26',
 sha,jobId,leaseToken,leaseFence:12}
test('socket transport validates an exact tenant, stage, SHA and DB fencing',()=>{
 assert.equal(validateHostRequest(request).leaseFence,12)
 for(const variant of [
  {...request,slug:'../../etc/passwd'},
  {...request,sha:'bad'},
  {...request,environment:'root'},
  {...request,leaseToken:'attacker'},
  {...request,leaseFence:0},
  {...request,mode:'exec'},
  {...request,mode:'stage',environment:'uat'},
  {...request,mode:'restore',backup:'../../secret'},
 ]){
  assert.throws(()=>validateHostRequest(variant))
 }
})
test('generic queue caller accepts only an explicit trusted proof over Unix socket',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'h5c-host-ipc-'))
 const path=join(dir,'host.sock')
 const server=net.createServer(socket=>{
  let buf=''
  socket.on('data',chunk=>{
   buf+=chunk.toString()
   if(!buf.includes('\n'))return
   const command=JSON.parse(buf.slice(0,buf.indexOf('\n')))
   assert.equal(command.jobId,jobId)
   assert.equal(command.sha,sha)
   socket.end(JSON.stringify({ok:true,proof:{status:'verified',
    buildSha:sha,environment:'uat',host:'h5c-custom-qa26-uat.hi5central.com'}})+'\n')
  })
 })
 try{
  await new Promise((resolve,reject)=>server.listen(path,resolve).once('error',reject))
  const result=await requestTrustedHostAction(request,{socketPath:path,timeoutMs:2000})
  assert.equal(result.status,'verified')
  assert.equal(result.buildSha,sha)
 }finally{
  await new Promise(resolve=>server.close(resolve))
  rmSync(dir,{recursive:true,force:true})
 }
})
test('no host connection, arbitrary command or absent independent proof always fails',async()=>{
 await assert.rejects(requestTrustedHostAction(request,{
  socketPath:'/tmp/h5c-definitely-missing-'+process.pid+'.sock',timeoutMs:1000,
 }),/Trusted host transport unavailable/)
})
