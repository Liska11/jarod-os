import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]

/**
 * Jarod's replies, as the desktop shows them (react-markdown + GFM, like `features/chat/Markdown.tsx`).
 * A link is shown, never followed: the app does not navigate anywhere a reply points to.
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
          img: ({ alt }) => <span className="muted">[image : {alt}]</span>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
