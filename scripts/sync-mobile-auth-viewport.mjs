#!/usr/bin/env node
// Canonical mobile-auth viewport contract for all Hi5Central frontends.
// Run --check in CI; no separate app is allowed to drift from this file.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const canonical = readFileSync(resolve('scripts/mobile-auth-viewport.canonical.css'), 'utf8')
const paths = ['itsm', 'rmm', 'admin'].map(app =>
  resolve(`apps/${app}/src/styles/mobile-auth-viewport.css`)
)
if (process.argv.includes('--check')) {
  let mismatch = false
  for (const target of paths) {
    const current = readFileSync(target, 'utf8')
    if (current !== canonical) { console.error('Auth viewport CSS drift:', target); mismatch = true }
  }
  if (mismatch) process.exit(1)
  console.log('One canonical authentication viewport stylesheet matches ITSM, RMM and Admin.')
} else {
  paths.forEach(target => writeFileSync(target, canonical))
  console.log('Synced canonical authentication viewport across ITSM, RMM and Admin.')
}
