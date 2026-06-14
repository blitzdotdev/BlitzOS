// Types for the shared widget library + integration-data registry (widget-catalog.mjs).

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

export interface NormalizedItem {
  label: string
  sub?: string
  icon?: string
  badge?: string
  url?: string
}

export interface ProviderResourceDef {
  url: string
  normalize: (json: unknown) => NormalizedItem[] | null
}

export function listWidgets(): WidgetMeta[]
export function getWidgetSource(name: string): WidgetSource | null
export function saveWidget(input: SaveWidgetInput): { name: string; version: number; origin: 'authored' }

export const PROVIDER_DATA: Record<string, Record<string, ProviderResourceDef>>
export function listProviderResources(): string[]
export function fetchProviderResource(
  provider: string,
  resource: string,
  token: string | undefined
): Promise<{ items: NormalizedItem[] }>

export function widgetAuthoringMd(): string
export function runtimeRegistry(): Record<string, string>
