/**
 * Run inside the development API container:
 *   node scripts/test-itsm-richtext.mjs
 * No database or tenant required.
 */
import assert from 'node:assert/strict'
import { sanitizeActivityHtml } from '../src/itsmRichText.js'

const tests = [
  ['strong text survives', '<p><strong>Fixed</strong></p>', /<strong>Fixed<\/strong>/],
  ['lists survive', '<ul><li>First</li><li>Second</li></ul>', /<li>Second<\/li>/],
  ['tables survive', '<table><tr><td>Value</td></tr></table>', /<td>Value<\/td>/],
  ['HTTPS image survives', '<img src="https://example.com/test.png" alt="Screenshot">', /src="https:\/\/example.com\/test.png"/],
  ['safe alignment survives', '<p class="rt-align-center">Aligned</p>', /class="rt-align-center"/],
]
let passed=0
for (const [label, html, expected] of tests) {
  assert.match(sanitizeActivityHtml(html),expected,label)
  passed++
}
for (const [label, html] of [
  ['script tag', '<script>alert(1)</script><p>Note</p>'],
  ['inline event', '<p onclick="alert(1)">Note</p>'],
  ['javascript href', '<a href="javascript:alert(1)">Text</a>'],
  ['data image', '<img src="data:image/svg+xml;base64,abc">'],
  ['http image', '<img src="http://example.com/a.png">'],
  ['SVG tag', '<svg onload="alert(1)"></svg>'],
  ['style injection', '<p style="color:red;position:absolute">Note</p>'],
]) {
  const cleaned = sanitizeActivityHtml(html)
  assert.doesNotMatch(cleaned,/(<script|<svg|onclick|javascript:|data:image|http:\/\/example.com\/a|position:absolute|color:red)/i,label)
  passed++
}
console.log('Rich note sanitiser tests: ' + passed + '/' + (tests.length+7) + ' passed')
