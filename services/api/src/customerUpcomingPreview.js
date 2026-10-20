/**
 * Public preview projection. This is intentionally an allowlist, NOT a
 * shallow copy of the Dev draft. Git SHAs, version reservations, private
 * developer notes, CI links, authors, and approval data must never cross it.
 */
const categories=new Set(['feature','improvement','fix','security','other'])
const trimmed=(value,max)=>typeof value==='string'?value.trim().slice(0,max):''
export function publicUpcomingPreview(record){
 if(!record||!['draft','submitted'].includes(record.status))return null
 const notes=record.notes
 if(!notes||notes.upcomingVisible!==true)return null
 const title=trimmed(notes.title,180)
 const summary=trimmed(notes.summary,1200)
 if(title.length<3||summary.length<12||!Array.isArray(notes.entries)
    ||notes.entries.length<1||notes.entries.length>35)return null
 const changes=notes.entries.map(item=>({
  category:categories.has(item?.category)?item.category:'other',
  title:trimmed(item?.title,160),
  description:trimmed(item?.description,950),
 }))
 if(changes.some(entry=>entry.title.length<3))return null
 return {title,summary,entries:changes,status:'planned'}
}
export function publicUpcomingPreviews(rows,{max=6}={}){
 return (Array.isArray(rows)?rows:[]).map(publicUpcomingPreview)
  .filter(Boolean).slice(0,max)
}
