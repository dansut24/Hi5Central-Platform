/**
 * Fast source-level regression guards for the public homepage redesign.
 * These complement (do not replace) the actual Vite build/browser QA.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
const main = read('apps/itsm/src/main.jsx')
const entry = read('apps/itsm/src/features/marketing/MarketingApp.jsx')
const marketing = read('apps/itsm/src/features/marketing/ProfessionalMarketingHome.jsx')
const css = read('apps/itsm/src/features/marketing/ProfessionalMarketingHome.css')
const signup = read('apps/itsm/src/features/marketing/SignupPage.jsx')
assert.match(main, /initialSurface\.kind === 'marketing'/)
assert.match(main, /window\.location\.pathname === '\/signup'/)
assert.match(main, /\?\s*SignupPage\s*:\s*MarketingApp/)
assert.match(entry, /import \{ ProfessionalMarketingHome \}/)
assert.match(entry, /<ProfessionalMarketingHome \/>/)
assert.match(marketing, /export function ProfessionalMarketingHome/)
for (const anchor of ['products', 'capabilities', 'deployment', 'questions']) {
  assert.ok(marketing.includes('id="' + anchor + '"'), 'Missing marketing section anchor: ' + anchor)
  assert.ok(marketing.includes('href="#' + anchor + '"'), 'Missing in-page navigation: ' + anchor)
}
assert.ok((marketing.match(/href="\/signup"/g) || []).length >= 3,
  'Prominent signup CTAs must keep pointing to the existing route')
assert.match(marketing, /company-portal\.hi5central\.com/,
  'Preserve the established requester Portal -portal hostname')
assert.match(marketing, /Example interface/)
assert.match(marketing, /Illustrative data/)
assert.match(marketing, /aria-expanded=\{open\}/)
assert.match(marketing, /aria-selected=\{active === item\.id\}/)
assert.match(marketing, /role="tabpanel"/)
assert.match(css, /\.h5m-page/)
assert.match(css, /@media \(max-width: 720px\)/)
assert.match(css, /prefers-reduced-motion/)
assert.ok(!/^\s*\.marketing-signup-card/m.test(css),
  'New homepage styling must not override existing signup styles')
assert.match(signup, /api\/v1\/auth\/signup/)
assert.match(signup, /api\/v1\/auth\/resend-verification/)
assert.match(signup, /SELF_HOST_SINGLE/, 'Preserve special self-hosted setup token')
console.log('PASS: public marketing routes, anchor navigation, -portal URL, signup and CSS isolation.')
