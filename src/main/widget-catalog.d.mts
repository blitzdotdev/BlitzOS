// Types for the shared widget library + integration-data registry (widget-catalog.mjs).

export interface WidgetMeta {
  name: string
  description: string
  needs: string[]
  props: Record<string, unknown>
  version: number
  origin: 'builtin' | 'authored'
  forkedFrom?: string
}

export interface WidgetSource extends WidgetMeta {
  /** Byte-exact, forkable HTML source. */
  html: string
}

export interface SaveWidgetInput {
  name: string
  html: string
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

export const WIDGET_AUTHORING_MD: string
