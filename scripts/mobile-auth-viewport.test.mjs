import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source=readFileSync('scripts/mobile-auth-viewport.canonical.css','utf8')
for(const app of ['itsm','rmm','admin']){
  test(`${app} always imports identical shared authentication viewport after other styles`,()=>{
    const target=readFileSync(`apps/${app}/src/styles/mobile-auth-viewport.css`,'utf8')
    const main=readFileSync(`apps/${app}/src/main.jsx`,'utf8')
    assert.equal(target,source,`${app} drifted from canonical auth stylesheet`)
    const imports=main.split('\n').filter(x=>/^import /.test(x))
    assert.equal(imports.at(-1), "import './styles/mobile-auth-viewport.css'")
  })
}
test('current and future login components release html body and root scrolling',()=>{
  assert.match(source,/html:has\(\.production-auth-shell\)/)
  assert.match(source,/html:has\(\[data-hi5-auth-screen\]\)/)
  assert.match(source,/overflow-y: auto !important/)
  assert.match(source,/html:has\(\.production-auth-shell\) #root/)
  assert.match(source,/height: auto !important/)
  assert.match(source,/scroll-padding-bottom/)
  assert.match(source,/safe-area-inset-bottom/)
  assert.match(source,/font-size: 16px !important/)
  assert.match(source,/\.production-mfa-modal/)
  assert.match(source,/\.production-password-overlay/)
  assert.match(source,/\.production-password-reset-card/)
})
test('all existing login entry points use the canonical auth shell',()=>{
  for(const file of [
   'apps/itsm/src/production/ProductionWorkspaceBootstrap.jsx',
   'apps/rmm/src/production/ProductionRmmBootstrap.jsx',
   'apps/admin/src/features/admin/PlatformAdminApp.jsx',
  ]){
    const source=readFileSync(file,'utf8')
    assert.match(source,/className="production-auth-shell"/,`${file} must share the auth shell`)
  }
})
