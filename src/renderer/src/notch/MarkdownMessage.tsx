import { memo, useMemo, type MouseEvent } from 'react'
import Markdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { IslandMessage } from './types'

const remarkPlugins = [remarkGfm]
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:'])
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i
const ASK_CARD_MAX_OPTIONS = 12

type AskKind = 'confirm' | 'choice' | 'grid'
export type AskOption = { label: string; sub?: string; img?: string }
export type AskCard = { type: AskKind; prompt: string; options: AskOption[] }
type MarkdownMessageProps = Pick<IslandMessage, 'role' | 'text'> & {
  onChoose?: (choice: string) => void
  selectedAnswer?: string
}

function normalizedExternalUrl(raw?: string): string | null {
  const value = String(raw || '').trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function normalizedImageSrc(raw?: string): string | null {
  const value = String(raw || '').trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null
  if (DATA_IMAGE_RE.test(value)) return value
  try {
    const url = new URL(value)
    return SAFE_IMAGE_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

export const markdownUrlTransform: UrlTransform = (value, key) => {
  if (key === 'src') return normalizedImageSrc(value) || ''
  return normalizedExternalUrl(value) || ''
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

function cleanAskText(value: unknown, max: number): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function normalizeAskOption(value: unknown): AskOption | null {
  if (typeof value === 'string') {
    const label = cleanAskText(value, 120)
    return label ? { label } : null
  }
  if (!value || typeof value !== 'object') return null
  const option = value as Record<string, unknown>
  const label = cleanAskText(option.label || option.title || option.value, 120)
  if (!label) return null
  const sub = cleanAskText(option.sub || option.detail || option.description, 180)
  const img = normalizedImageSrc(String(option.img || option.image || '')) || undefined
  return { label, ...(sub ? { sub } : {}), ...(img ? { img } : {}) }
}

export function parseAskCard(text: string): AskCard | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const fenceMatch = /^```blitz-ui\s*\n([\s\S]*?)\n?```\s*$/i.exec(trimmed)
  const jsonText = fenceMatch ? fenceMatch[1].trim() : trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : ''
  if (!jsonText) return null

  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const spec = raw as Record<string, unknown>
  const rawKind = cleanAskText(spec.type || spec.kind, 32)
  const type: AskKind = rawKind === 'choice' || rawKind === 'grid' ? rawKind : 'confirm'
  const prompt = cleanAskText(spec.prompt, 240)
  const options = (Array.isArray(spec.options) ? spec.options : [])
    .map(normalizeAskOption)
    .filter((option): option is AskOption => Boolean(option))
    .slice(0, ASK_CARD_MAX_OPTIONS)

  if (!prompt || !options.length) return null
  return { type, prompt, options }
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

function AskCardMessage({
  card,
  onChoose,
  selectedAnswer
}: {
  card: AskCard
  onChoose?: (choice: string) => void
  selectedAnswer?: string
}): JSX.Element {
  const answered = Boolean(selectedAnswer)
  return (
    <div className={`isl-ask-card ${card.type}${answered ? ' answered' : ''}`} role="group" aria-label={card.prompt}>
      <div className="isl-ask-prompt">{card.prompt}</div>
      {answered ? (
        <div className="isl-ask-selected" aria-label={`Selected answer: ${selectedAnswer}`}>
          <span className="isl-ask-selected-kicker">Selected</span>
          <span className="isl-ask-selected-answer">{selectedAnswer}</span>
        </div>
      ) : (
        <div className="isl-ask-options">
          {card.options.map((option, index) => (
            <button
              key={`${index}:${option.label}`}
              type="button"
              className="isl-ask-option"
              disabled={!onChoose}
              onClick={() => onChoose?.(option.label)}
            >
              {option.img && <img src={option.img} alt="" loading="lazy" decoding="async" />}
              <span className="isl-ask-label">{option.label}</span>
              {option.sub && <span className="isl-ask-sub">{option.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MarkdownMessage({ role, text, onChoose, selectedAnswer }: MarkdownMessageProps): JSX.Element {
  const askCard = useMemo(() => (role === 'agent' ? parseAskCard(text) : null), [role, text])
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text])

  if (askCard) {
    return (
      <div className={`isl-msg ${role} isl-md-msg isl-ask-msg`}>
        <AskCardMessage card={askCard} onChoose={onChoose} selectedAnswer={selectedAnswer} />
      </div>
    )
  }

  return (
    <div className={`isl-msg ${role} isl-md-msg`}>
      {blocks.map((block, index) => (
        <MarkdownBlock key={`${index}:${block.length}:${block.slice(0, 24)}`} text={block} />
      ))}
    </div>
  )
}

export default memo(MarkdownMessage)
