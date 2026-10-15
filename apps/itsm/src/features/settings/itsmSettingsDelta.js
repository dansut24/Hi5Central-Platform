/** Difference between what the editor displayed at load and what a user edited.
 * Only send specific leaf values. Built-in defaults must not be written
 * as a tenant-wide configuration snapshot simply because Save was clicked.
 */
function plain(value) {
  return value!==null && typeof value==='object' && !Array.isArray(value)
}
function equal(left,right) {
  if(Object.is(left,right))return true
  if(plain(left)&&plain(right)) {
    const keys=[...new Set([...Object.keys(left),...Object.keys(right)])]
    return keys.every(k=>Object.prototype.hasOwnProperty.call(left,k)
      ===Object.prototype.hasOwnProperty.call(right,k) && equal(left[k],right[k]))
  }
  if(Array.isArray(left)&&Array.isArray(right))
    return left.length===right.length&&left.every((v,i)=>equal(v,right[i]))
  return false
}

export function collectItsmSettingsEdits(before,after) {
  const edits=[]
  function visit(previous,next,path) {
    if(equal(previous,next))return
    if(plain(previous)&&plain(next)) {
      for(const key of Object.keys(next))visit(previous[key],next[key],[...path,key])
      // Editor does not implement removals; never silently delete hidden data.
      for(const key of Object.keys(previous))
        if(!Object.prototype.hasOwnProperty.call(next,key))
          throw new Error('A setting was removed from the editor. Refresh before saving.')
      return
    }
    if(plain(next)) {
      for(const key of Object.keys(next))visit(undefined,next[key],[...path,key])
      return
    }
    if(path.length===0||next===undefined||next!==null&&typeof next==='object')
      throw new Error('Unsupported ITSM setting edit. Refresh before saving.')
    edits.push({path,value:next})
  }
  visit(before||{},after||{},[])
  return edits
}
