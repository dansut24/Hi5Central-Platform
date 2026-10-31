import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseViewerCodecCapabilities, sanitizeViewerCodecObservation } from '../src/rmmCodecNegotiation.js'

test('legacy and malformed receive capabilities preserve existing behaviour', () => {
  assert.equal(parseViewerCodecCapabilities(new URLSearchParams()), null)
  assert.equal(parseViewerCodecCapabilities(new URLSearchParams('codec_caps_v1=1&video_codecs=vp8,unknown')), null)
  assert.equal(parseViewerCodecCapabilities(new URLSearchParams('codec_caps_v1=1&video_codecs=vp8,h266')), null)
  assert.equal(parseViewerCodecCapabilities(new URLSearchParams('codec_caps_v1=1&video_codecs=')), null)
})

test('real Viewer capabilities are bounded, normalised and deduplicated', () => {
  const value = parseViewerCodecCapabilities(new URLSearchParams(
    'codec_caps_v1=1&video_codecs=VP8,h264,vp8,vp9&h264_level4=1'))
  assert.deepEqual(value,{codecs:['vp8','h264','vp9'],h264_level4:true})
  assert.deepEqual(parseViewerCodecCapabilities(new URLSearchParams(
    'codec_caps_v1=1&video_codecs=vp8&h264_level4=1')),
    {codecs:['vp8'],h264_level4:false})
})

test('five-codec Viewer negotiation normalises HEVC but does not enable a sender', () => {
  assert.deepEqual(parseViewerCodecCapabilities(new URLSearchParams(
    'codec_caps_v1=1&video_codecs=VP8,AV1,HEVC,H265,VP9,H264&h264_level4=1')),
    {codecs:['vp8','av1','h265','vp9','h264'],h264_level4:true})
  assert.deepEqual(parseViewerCodecCapabilities(new URLSearchParams(
    'codec_caps_v1=1&video_codecs=av1,hevc')),
    {codecs:['av1','h265'],h264_level4:false})
})

test('decoder observations bind to server-authenticated session', () => {
  const report={
    codec:'h264', session_id:'attacker-supplied',
    frames_decoded:180, keyframes_decoded:2, frames_dropped:0,
    packets_received:390, width:1728, height:1080,
    malicious:'will be dropped',
  }
  const actual=sanitizeViewerCodecObservation(report,'authenticated-session')
  assert.equal(actual.session_id,'authenticated-session')
  assert.equal(Object.hasOwn(actual,'malicious'),false)
  assert.equal(actual.codec,'h264')
  assert.equal(sanitizeViewerCodecObservation({...report,codec:'av1'},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,codec:'hevc'},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,codec:'h265'},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,frames_decoded:NaN},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,frames_decoded:1},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,width:0},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,frames_dropped:100},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,keyframes_decoded:0},'valid'),null)
})
