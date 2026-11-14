import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const versions = ['windows11_25h2_admx_v2', 'windows11_26h2_admx_v1']
const dest = join(root, 'public', 'catalogue')
mkdirSync(dest, { recursive: true })
for (const version of versions) {
  const data = gunzipSync(readFileSync(join(root, 'catalogues', version + '.json.gz')))
  const parsed = JSON.parse(data.toString('utf8'))
  if (!Array.isArray(parsed.settings) || parsed.importedPolicyCount !== parsed.settings.length) {
    throw new Error('Invalid imported Windows policy catalogue: ' + version)
  }
  writeFileSync(join(dest, version + '.json'), data)
  console.log('Prepared ' + version + ': ' + parsed.settings.length + ' policies')
}
