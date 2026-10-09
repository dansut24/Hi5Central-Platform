import { escapeRichText, sanitizeNoteHtml } from './ProductionRichNoteEditor.jsx'

// Support the existing plain-text article library as well as newly formatted articles.
// Every HTML fragment is sanitised before it enters the DOM, including portal articles.
export function isFormattedKnowledge(content) {
  return /^\s*<(?:p|div|h[234]|ul|ol|blockquote|table|pre|hr|strong|em|a|img)\b/i.test(String(content || ''))
}

export function KnowledgeArticleBody({ content }) {
  const raw = String(content || '')
  if (!raw.trim()) return <p className="pkb-muted">No article content yet.</p>
  const rich = isFormattedKnowledge(raw)
    ? raw
    : raw.split(/\n{2,}/).map((paragraph) =>
        '<p>' + escapeRichText(paragraph).replace(/\n/g, '<br>') + '</p>',
      ).join('')
  return <div className="pkb-formatted-body" dangerouslySetInnerHTML={{ __html: sanitizeNoteHtml(rich) }} />
}
