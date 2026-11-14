import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../src/rmmAppPortal.js', import.meta.url), 'utf8')

test('unsigned package fetch selects source_kind before approval matching', () => {
  assert.match(source, /SELECT t\.id,t\.expires_at,t\.tenant_id,t\.revision_id,r\.source_kind,r\.source_config,r\.sha256,r\.installer_type/)
})

test('custom and catalogue App Portal installs persist as queued until Agent polls', () => {
  const custom = source.slice(source.indexOf('async function dispatchCustomInstall('),
    source.indexOf('async function dispatchCatalogueInstall('))
  const catalogue = source.slice(source.indexOf('async function dispatchCatalogueInstall('),
    source.indexOf('export function registerRmmAppPortalRoutes('))
  for (const fragment of [custom,catalogue]) {
    assert.match(fragment, /INSERT INTO rmm_agent_jobs/)
    assert.doesNotMatch(fragment, /UPDATE rmm_agent_jobs SET status='claimed'/)
    assert.doesNotMatch(fragment, /type: 'job_execute'/)
  }
})

test('uploaded package token survives legitimate delayed polling', () => {
  assert.match(source, /now\(\)\+interval '45 minutes'/)
})
