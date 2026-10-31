import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { hastText } from '../../lib/chat-export.ts'
import { useT } from '../../lib/i18n.ts'
import { attempt } from '../../lib/native.ts'
import { CopyAction } from '../hermes/MessageActions.tsx'

const plugins = [remarkGfm]

/** A code block with a button that copies what is in it; the button shows when the block is hovered or focused. */
function CodeBlock({ node, children }: { node?: unknown; children?: React.ReactNode }) {
  const { t } = useT()
  const code = hastText(node).replace(/\n$/, '')

  return (
    <div className="group/code relative">
      <pre>{children}</pre>
      {code && <CopyAction text={code} label={t('chat.code.copy')} className="absolute top-1.5 right-1.5 bg-black/30 opacity-0 transition-opacity duration-100 group-hover/code:opacity-100 focus-visible:opacity-100" />}
    </div>
  )
}

/** Transcript markdown. Links open outside the shell; the renderer never navigates. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `prose-hermes ${className}` : 'prose-hermes'}>
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={event => {
                event.preventDefault()

                if (href) {
                  void attempt('native.failed.openLink', () => window.jarodOS.shell.openExternal(href))
                }
              }}
            >
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
