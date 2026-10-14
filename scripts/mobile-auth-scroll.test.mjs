import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoFile = (path) => readFileSync(
  fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8',
)

for (const name of ['itsm', 'rmm', 'admin']) {
  test(name + ': mobile auth scroll does not unlock the signed-in app shell', () => {
    const css = repoFile('apps/' + name + '/src/index.css')
    assert.match(css, /html,\s*body,\s*#root\s*\{[\s\S]*?overflow:\s*hidden\s*;/)
    assert.match(css, /html:has\(\.production-auth-shell\)/)
    assert.match(css, /html:has\(\.h5-account-login\)/)
    assert.match(css, /html:has\(\.production-auth-shell\)\s+body/)
    assert.match(css, /html:has\(\.production-auth-shell\)\s+#root/)
    assert.match(css, /html:has\(\.production-auth-shell\)\s+\.production-auth-shell/)
    assert.match(css, /min-height:\s*100svh/)
    assert.match(css, /min-height:\s*100dvh/)
    assert.match(css, /scroll-padding-bottom:\s*max\(120px,/)
    assert.match(css, /scroll-margin-bottom:\s*120px/)
    assert.match(css, /font-size:\s*16px/)
  })
}
test('MFA prompts scroll separately when the keyboard is open', () => {
  const css = repoFile('apps/itsm/src/features/security/ProductionMfaLoginEnhancer.css')
  assert.match(css, /\.production-mfa-modal\s*\{[\s\S]*?overflow-y:\s*auto/)
  assert.match(css, /\.production-mfa-modal-card\s*\{[\s\S]*?max-height:[^;]*100dvh/)
  assert.match(css, /\.production-mfa-code-field input\s*\{[\s\S]*?font-size:\s*16px/)
})
test('password reset modal is safe-area and mobile-keyboard scrollable', () => {
  const css = repoFile('apps/itsm/src/features/security/ProductionPasswordRecoveryEnhancer.css')
  assert.match(css, /\.production-password-modal-backdrop,[\s\S]*?\.production-password-overlay\s*\{[\s\S]*?overflow-y:\s*auto/)
  assert.match(css, /\.production-password-reset-card\s*\{[\s\S]*?max-height:[^;]*100dvh/)
  assert.match(css, /\.production-password-reset-card input\s*\{[\s\S]*?font-size:\s*16px/)
})
