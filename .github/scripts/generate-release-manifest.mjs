// Build-time inventory of code and schema changes. No manual feature
// registration is required. This tool runs inside trusted GitHub CI.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function git(args) {
  return execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024}).trim()
}
const sha=git(['rev-parse','HEAD'])
const committedAt=git(['show','-s','--format=%cI','HEAD'])
const commits=git(['log','-100','--format=%H%x09%cI%x09%s'])
  .split('\n').filter(Boolean).map(line=>{
    const [id,date,...rest]=line.split('\t')
    const subject=rest.join('\t').trim().slice(0,240)
    const changed=git(['diff-tree','--root','--no-commit-id','--name-only','-r','-m','--first-parent',id])
      .split('\n').filter(Boolean)
    const files=[...new Set(changed)].slice(0,150)
    const migrations=files.filter(file=>/^services\/api\/migrations\/.+\.sql$/.test(file))
    const components=[...new Set(files.map(file=>
      file.startsWith('apps/itsm/')?'ITSM':
      file.startsWith('apps/rmm/')?'RMM':
      file.startsWith('apps/admin/')?'Platform Admin':
      file.startsWith('services/api/')?'API & services':
      file.startsWith('packages/')?'Shared components':
      file.startsWith('.github/')?'Delivery':'Other'
    ))]
    const kind=/^feat(\([^)]+\))?[!:]/i.test(subject)?'feature':
      /^fix(\([^)]+\))?[!:]/i.test(subject)?'fix':
      /^(perf|refactor)(\([^)]+\))?[!:]/i.test(subject)?'improvement':
      migrations.length?'database': 'maintenance'
    return {sha:id,date,subject,kind,components,files,migrations}
  })
const manifest={
  schemaVersion:1,
  version:sha.slice(0,12),
  releaseName:committedAt.slice(0,10).replaceAll('-','.')+'+'+sha.slice(0,8),
  sha,
  builtAt:committedAt,
  releaseChannel:'preview',
  commits:commits.filter(c=>c.files.length),
}
for(const filename of ['services/api/release-manifest.json','apps/itsm/public/release-manifest.json']){
  mkdirSync(dirname(filename),{recursive:true})
  writeFileSync(filename,JSON.stringify(manifest,null,2)+'\n')
}
console.log('Release manifest:',manifest.version,manifest.commits.length,'changes')
