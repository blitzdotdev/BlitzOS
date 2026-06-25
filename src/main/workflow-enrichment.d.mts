// Type declarations for workflow-enrichment.mjs.
export interface EnrichmentDeps {
  repoRoot: string
  claudeCmd?: string
  getWorkspacePath?(): string | null
}
export function wireEnrichment(deps: EnrichmentDeps | null): void
export function spawnWorkflowEnrichment(info: { runId: string; surfaceId: string; file: string; view?: string; memDir?: string | null }): void
