import { memo, useMemo, type MouseEvent } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AppEmbedIcon, blitzAppSubtitle, normalizedBlitzAppPart, normalizeAppTone } from './appEmbeds'
import { markdownUrlTransform, normalizedExternalUrl, normalizedImageSrc } from './markdownSafety'
import { messagePartsFor } from './messageParts'
import type { IslandAppMessagePart, IslandChoicePart, IslandMessage, IslandMessagePart } from './types'

const remarkPlugins = [remarkGfm]

type MarkdownMessageProps = Pick<IslandMessage, 'role' | 'text' | 'parts'> & {
  onChoose?: (choice: string) => void
  onOpenApp?: (app: IslandAppMessagePart) => void
  selectedAnswer?: string
  showDivider?: boolean
}

type Fence = { char: '`' | '~'; size: number }

function fenceFor(line: string): Fence | null {
  const match = /^\s*(`{3,}|~{3,})/.exec(line)
  if (!match) return null
  const marker = match[1]
  return { char: marker[0] as Fence['char'], size: marker.length }
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== fence.char) return false
  for (let i = 0; i < fence.size; i++) if (trimmed[i] !== fence.char) return false
  return trimmed.slice(fence.size).trim() === ''
}

function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fence: Fence | null = null

  for (const line of lines) {
    if (fence) {
      current.push(line)
      if (closesFence(line, fence)) fence = null
      continue
    }

    const nextFence = fenceFor(line)
    if (nextFence) {
      fence = nextFence
      current.push(line)
      continue
    }

    if (line.trim() === '') {
      if (current.length) {
        blocks.push(current.join('\n'))
        current = []
      }
      continue
    }

    current.push(line)
  }

  if (current.length) blocks.push(current.join('\n'))
  return blocks.length ? blocks : ['']
}

const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const safe = normalizedExternalUrl(href)
    if (!safe) return <span className="isl-md-link inert">{children}</span>
    const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault()
      void window.agentOS?.openExternalUrl?.(safe)
    }
    return (
      <a {...props} href={safe} rel="noreferrer" target="_blank" onClick={onClick}>
        {children}
      </a>
    )
  },
  p({ children, ...props }) {
    return <p {...props}>{children}</p>
  },
  ul({ children, ...props }) {
    return <ul {...props}>{children}</ul>
  },
  ol({ children, ...props }) {
    return <ol {...props}>{children}</ol>
  },
  li({ children, ...props }) {
    return <li {...props}>{children}</li>
  },
  blockquote({ children, ...props }) {
    return <blockquote {...props}>{children}</blockquote>
  },
  pre({ children, ...props }) {
    return <pre {...props}>{children}</pre>
  },
  code({ children, className, ...props }) {
    return (
      <code {...props} className={className}>
        {children}
      </code>
    )
  },
  table({ children, ...props }) {
    return (
      <div className="isl-md-table-wrap">
        <table {...props}>{children}</table>
      </div>
    )
  },
  th({ children, ...props }) {
    return <th {...props}>{children}</th>
  },
  td({ children, ...props }) {
    return <td {...props}>{children}</td>
  },
  img({ src, alt, ...props }) {
    const safe = normalizedImageSrc(src)
    if (!safe) return <span className="isl-md-image-blocked">Image blocked</span>
    return <img {...props} src={safe} alt={alt || ''} loading="lazy" decoding="async" />
  }
}

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }): JSX.Element {
  return (
    <Markdown remarkPlugins={remarkPlugins} skipHtml urlTransform={markdownUrlTransform} components={markdownComponents}>
      {text}
    </Markdown>
  )
})

const MarkdownTextPart = memo(function MarkdownTextPart({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text])
  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock key={`${index}:${block.length}:${block.slice(0, 24)}`} text={block} />
      ))}
    </>
  )
})

function ChoicePartMessage({
  part,
  onChoose,
  selectedAnswer
}: {
  part: IslandChoicePart
  onChoose?: (choice: string) => void
  selectedAnswer?: string
}): JSX.Element {
  const answered = Boolean(selectedAnswer)
  return (
    <div className={`isl-ask-card ${part.layout}${answered ? ' answered' : ''}`} role="group" aria-label={part.prompt}>
      <div className="isl-ask-prompt">{part.prompt}</div>
      <div className="isl-ask-options">
        {part.options.map((option, index) => {
          const img = normalizedImageSrc(option.img)
          const selected = selectedAnswer === option.label
          return (
            <button
              key={`${index}:${option.label}`}
              type="button"
              className={`isl-ask-option${selected ? ' selected' : ''}`}
              disabled={answered || !onChoose}
              onClick={() => onChoose?.(option.label)}
            >
              {img && <img src={img} alt="" loading="lazy" decoding="async" />}
              <span className="isl-ask-label">{option.label}</span>
              {option.sub && <span className="isl-ask-sub">{option.sub}</span>}
            </button>
          )
        })}
      </div>
      {answered && (
        <div className="isl-ask-selected" aria-label={`Selected answer: ${selectedAnswer}`}>
          <span className="isl-ask-selected-copy">
            <span className="isl-ask-selected-kicker">Selected</span>
            <span className="isl-ask-selected-answer">{selectedAnswer}</span>
          </span>
          <span className="isl-ask-selected-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M5 12.5l4.2 4.2L19 7" />
            </svg>
          </span>
        </div>
      )}
    </div>
  )
}

function AppPartMessage({ part, onOpenApp }: { part: IslandAppMessagePart; onOpenApp?: (app: IslandAppMessagePart) => void }): JSX.Element {
  const normalized = normalizedBlitzAppPart(part)
  const tone = normalizeAppTone(part.tone)
  const disabled = !normalized || !onOpenApp
  if (part.preview) {
    // Bespoke agent-authored card face: the whole preview is self-contained static HTML/CSS in a sandboxed
    // srcdoc iframe (no scripts run). pointer-events:none (CSS) so the button captures the click -> expand.
    return (
      <button
        type="button"
        className={`isl-app-card preview${disabled ? ' invalid' : ''}`}
        data-tone={tone}
        disabled={disabled}
        aria-label={normalized ? `Open ${part.title}` : `Cannot open ${part.title}`}
        onClick={() => {
          if (normalized) onOpenApp?.(normalized)
        }}
      >
        <iframe className="isl-app-card-preview" title={`${part.title} preview`} srcDoc={part.preview} sandbox="" scrolling="no" tabIndex={-1} aria-hidden />
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`isl-app-card${disabled ? ' invalid' : ''}`}
      data-tone={tone}
      disabled={disabled}
      aria-label={normalized ? `Open ${part.title}` : `Cannot open ${part.title}`}
      onClick={() => {
        if (normalized) onOpenApp?.(normalized)
      }}
    >
      <span className="isl-app-card-icon" aria-hidden>
        <AppEmbedIcon icon={part.icon} />
      </span>
      <span className="isl-app-card-copy">
        <span className="isl-app-card-kicker">{part.title}</span>
        <span className="isl-app-card-sub">{normalized ? blitzAppSubtitle(part) : 'Unsupported app URL'}</span>
      </span>
      <span className="isl-app-card-open" aria-hidden>
        ›
      </span>
    </button>
  )
}

function renderMessagePart(
  part: IslandMessagePart,
  index: number,
  onChoose?: (choice: string) => void,
  selectedAnswer?: string,
  onOpenApp?: (app: IslandAppMessagePart) => void
): JSX.Element {
  switch (part.type) {
    case 'choice':
      return <ChoicePartMessage key={`choice:${index}:${part.prompt}`} part={part} onChoose={onChoose} selectedAnswer={selectedAnswer} />
    case 'app':
      return <AppPartMessage key={`app:${index}:${part.url}:${part.title}`} part={part} onOpenApp={onOpenApp} />
    case 'error':
      return (
        <div key={`error:${index}`} className="isl-msg-part error">
          {part.text}
        </div>
      )
    case 'status':
      return (
        <div key={`status:${index}`} className={`isl-msg-part status ${part.tone || 'info'}`}>
          {part.text}
        </div>
      )
    case 'tool':
      return (
        <div key={`tool:${index}:${part.title}`} className={`isl-msg-part tool ${part.state}`}>
          <span>{part.title}</span>
          {part.output && <code>{part.output}</code>}
          {part.error && <span>{part.error}</span>}
        </div>
      )
    case 'attachment':
      return (
        <div key={`attachment:${index}:${part.title}`} className="isl-msg-part attachment">
          {part.title}
        </div>
      )
    case 'text':
    default:
      return <MarkdownTextPart key={`text:${index}:${part.text.length}:${part.text.slice(0, 24)}`} text={part.text} />
  }
}

function MarkdownMessage({ role, text, parts: providedParts, onChoose, onOpenApp, selectedAnswer, showDivider }: MarkdownMessageProps): JSX.Element {
  const parts = useMemo(() => messagePartsFor({ role, text, parts: providedParts }), [role, text, providedParts])
  const hasChoice = parts.some((part) => part.type === 'choice')
  const hasApp = parts.some((part) => part.type === 'app')

  return (
    <div className={`isl-msg ${role} isl-md-msg${hasChoice ? ' isl-ask-msg' : ''}${hasApp ? ' isl-app-msg' : ''}${showDivider ? ' isl-say-divider' : ''}`}>
      {parts.map((part, index) => renderMessagePart(part, index, onChoose, selectedAnswer, onOpenApp))}
    </div>
  )
}

export default memo(MarkdownMessage)
