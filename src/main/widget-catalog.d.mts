// Types for the shared widget library (widget-catalog.mjs).

export type WidgetLang = 'html' | 'jsx' | 'tsx'

export interface WidgetMeta {
  name: string
  description: string
  needs: string[]
  props: Record<string, unknown>
  version: number
  origin: 'builtin' | 'authored'
  /** present (jsx/tsx) only for React widgets; absent = html */
  lang?: WidgetLang
  forkedFrom?: string
}

export interface WidgetSource extends WidgetMeta {
  /** Byte-exact, forkable source (html, or jsx/tsx when lang says so). */
  html: string
}

export interface SaveWidgetInput {
  name: string
  html: string
  lang?: WidgetLang
  description?: string
  needs?: string[]
  props?: Record<string, unknown>
  forkedFrom?: string
}

export function listWidgets(): WidgetMeta[]
export function getWidgetSource(name: string): WidgetSource | null
export function saveWidget(input: SaveWidgetInput): { name: string; version: number; origin: 'authored' }

export function widgetAuthoringMd(): string
export function runtimeRegistry(): Record<string, string>
