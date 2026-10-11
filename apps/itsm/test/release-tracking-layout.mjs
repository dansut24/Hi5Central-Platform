import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const css=readFileSync(new URL('../src/features/settings/TrackedConfigurationChanges.css',import.meta.url),'utf8')
const jsx=readFileSync(new URL('../src/features/settings/TrackedConfigurationChanges.jsx',import.meta.url),'utf8')
for(const selector of [
  '.hi5-tracked-config-row',
  '.hi5-tracked-config-selection',
  '.hi5-tracked-config-check',
  '.hi5-tracked-config-copy',
  '.hi5-tracked-config input[type="checkbox"]',
]){
  assert.ok(css.includes(selector),'Missing scoped responsive selector: '+selector)
}
assert.match(css,/grid-template-columns:18px minmax\(0,1fr\)/)
assert.match(css,/min-width:0/)
assert.match(css,/width:18px !important/)
assert.match(css,/@media\(max-width:650px\)/)
assert.ok(jsx.includes('className="hi5-tracked-config-check"'))
assert.ok(jsx.includes('className="hi5-tracked-config-copy"'))
assert.ok(jsx.includes('className="hi5-tracked-config-row"'))
console.log('PASS: checkbox rows stay in flow, text can shrink/wrap and mobile cards use scoped grid layout')
