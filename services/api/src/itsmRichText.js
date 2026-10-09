import { load } from 'cheerio'

// Notes are shared with requesters and managers. Accept only safe editorial HTML.
// Do not allow scripts, CSS, event handlers, data URLs, SVG or embedded frames.
const ALLOWED = new Set(['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'span'])
const REMOVE = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'button', 'video', 'audio', 'template', 'link', 'meta', 'base'])
function safeUrl(raw, forImage = false) {
  try {
    const url = new URL(String(raw || ''))
    if (forImage) return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

export function sanitizeActivityHtml(value) {
  const source = String(value || '').slice(0, 100_000)
  if (!source) return ''
  const $ = load(source, null, false)
  function clean(node) {
    if (node.type === 'comment' || node.type === 'directive') { $(node).remove(); return }
    if (node.type === 'text') return
    if (node.type !== 'tag') { $(node).remove(); return }
    const tag = String(node.name || '').toLowerCase()
    if (REMOVE.has(tag)) { $(node).remove(); return }
    for (const child of $(node).contents().toArray()) clean(child)
    if (!ALLOWED.has(tag)) { $(node).replaceWith($(node).contents()); return }
    const href = tag === 'a' ? safeUrl($(node).attr('href')) : ''
    const src = tag === 'img' ? safeUrl($(node).attr('src'), true) : ''
    const alt = tag === 'img' ? String($(node).attr('alt') || '').slice(0, 200) : ''
    const title = tag === 'a' ? String($(node).attr('title') || '').slice(0, 200) : ''
    const style = String($(node).attr('style') || '')
    const align = style.match(/(?:^|;)\s*text-align\s*:\s*(center|right|justify)\s*(?:;|$)/i)?.[1]?.toLowerCase() || ''
    for (const name of Object.keys(node.attribs || {})) $(node).removeAttr(name)
    if (tag === 'a' && href) { $(node).attr('href', href).attr('rel', 'noopener noreferrer nofollow').attr('target', '_blank') }
    if (tag === 'img') {
      if (!src) { $(node).remove(); return }
      $(node).attr('src', src).attr('alt', alt).attr('loading', 'lazy').attr('referrerpolicy', 'no-referrer')
    }
    if (title && href) $(node).attr('title', title)
    if (align && ['div', 'p', 'h2', 'h3', 'h4', 'blockquote'].includes(tag)) $(node).attr('class', 'rt-align-' + align)
  }
  for (const node of $.root().contents().toArray()) clean(node)
  return $.root().html() || ''
}
