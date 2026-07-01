// The shared, PROPERLY built chat composer used by every proto (the new-session input + the process steer bar).
// Functional behavior is centralized here so all 5 designs get it for free; protos only THEME it via `className`
// (style .ci / .ci-field / .ci-send under their proto class). Behavior (researched, plans/island-proto-briefs.md):
//  - multiline auto-grow via scrollHeight, reset to 'auto' first (never a fixed reset), capped at maxHeight then
//    the INNER textarea scrolls (overflow-y on the textarea, not on a rounded wrapper — clip bug),
//  - Enter sends, Shift+Enter newline, IME-safe (bail on isComposing / keyCode 229 so CJK/accent commit is not a send),
//  - UNCONTROLLED (defaultValue + ref) to preserve native undo/redo/paste and avoid re-rendering a parent feed,
//  - send affordance enabled only when the trimmed value is non-empty.
import { useEffect, useRef, useState } from 'react'
import { getDraft, setDraft } from './draftStore'

export function ChatInput({
  className = '',
  placeholder = 'Message',
  dragPlaceholder,
  onSend,
  maxHeight = 120,
  autoFocus = false,
  sendLabel = '↑',
  draftKey,
  hasAttachments = false
}: {
  className?: string
  placeholder?: string
  dragPlaceholder?: string
  onSend?: (text: string) => void
  maxHeight?: number
  autoFocus?: boolean
  sendLabel?: string
  /** Persist the half-typed draft per chat so it survives the island close/reopen + tab switches. */
  draftKey?: string
  /** When true, allow sending with EMPTY text (a staged screenshot can be sent on its own). */
  hasAttachments?: boolean
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [canSend, setCanSend] = useState(false)

  const autosize = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto' // reset FIRST so it can shrink, then grow to content
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px'
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }
  const sync = (): void => setCanSend(!!ref.current?.value.trim() || hasAttachments)

  useEffect(() => {
    autosize()
    if (autoFocus) ref.current?.focus()
    // Re-autosize whenever the LAYOUT changes, not just on input: the feed growing/scrolling, the chassis width
    // animating, or a window resize all reflow the textarea's wrapped lines. Without this the height + overflowY
    // stay frozen at their pre-relayout values and the text clips past the chassis (overflow:hidden). The input
    // must be invariant to chat state (BLI-41).
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => autosize())
    ro.observe(el)
    window.addEventListener('resize', autosize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', autosize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load this chat's saved draft on mount AND whenever the active chat changes (a tab switch reuses this same
  // composer instance) — so a half-typed message survives the island reopen and each chat keeps its own draft.
  useEffect(() => {
    const el = ref.current
    if (!el || draftKey == null) return
    el.value = getDraft(draftKey)
    autosize()
    sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  // Staging/clearing a screenshot flips whether an empty-text send is allowed → re-evaluate the send affordance.
  useEffect(() => {
    sync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAttachments])

  const send = (): void => {
    const el = ref.current
    const text = (el?.value ?? '').trim()
    if (!text && !hasAttachments) return // require text OR a staged screenshot
    onSend?.(text)
    if (el) {
      el.value = '' // uncontrolled: clear via the node, keep native undo stack intact otherwise
      autosize()
    }
    if (draftKey != null) setDraft(draftKey, '') // the draft rode the message — clear it for this chat
    setCanSend(false)
  }

  return (
    <div className={`ci ${className}${dragPlaceholder ? ' ci-drag-placeholder' : ''}`}>
      <textarea
        ref={ref}
        className="ci-field"
        rows={1}
        placeholder={dragPlaceholder || placeholder}
        defaultValue=""
        onInput={() => {
          autosize()
          sync()
          if (draftKey != null) setDraft(draftKey, ref.current?.value || '')
        }}
        onKeyDown={(e) => {
          // IME guard: while composing (or the legacy 229 keyCode), Enter commits the candidate, never sends.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
      />
      <button className="ci-send" type="button" aria-label="Send" disabled={!canSend} onClick={send}>
        {sendLabel}
      </button>
    </div>
  )
}

export default ChatInput
