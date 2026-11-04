#!/usr/bin/env node
// Explicit development build for Hi5Central Chromium video trials.
// No QuickDesk UI, standalone server, user database, access-code page,
// external CDN, or production Viewer route is introduced by this script.
// Pin the upstream *source commit*, patch the authenticated browser
// identity and locally bundle its SPAKE2 dependencies.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync,
  copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const pin='f6651f0392f2d8d4ffda90461abf05dffdb4708e'
const out=process.argv[2] ? resolve(process.argv[2])
  :join(repoRoot,'apps/rmm/public/rmm-viewer/chromiumSession.pilot.mjs')
if(!out.endsWith('.mjs'))throw new Error('Chromium browser output must be .mjs')
const workspace=mkdtempSync(join(tmpdir(),'hi5central-chromium-pilot-'))
const upstream=join(workspace,'QuickDesk')
const command=(cmd,args,opts={})=>execFileSync(cmd,args,{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000,...opts,
})
try {
  mkdirSync(upstream,{recursive:true})
  command('git',['init','-q'],{cwd:upstream})
  command('git',['remote','add','origin','https://github.com/barry-ran/QuickDesk.git'],{cwd:upstream})
  command('git',['fetch','-q','--depth=1','origin',pin],{cwd:upstream})
  command('git',['checkout','-q','--detach','FETCH_HEAD'],{cwd:upstream})
  const actual=command('git',['rev-parse','HEAD'],{cwd:upstream}).trim()
  if(actual!==pin)throw new Error('Chromium upstream commit pin mismatch')

  // The patch also prevents different SPAKE2 and signaling client IDs.
  const patch=join(repoRoot,'third_party/quickdesk/patches/0001-h5c-bound-browser-client-id.patch')
  command('git',['apply','--unidiff-zero','--check',patch],{cwd:upstream})
  command('git',['apply','--unidiff-zero',patch],{cwd:upstream})

  // Dependencies are vendored into the final static ES module. They are
  // not loaded from QuickDesk's remote.html/esm.sh CDN importmap at runtime.
  command('npm',['install','--prefix',join(upstream,'WebClient'),
    '--no-save','--ignore-scripts','--no-audit','--no-fund',
    '@noble/curves@1.8.1','@noble/hashes@1.7.1'])
  const esbuild=join(repoRoot,'services/api/node_modules/.bin/esbuild')
  if(!existsSync(esbuild))throw new Error('Install platform API build dependencies first')
  mkdirSync(dirname(out),{recursive:true})
  command(esbuild,[join(upstream,'WebClient/js/protocol/session.js'),
    '--bundle','--platform=browser','--format=esm',
    '--minify','--legal-comments=external','--outfile='+out])
  const output=readFileSync(out,'utf8')
  if(output.includes('esm.sh/')||output.includes('unpkg.com/')||
      output.includes('cdn.jsdelivr.net/')||
      output.includes("from '@noble/") ||
      !output.includes('Session')) {
    throw new Error('Chromium session contains unbundled dependency or invalid exports')
  }
  // Legal notices must accompany the copied source and cryptographic
  // libraries in any customer-distributed artifact.
  copyFileSync(join(upstream,'LICENSE'),out+'.QUICKDESK-MIT.txt')
  copyFileSync(join(upstream,'WebClient/node_modules/@noble/curves/LICENSE'),
    out+'.NOBLE-CURVES-MIT.txt')
  copyFileSync(join(upstream,'WebClient/node_modules/@noble/hashes/LICENSE'),
    out+'.NOBLE-HASHES-MIT.txt')
  const hash=createHash('sha256').update(output).digest('hex')
  writeFileSync(out+'.manifest.json',JSON.stringify({
    product:'Hi5Central Chromium session pilot',
    source: 'barry-ran/QuickDesk',commit:pin,
    browserPatch:'0001-h5c-bound-browser-client-id.patch',
    dependencies:{'@noble/curves':'1.8.1','@noble/hashes':'1.7.1'},
    sha256:hash,sizeBytes:Buffer.byteLength(output),
    bundledAndOffline:true,productionEnabled:false,
  },null,2)+'\n')
  process.stdout.write('HI5_CHROMIUM_SESSION_SELFHOSTED_BUILT '+hash+' '+out+'\n')
} finally {
  rmSync(workspace,{recursive:true,force:true})
}
