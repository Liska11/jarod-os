import { Children, isValidElement, memo, type ReactElement, type ReactNode, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { haptic } from '../lib/haptics.ts'
import { Icon } from './icons.tsx'

const plugins = [remarkGfm]

/** The plain text inside a rendered code block. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ''
}

/** The language of a fenced block (```ts), from the class the parser puts on its <code>. */
function languageOf(node: ReactNode): string {
  const code = Children.toArray(node).find(isValidElement) as ReactElement<{ className?: string }> | undefined
  return /language-([\w+#-]+)/.exec(code?.props.className ?? '')?.[1] ?? ''
}

/** Copies text; the Clipboard API where the WebView has it, the old way where it does not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(area)
    area.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      area.remove()
    }
  }
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef(0)
  const copy = async () => {
    const ok = await copyText(textOf(children).replace(/\n$/, ''))
    haptic(ok ? 'confirm' : 'warn')
    setState(ok ? 'copied' : 'failed')
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1800)
  }
  const lang = languageOf(children)
  return (
    <div className="code">
      <div className="code-head">
        <span>{lang || 'code'}</span>
        <button type="button" className="code-copy" onClick={() => void copy()} aria-label="Copier le code">
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={16} />
          {state === 'copied' ? 'Copié' : state === 'failed' ? 'Échec' : 'Copier'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/**
 * Jarod's replies, as the desktop shows them (react-markdown + GFM, like `features/chat/Markdown.tsx`),
 * with a Copy button on every code block. A link is shown, never followed: the app does not navigate
 * anywhere a reply points to.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: ({ href, children }) => (
            <span className="link" title={href}>
              {children}
            </span>
          ),
          img: ({ alt }) => <span className="muted">[image : {alt}]</span>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
