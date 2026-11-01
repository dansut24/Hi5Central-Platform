import test from 'node:test'
import assert from 'node:assert/strict'
import { offeredPrimaryVideoCodec, canRetryOfferedCodec } from '../src/rmmCodecFailover.js'

const offer = codec => 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 104 105\r\na=rtpmap:104 ' + codec + '/90000\r\na=rtpmap:105 rtx/90000\r\n'
test('offered single primary RTP codec parsed from SDP', () => {
 for (const [name, expected] of [['HEVC','h265'],['H265','h265'],['VP8','vp8'],['VP9','vp9'],['AV1','av1'],['H264','h264']])
  assert.equal(offeredPrimaryVideoCodec(offer(name)), expected)
 assert.equal(offeredPrimaryVideoCodec(''), '')
 assert.equal(offeredPrimaryVideoCodec(offer('HEVC') + 'a=rtpmap:99 VP8/90000\r\n'), '')
})
test('codec retry bounded to actual offer, authenticated Viewer and one attempt', () => {
 const b={viewerClient:'browser',reportedCodec:'h265',offeredCodec:'h265',attempts:0,reason:'decode-unavailable'}
 assert.equal(canRetryOfferedCodec(b),true)
 assert.equal(canRetryOfferedCodec({...b,attempts:1}),false)
 assert.equal(canRetryOfferedCodec({...b,viewerClient:'native'}),false)
 assert.equal(canRetryOfferedCodec({...b,reportedCodec:'av1'}),false)
 assert.equal(canRetryOfferedCodec({...b,reportedCodec:'vp8',offeredCodec:'vp8'}),false)
 assert.equal(canRetryOfferedCodec({...b,reason:'network-disconnected'}),false)
})