import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const sql=readFileSync(new URL('../migrations/platform-admin/173_release_to_customers_fanout_audit_event.sql',import.meta.url),'utf8')
const release=readFileSync(new URL('../src/certifiedTenantReleaseRoutes.js',import.meta.url),'utf8')
test('audit event constraint explicitly accepts release_to_customers without deleting older audit kinds',()=>{
 assert.match(sql,/event_type IN\s*\(\s*'approved','revoked','scan','failed','release_to_customers'\)/)
 assert.match(sql,/IF definition LIKE '%release_to_customers%'/)
 assert.match(sql,/Unrecognised event type constraint/)
 assert.match(release,/VALUES\(\$1,'release_to_customers',\$2,\$3::jsonb\)/)
 assert.match(release,/releaseToCustomers\?'release.published_to_customers'/)
})
