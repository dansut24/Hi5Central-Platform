import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

const ui=readFileSync(new URL('../../../apps/admin/src/features/admin/CertifiedReleaseControls.jsx',import.meta.url),'utf8')
test('approved Dev submission displays authoritative published version without changing immutable notes',()=>{
 assert.match(ui,/const publishedBySha=new Map/)
 assert.match(ui,/current\?\.status==='approved'\?currentPublished\?\.version_label/)
 assert.match(ui,/publishedBySha\.get\(item\.build_sha\)\?\.version_label/)
 assert.match(ui,/Dev originally submitted as/)
 assert.match(ui,/audited published release number is/)
 assert.match(ui,/currentCustomerVersion\|\|'Unversioned'/)
 assert.match(ui,/current\.notes\?\.entries/)
})
test('release list refresher clears old read errors only on successful reads',()=>{
 assert.match(ui,/if\(releases\.status==='fulfilled'\)setData/)
 assert.match(ui,/if\(proposals\.status==='fulfilled'\)/)
 assert.match(ui,/if\(releases\.status==='rejected'\)/)
 assert.match(ui,/if\(proposals\.status==='rejected'\)/)
 assert.match(ui,/setError\(readErrors\.join\(' '\)\)/)
 assert.match(ui,/setMessage\('Customer release number corrected to '/)
})
