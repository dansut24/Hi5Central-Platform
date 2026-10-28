const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../public/rmm-viewer/codec-compatibility.html'), 'utf8');

test('codec compatibility page checks all 5 codecs without opening a remote session', () => {
  for (const codec of ['video/vp8','video/vp9','video/h264','video/av1','video/h265','video/hevc']) {
    assert.ok(html.includes(codec), 'missing '+codec);
  }
  assert.match(html, /RTCRtpReceiver/);
  assert.match(html, /RTCRtpSender/);
  assert.match(html, /getCapabilities/);
  assert.doesNotMatch(html, /new RTCPeerConnection|new WebSocket|sendBeacon|fetch\(/);
  assert.doesNotMatch(html, /getDisplayMedia|getUserMedia/);
});

test('user explicitly opts into copying a local report', () => {
  assert.match(html, /getElementById\('copy'\)\.addEventListener\('click'/);
  assert.match(html, /navigator\.clipboard\.writeText\(json\)/);
  assert.match(html, /An advertised codec is only a prerequisite/);
});
