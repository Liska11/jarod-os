import { useId, useState } from 'react'
import { describeArgs, type Line } from '../lib/chat-model.ts'
import { Icon } from './icons.tsx'

/** A run of tool calls, folded: one line to open, the calls (and their arguments, if sent) inside. */
export function ToolGroup({ calls, running }: { calls: Line[]; running: boolean }) {
  const [open, setOpen] = useState(false)
  const body = useId()
  const failed = calls.filter(c => c.role === 'error').length
  const names = [...new Set(calls.map(c => c.text.replace(/ : refusé ou en échec$/, '')))]
  const summary = calls.length === 1 ? names[0] : `${calls.length} outils : ${names.slice(0, 2).join(', ')}${names.length > 2 ? '…' : ''}`
  return (
    <div className={`tools ${failed ? 'has-failed' : ''}`}>
      <button type="button" className="tools-head" aria-expanded={open} aria-controls={body} onClick={() => setOpen(o => !o)}>
        <Icon name="tool" size={16} />
        <span className="tools-summary">{summary}</span>
        {running && <span className="tools-live" aria-label="en cours" />}
        {failed > 0 && <span className="tools-failed">{failed} refusé{failed > 1 ? 's' : ''}</span>}
        <span className={`tools-chevron ${open ? 'open' : ''}`}>
          <Icon name="expand" size={18} />
        </span>
      </button>
      {open && (
        <ul id={body} className="tools-list">
          {calls.map(c => (
            <li key={c.id} className={c.role === 'error' ? 'bad' : ''}>
              <b>{c.text}</b>
              {c.args !== undefined && <pre>{describeArgs(c.args, 400)}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
