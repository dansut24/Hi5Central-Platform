import assert from 'node:assert/strict'
import { normalizeStreamCoreVideoCodecs,normalizeStreamCoreBrowserFamily } from '../src/rmmStreamCoreCodecCaps.mjs'
assert.deepEqual(normalizeStreamCoreVideoCodecs('vp9,VP8,H265,av1,h264,vp8'),['vp9','vp8','h265','av1','h264'])
assert.deepEqual(normalizeStreamCoreVideoCodecs('vp8,hevc,unknown,vp9'),['vp8','vp9'])
assert.deepEqual(normalizeStreamCoreVideoCodecs(''),[])
assert.deepEqual(normalizeStreamCoreVideoCodecs('vp8,'.repeat(40)),[])
assert.deepEqual(normalizeStreamCoreVideoCodecs({codecs:['vp8']}),[])
assert.equal(normalizeStreamCoreBrowserFamily('ios-safari'),'ios-safari')
assert.equal(normalizeStreamCoreBrowserFamily('ios-safari attacker'),'other')
assert.equal(normalizeStreamCoreBrowserFamily('desktop'),'other')
console.log('PASS: RMM StreamCore viewer capability query clamps, filters and deduplicates codecs')
