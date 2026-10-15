import {readFileSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

/**
 * CI-only stamp for the exactly reviewed QA26 PR commit.
 * Do not use this to publish releases or retag official Production images.
 */
const sha=String(process.argv[2]||'').toLowerCase()
if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Expected immutable 40-character commit SHA')
const file=fileURLToPath(new URL('../release-manifest.json',import.meta.url))
const value=JSON.parse(readFileSync(file,'utf8'))
if(value.schemaVersion!==1||!Array.isArray(value.commits))
  throw Error('Unexpected release manifest schema; cannot stamp')
const stamped={
  ...value,sha,
  version:`qa26-pr69-${sha.slice(0,12)}`,
  releaseName:`QA26 PR69 test candidate ${sha.slice(0,12)}`,
  builtAt:new Date().toISOString(),
}
writeFileSync(file,JSON.stringify(stamped,null,2)+'\n')
console.log('QA26 API release manifest stamped with verified commit: '+sha)
