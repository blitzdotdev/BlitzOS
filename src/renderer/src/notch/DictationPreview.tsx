import { useEffect, useRef, useState } from 'react'

type DictationAction = {
  type?: string
  phase?: 'partial' | 'final' | 'idle'
  text?: string
}

export function DictationPreview(): JSX.Element {
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<number | null>(null)

  useEffect(() => {
    const nonDefault =
      import.meta.env.VITE_BLITZ_NATIVE_ISLAND === '1' ||
      import.meta.env.VITE_BLITZ_NO_NOTCH_GATE === '1' ||
      import.meta.env.VITE_BLITZ_FULLSCREEN === '1'
    if (nonDefault) console.warn('BlitzOS dictation preview may be occluded outside the default notch overlay window mode.')
  }, [])

  useEffect(() => {
    return window.agentOS?.onAction((action: DictationAction) => {
      if (action.type !== 'dictation') return
      if (hideTimer.current != null) {
        window.clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      if (action.phase === 'partial') {
        setText(action.text || '')
        setVisible(Boolean(action.text))
      } else if (action.phase === 'final') {
        setText(action.text || '')
        setVisible(Boolean(action.text))
        hideTimer.current = window.setTimeout(() => setVisible(false), 900)
      } else if (action.phase === 'idle') {
        setVisible(false)
      }
    })
  }, [])

  return (
    <div className="dictation-preview" data-show={visible}>
      {text}
    </div>
  )
}
