export interface ToolRow {
  verb: string
  target: string
  detail?: string
}
export type TranscriptEvent =
  | { kind: 'tool'; name: string; row: ToolRow; ts?: number }
  | { kind: 'text'; text: string; ts?: number }
  | { kind: 'result'; isError: boolean; ts?: number }

export function sessionJsonlPath(wsRoot: string | null | undefined, claudeSessionId: string | null | undefined): string | null
export function lastAssistantStopReason(jsonlPath: string | null | undefined): string | null
export function toolRow(name: string, input: Record<string, unknown>): ToolRow
export function toolLabel(row: ToolRow | null | undefined): string
export function readSessionEvents(
  jsonlPath: string | null,
  sinceOffset?: number
): { events: TranscriptEvent[]; offset: number }
export function digestForNarrator(events: TranscriptEvent[], max?: number): string
