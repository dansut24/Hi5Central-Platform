/** Presentation only. The API sends values exclusively from its own
 * allowlist; older audit rows do not contain recoverable prior values. */
export function auditSettingName(path) {
  const parts=String(path||'').split('.')
  const key=parts.at(-1)||'ITSM setting'
  return key.replace(/([a-z0-9])([A-Z])/g,'$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g,'$1 $2')
    .replace(/[_-]+/g,' ')
    .toLowerCase()
    .replace(/\b(sla|cmdb|itsm)\b/gi,value=>value.toUpperCase())
    .replace(/^./,letter=>letter.toUpperCase())
}

export function auditValueText(value) {
  if(value===true)return 'On'
  if(value===false)return 'Off'
  if(value===null||value===undefined)return 'Not previously recorded'
  return String(value)
}

export function describeAuditValueChange(entry) {
  if(!entry||typeof entry.path!=='string'||!['boolean','number','enum'].includes(entry.kind))
    return null
  const label=auditSettingName(entry.path)
  if(entry.kind==='boolean'&&typeof entry.after==='boolean') {
    return {
      label,text:entry.before===null||entry.before===undefined
        ?label+' was set to '+auditValueText(entry.after)
        :label+' was turned '+(entry.after?'on':'off'),
      before:auditValueText(entry.before),after:auditValueText(entry.after),
      source:entry.beforeSource==='default'?'Previous value was the built-in default.':null,
    }
  }
  if(entry.before===null||entry.before===undefined){
    return {
      label,text:label+' was set to '+auditValueText(entry.after),
      before:auditValueText(entry.before),after:auditValueText(entry.after),
      source:null,
    }
  }
  return {
    label,text:label+' changed from '+auditValueText(entry.before)+' to '+auditValueText(entry.after),
    before:auditValueText(entry.before),after:auditValueText(entry.after),
    source:entry.beforeSource==='default'?'Previous value was the built-in default.':null,
  }
}
