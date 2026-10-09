import { useEffect, useRef, useState } from 'react'
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Braces, Eraser, Expand,
  ImagePlus, Italic, Link2, List, ListOrdered, Minus, Pilcrow, Quote, Redo2, Shrink,
  Smile, Strikethrough, Table2, Underline, Undo2,
} from 'lucide-react'

// Allow only editorial markup. DOMParser runs in an inert document; sanitized
// output is the only HTML passed to the record timeline renderer.
const ALLOWED = new Set(['p','div','br','strong','b','em','i','u','s','strike','h2','h3','h4','blockquote','ul','ol','li','a','code','pre','hr','table','thead','tbody','tr','th','td','img','span'])
const BLOCK = new Set(['div','p','h2','h3','h4','blockquote'])
const UNSAFE = new Set(['script','style','iframe','object','embed','svg','math','form','input','button','video','audio','template','link','meta','base'])
export const escapeRichText = (text) => String(text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
export function safeRichUrl(input, forImage = false) {
  try {
    const url = new URL(String(input || '').trim())
    const allowed = forImage ? url.protocol === 'https:' : ['https:','http:','mailto:'].includes(url.protocol)
    return allowed && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

export function sanitizeNoteHtml(raw) {
  if (!raw || typeof document === 'undefined') return ''
  const holder = document.createElement('template')
  holder.innerHTML = String(raw).slice(0, 100_000)
  function clean(node) {
    if (node.nodeType === 8) { node.remove(); return }
    if (node.nodeType === 3) return
    if (node.nodeType !== 1) { node.remove(); return }
    const tag = node.tagName.toLowerCase()
    if (UNSAFE.has(tag)) { node.remove(); return }
    for (const child of [...node.childNodes]) clean(child)
    if (!ALLOWED.has(tag)) { node.replaceWith(...node.childNodes); return }
    const href = tag === 'a' ? safeRichUrl(node.getAttribute('href')) : ''
    const src = tag === 'img' ? safeRichUrl(node.getAttribute('src'), true) : ''
    const title = tag === 'a' ? String(node.getAttribute('title') || '').slice(0,200) : ''
    const alt = tag === 'img' ? String(node.getAttribute('alt') || '').slice(0,200) : ''
    const align = (node.getAttribute('style') || '').match(/(?:^|;)\s*text-align\s*:\s*(center|right|justify)\s*(?:;|$)/i)?.[1]?.toLowerCase() || (node.getAttribute('class') || '').match(/(?:^|\s)rt-align-(center|right|justify)(?:\s|$)/)?.[1] || ''
    for (const attr of [...node.attributes]) node.removeAttribute(attr.name)
    if (tag === 'a' && href) {
      node.setAttribute('href',href)
      node.setAttribute('target','_blank')
      node.setAttribute('rel','noopener noreferrer nofollow')
      if (title) node.setAttribute('title',title)
    }
    if (tag === 'img') {
      if (!src) { node.remove(); return }
      node.setAttribute('src',src)
      node.setAttribute('alt',alt)
      node.setAttribute('loading','lazy')
      node.setAttribute('referrerpolicy','no-referrer')
    }
    if (align && BLOCK.has(tag)) node.className = 'rt-align-' + align
  }
  for (const child of [...holder.content.childNodes]) clean(child)
  return holder.innerHTML
}

export function RichActivityBody({ html, text }) {
  const safe = sanitizeNoteHtml(html)
  return safe ? <div className="record-lab-rich-note-content" dangerouslySetInnerHTML={{ __html: safe }} /> : <p>{text || ''}</p>
}

const EMOJI = ['✅','🔍','⚠️','📎','💻','📞','🔧','👍','🙂','🎯','🚀','❗']
const ACTIONS = [
  {cmd:'bold', label:'Bold', Icon:Bold},
  {cmd:'italic',label:'Italic',Icon:Italic},
  {cmd:'underline',label:'Underline',Icon:Underline},
  {cmd:'strikeThrough',label:'Strikethrough',Icon:Strikethrough},
  {cmd:'insertUnorderedList',label:'Bulleted list',Icon:List},
  {cmd:'insertOrderedList',label:'Numbered list',Icon:ListOrdered},
  {cmd:'formatBlock',value:'blockquote',label:'Quote',Icon:Quote},
]
const Tool = ({title,Icon,onClick,disabled=false,active=false}) => <button type="button" title={title} aria-label={title} aria-pressed={active} disabled={disabled} onMouseDown={(e)=>e.preventDefault()} onClick={onClick}><Icon size={15}/></button>

export function RichNoteEditor({ html, text, onChange, placeholder='Write a note…' }) {
  const ref = useRef(null)
  const savedSelection = useRef(null)
  const [expanded,setExpanded] = useState(false)
  const [source,setSource] = useState(false)
  const [sourceValue,setSourceValue] = useState('')
  const initial = useRef(false)
  useEffect(() => {
    if (!ref.current || initial.current) return
    ref.current.innerHTML = sanitizeNoteHtml(html || (text ? escapeRichText(text).replace(/\n/g,'<br>') : ''))
    initial.current = true
  }, [html,text])
  const sync = () => {
    if (!ref.current) return
    const value = ref.current.innerHTML
    const plain = ref.current.innerText || ref.current.textContent || ''
    onChange({html: value, text: plain})
  }
  const remember = () => {
    const editor = ref.current
    const selection = window.getSelection()
    if (editor && selection?.rangeCount && editor.contains(selection.anchorNode)) savedSelection.current = selection.getRangeAt(0).cloneRange()
  }
  const restore = () => {
    ref.current?.focus()
    const selection = window.getSelection()
    if (selection && savedSelection.current && ref.current?.contains(savedSelection.current.commonAncestorContainer)) {
      selection.removeAllRanges()
      selection.addRange(savedSelection.current)
    }
  }
  const exec = (command, value) => {
    if (source) return
    restore()
    document.execCommand(command,false,value)
    sync()
    remember()
  }
  const insertHtml = (value) => exec('insertHTML',sanitizeNoteHtml(value))
  const link = () => {
    const suggested = window.prompt('Enter a web or email link (https:// or mailto:)', 'https://')
    if (suggested === null) return
    const safe = safeRichUrl(suggested)
    if (!safe) { window.alert('Only HTTP, HTTPS and mailto links are supported.'); return }
    restore()
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) exec('createLink',safe)
    else insertHtml('<a href="'+escapeRichText(safe)+'">'+escapeRichText(safe)+'</a>')
  }
  const image = () => {
    const value = window.prompt('Enter an HTTPS image URL')
    if (value === null) return
    const safe = safeRichUrl(value,true)
    if (!safe) { window.alert('Images must have a valid HTTPS URL. You can also attach an image using Attach files.'); return }
    const alt = window.prompt('Image description (optional)', 'Screenshot') || ''
    insertHtml('<img src="'+escapeRichText(safe)+'" alt="'+escapeRichText(alt)+'"/>')
  }
  const table = () => insertHtml('<table><tbody><tr><th>Heading 1</th><th>Heading 2</th></tr><tr><td>Value</td><td>Value</td></tr></tbody></table><p><br></p>')
  const insertEmoji = (emoji) => exec('insertText',emoji)
  const toggleSource = () => {
    if (!source) { setSourceValue(ref.current?.innerHTML || ''); setSource(true) }
    else {
      const cleaned = sanitizeNoteHtml(sourceValue)
      if (ref.current) ref.current.innerHTML=cleaned
      setSource(false)
      sync()
    }
  }
  const onPaste = (event) => {
    if (source) return
    event.preventDefault()
    const htmlValue = event.clipboardData?.getData('text/html') || ''
    const plain = event.clipboardData?.getData('text/plain') || ''
    if (htmlValue) exec('insertHTML',sanitizeNoteHtml(htmlValue))
    else exec('insertText',plain)
  }
  return <div className={'record-lab-rich-editor'+(expanded?' is-expanded':'')} aria-label="Rich text note editor">
    <div className="record-lab-rich-toolbar" role="toolbar" aria-label="Text formatting">
      <Tool title={expanded?'Exit full screen':'Full screen'} Icon={expanded?Shrink:Expand} onClick={()=>setExpanded(v=>!v)}/>
      <button type="button" className="record-lab-rich-ai" title="AI writing assistant requires an AI service connection" disabled>AI</button>
      <span className="record-lab-rich-separator"/>
      <label title="Paragraph style" className="record-lab-rich-select"><Pilcrow size={15}/><select aria-label="Paragraph style" defaultValue="p" onChange={e=>exec('formatBlock',e.target.value)}><option value="p">Paragraph</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="pre">Code block</option></select></label>
      {ACTIONS.map(({cmd,label,Icon,value})=><Tool key={label} title={label} Icon={Icon} onClick={()=>exec(cmd,value)}/>)}
      <span className="record-lab-rich-separator"/>
      <Tool title="Align left" Icon={AlignLeft} onClick={()=>exec('justifyLeft')}/>
      <Tool title="Align centre" Icon={AlignCenter} onClick={()=>exec('justifyCenter')}/>
      <Tool title="Align right" Icon={AlignRight} onClick={()=>exec('justifyRight')}/>
      <Tool title="Add link" Icon={Link2} onClick={link}/>
      <Tool title="Insert image URL" Icon={ImagePlus} onClick={image}/>
      <Tool title="Insert table" Icon={Table2} onClick={table}/>
      <span className="record-lab-rich-emoji">
        <details><summary title="Insert emoji" aria-label="Insert emoji"><Smile size={15}/></summary>
          <div className="record-lab-rich-emoji-menu">{EMOJI.map(emoji=><button type="button" key={emoji} onMouseDown={e=>e.preventDefault()} onClick={e=>{insertEmoji(emoji);e.currentTarget.closest('details')?.removeAttribute('open')}} aria-label={'Insert '+emoji}>{emoji}</button>)}</div>
        </details>
      </span>
      <Tool title="Insert horizontal line" Icon={Minus} onClick={()=>insertHtml('<hr>')}/>
      <Tool title="Remove formatting" Icon={Eraser} onClick={()=>exec('removeFormat')}/>
      <Tool title={source?'Apply HTML source':'Edit HTML source'} Icon={Braces} onClick={toggleSource}/>
      <Tool title="Undo" Icon={Undo2} onClick={()=>exec('undo')}/>
      <Tool title="Redo" Icon={Redo2} onClick={()=>exec('redo')}/>
    </div>
    <div className="record-lab-rich-input-wrap">
      <div ref={ref} contentEditable={!source} suppressContentEditableWarning role="textbox" aria-label="Note content" aria-multiline="true" data-placeholder={placeholder} className="record-lab-rich-input" onInput={sync} onMouseUp={remember} onKeyUp={remember} onBlur={remember} onPaste={onPaste} onDrop={event=>event.preventDefault()} />
      {source ? <textarea className="record-lab-rich-source" value={sourceValue} aria-label="Edit note HTML source" onChange={event=>{
        const value = event.target.value
        setSourceValue(value)
        const cleaned = sanitizeNoteHtml(value)
        const holder = document.createElement('div')
        holder.innerHTML = cleaned
        onChange({html: cleaned, text: holder.innerText || holder.textContent || ''})
      }}/> : null}
    </div>
    {source ? <button type="button" className="record-lab-rich-source-apply" onClick={toggleSource}>Apply safe HTML</button> : null}
  </div>
}
