import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseViewerCodecCapabilities, parseViewerHardwarePreference, sanitizeViewerCodecObservation, sanitizeViewerCodecFailure } from '../src/rmmCodecNegotiation.js'

test('legacy and malformed receive capabilities preserve existing behaviour', () => {
  assert.equal(parseViewerCodecCapabilities(new URLSearchParams()), null)
  assert.deepEqual(parseViewerCodecCapabilities(new URLSearchParams('codec_caps_v1=1&video_codecs=av1')), {codecs:['av1'],h264_level4:false})
  assert.deepEqual(parseViewerCodecCapabilities(new URLSearchParams('codec_caps_v1=1&video_codecs=vp8,h265')), {codecs:['vp8','h265'],h264_level4:false})
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
  assert.equal(sanitizeViewerCodecObservation({...report,codec:'av1'},'valid')?.codec,'av1')
  assert.equal(sanitizeViewerCodecObservation({...report,codec:'h265'},'valid')?.codec,'h265')
  assert.equal(sanitizeViewerCodecObservation({...report,codec:'fake'},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,frames_decoded:NaN},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,frames_decoded:1},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,width:0},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,frames_dropped:100},'valid'),null)
  assert.equal(sanitizeViewerCodecObservation({...report,keyframes_decoded:0},'valid'),null)
})

test('all five codecs are advertised only through authenticated and bounded handshake', () => {
  const yes=parseViewerCodecCapabilities(new URLSearchParams(
    'codec_caps_v1=1&video_codecs=VP8,vp9,H264,AV1,H265&h264_level4=1'))
  assert.deepEqual(yes,{codecs:['vp8','vp9','h264','av1','h265'],h264_level4:true})
  assert.equal(parseViewerCodecCapabilities(new URLSearchParams(
    'codec_caps_v1=1&video_codecs=vp8,unsupported')),null)
  assert.equal(parseViewerCodecCapabilities(new URLSearchParams(
    'codec_caps_v1=1&video_codecs=vp8,av1,hevc')),null)
  assert.equal(parseViewerCodecCapabilities(new URLSearchParams(
    'codec_caps_v1=0&video_codecs=vp8,av1')),null)
  const tampered=sanitizeViewerCodecObservation({
    codec:'av1',session_id:'attacker-selected',frames_decoded:90,
    keyframes_decoded:2, frames_dropped:0,packets_received:140,
    width:1920,height:1080,backend:'hardware_fake'
  },'server-session')
  assert.equal(tampered.session_id,'server-session')
  assert.equal(Object.hasOwn(tampered,'backend'),false)
})

test('codec failure is limited to the authenticated session and two allowlisted failure causes', () => {
  const accepted=sanitizeViewerCodecFailure({
    codec:'AV1',reason:'media-negotiation-timeout',session_id:'spoof',
    permanent:true,backend:'arbitrary'
  },'authenticated')
  assert.deepEqual(accepted,{
    type:'viewer_codec_failure',session_id:'authenticated',codec:'av1',
    reason:'media-negotiation-timeout'
  })
  assert.equal(sanitizeViewerCodecFailure({codec:'vp8',reason:'network-disconnected'},'authenticated'),null)
  assert.equal(sanitizeViewerCodecFailure({codec:'fake',reason:'decode-unavailable'},'authenticated'),null)
  assert.equal(sanitizeViewerCodecFailure({codec:'av1',reason:'decode-unavailable'},''),null)
})

test('Viewer acceleration preference is bounded and defaults safely', () => {
  assert.equal(parseViewerHardwarePreference(new URLSearchParams()), 'auto')
  assert.equal(parseViewerHardwarePreference(new URLSearchParams('hw_accel=on')), 'on')
  assert.equal(parseViewerHardwarePreference(new URLSearchParams('hw_accel=off')), 'off')
  assert.equal(parseViewerHardwarePreference(new URLSearchParams('hw_accel=auto')), 'auto')
  assert.equal(parseViewerHardwarePreference(new URLSearchParams('hw_accel=force-gpu')), 'auto')
  assert.equal(parseViewerHardwarePreference(new URLSearchParams('hw_accel=ON')), 'auto')
})
