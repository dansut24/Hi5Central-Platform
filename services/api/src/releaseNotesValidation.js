/** Shared pure validation for Dev drafts, central publication and QA tests. */
const SHA=/^[0-9a-f]{40}$/
export const RELEASE_NOTE_CATEGORIES=new Set(['feature','improvement','fix','security','other'])
const VERSION=/^v?\d+(?:\.\d+){1,3}(?:-(?:alpha|beta|rc)(?:[.-]?\d+)?)?$/i
const trimmed=(value,max)=>String(value??'').trim().slice(0,max)
export function customerVersionLabel(value){
 return String(value||'').trim().replace(/\+[a-f0-9]{8,40}$/i,'')
}
export function validateCustomerVersion(value){
 const version=String(value||'').trim()
 if(!VERSION.test(version)||version.length>32)
  throw Error('Enter a customer version such as 1.0.1 or 2026.10.1. Build IDs are tracked separately.')
 return version
}
export function validateReleaseNotes(input){
 const buildSha=trimmed(input?.buildSha,40).toLowerCase()
 const versionLabel=validateCustomerVersion(input?.versionLabel)
 const title=trimmed(input?.title,180)
 const summary=trimmed(input?.summary,1200)
 if(!SHA.test(buildSha)||!versionLabel||!title)
  throw Error('A valid build, version name and release title are required.')
 if(!Array.isArray(input?.entries)||input.entries.length<1||input.entries.length>35)
  throw Error('Provide between 1 and 35 customer-facing release note entries.')
 const entries=input.entries.map(item=>{
  const category=trimmed(item?.category,32).toLowerCase()
  const heading=trimmed(item?.title,160)
  const description=trimmed(item?.description,950)
  if(!RELEASE_NOTE_CATEGORIES.has(category)||heading.length<3)
   throw Error('Each release note needs a category and a descriptive title.')
  return {category,title:heading,description}
 })
 return {buildSha,versionLabel,title,summary,entries}
}
