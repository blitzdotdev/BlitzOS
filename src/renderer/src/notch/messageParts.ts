import { normalizedImageSrc } from './markdownSafety'
import type { IslandChoiceOption, IslandChoicePart, IslandMessage, IslandMessagePart } from './types'

const ASK_CARD_MAX_OPTIONS = 12

function cleanPartText(value: unknown, max: number): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function normalizeChoiceOption(value: unknown): IslandChoiceOption | null {
  if (typeof value === 'string') {
    const label = cleanPartText(value, 120)
    return label ? { label } : null
  }
  if (!value || typeof value !== 'object') return null
  const option = value as Record<string, unknown>
  const label = cleanPartText(option.label || option.title || option.value, 120)
  if (!label) return null
  const sub = cleanPartText(option.sub || option.detail || option.description, 180)
  const img = normalizedImageSrc(String(option.img || option.image || '')) || undefined
  return { label, ...(sub ? { sub } : {}), ...(img ? { img } : {}) }
}

export function parseBlitzUiChoicePart(text: string): IslandChoicePart | null {
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
  const rawKind = cleanPartText(spec.type || spec.kind, 32)
  const layout: IslandChoicePart['layout'] = rawKind === 'choice' || rawKind === 'grid' ? rawKind : 'confirm'
  const prompt = cleanPartText(spec.prompt || spec.title || spec.question || spec.heading, 240)
  const options = (Array.isArray(spec.options) ? spec.options : [])
    .map(normalizeChoiceOption)
    .filter((option): option is IslandChoiceOption => Boolean(option))
    .slice(0, ASK_CARD_MAX_OPTIONS)

  if (!prompt || !options.length) return null
  return { type: 'choice', layout, prompt, options }
}

export function messagePartsFor(message: Pick<IslandMessage, 'role' | 'text' | 'parts'>): IslandMessagePart[] {
  if (Array.isArray(message.parts) && message.parts.length) return message.parts
  if (message.role === 'agent') {
    const choice = parseBlitzUiChoicePart(message.text)
    if (choice) return [choice]
  }
  return [{ type: 'text', text: message.text }]
}

export function matchingChoiceAnswer(promptText: string, answerText?: string): string | undefined {
  return matchingChoiceAnswerForMessage({ role: 'agent', text: promptText }, answerText)
}

export function matchingChoiceAnswerForMessage(message: Pick<IslandMessage, 'role' | 'text' | 'parts'>, answerText?: string): string | undefined {
  if (!answerText) return undefined
  const choice = messagePartsFor(message).find((part): part is IslandChoicePart => part.type === 'choice')
  if (!choice) return undefined
  const cleanAnswer = answerText.trim()
  return choice.options.some((option) => option.label === cleanAnswer) ? cleanAnswer : undefined
}
