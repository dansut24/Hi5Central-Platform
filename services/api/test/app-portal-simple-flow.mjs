import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { inspectAppPortalIcon } from '../src/appPortalIcon.js'
import { findInstalledApp } from '../src/appPortalInventory.js'

function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let i=0;i<8;i++) crc=(crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function pngChunk(type,data) {
  const typeBytes=Buffer.from(type)
  const c=Buffer.concat([typeBytes,data])
  const len=Buffer.alloc(4);len.writeUInt32BE(data.length)
  const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(c))
  return Buffer.concat([len,c,crc])
}
function png(width=16,height=16) {
  const header=Buffer.alloc(13)
  header.writeUInt32BE(width,0);header.writeUInt32BE(height,4)
  header[8]=8;header[9]=6
  const scan=Buffer.concat(Array.from({length:height},()=>Buffer.alloc(1+width*4)))
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(scan)),pngChunk('IEND',Buffer.alloc(0))])
}

test('a small real raster logo passes validation', () => {
  assert.deepEqual(inspectAppPortalIcon(png()),{mime:'image/png',extension:'.png',width:16,height:16})
})
test('refuse HTML, SVG and corrupt PNG payloads', () => {
  assert.ok(inspectAppPortalIcon(Buffer.from('<svg><script>alert(1)</script></svg>')).error)
  const broken=png();broken[25]^=1
  assert.match(inspectAppPortalIcon(broken).error,/checksum/i)
  assert.ok(inspectAppPortalIcon(png(1025,16)).error)
  assert.ok(inspectAppPortalIcon(png(100,16)).error)
})
test('refuse oversized or animated assets', () => {
  assert.ok(inspectAppPortalIcon(Buffer.alloc(512*1024+1)).error)
  const legit=png()
  const animated=Buffer.concat([legit.subarray(0,legit.length-12),
    pngChunk('acTL',Buffer.alloc(8)),legit.subarray(legit.length-12)])
  assert.match(inspectAppPortalIcon(animated).error,/animated/i)
})
const now=Date.parse('2026-11-13T21:40:00Z')
const app={name:'7Zip',version:'26.06',publisher:'Igor Pavlov'}
function inventory(software,at='2026-11-13T21:30:00Z') {
  return {software:{items:software},deep_inventory_collected_at:at}
}
test('automatic 7Zip name lookup handles the Windows installed-programs record',()=>{
  const got=findInstalledApp({app,inventory:inventory([
    {name:'7-Zip 26.06 (x64)',publisher:'Igor Pavlov',version:'26.06'}]),now})
  assert.equal(got.installed,true)
  assert.equal(got.installedVersion,'26.06')
  assert.equal(got.detection,'installed_software_inventory')
})
test('do not match a similarly named app with wrong publisher',()=>{
  const got=findInstalledApp({app,inventory:inventory([
    {name:'7-Zip 26.06 (x64)',publisher:'Not the same vendor',version:'26.06'}]),now})
  assert.equal(got.installed,false)
})
test('stale inventory cannot confirm installation',()=>{
  const got=findInstalledApp({app,inventory:inventory([
    {name:'7-Zip',publisher:'Igor Pavlov',version:'26.06'}],'2026-11-01T00:00:00Z'),now})
  assert.equal(got.installed,false)
  assert.equal(got.detection,'inventory_stale')
})
test('software not reported cannot be shown as installed',()=>{
  const got=findInstalledApp({app,inventory:inventory([]),now})
  assert.equal(got.installed,false)
  assert.equal(got.detection,'not_detected')
})
