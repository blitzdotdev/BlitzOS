/**
 * Config option ids the current version intentionally drops from an ACP
 * agent's `NewSessionResponse.configOptions` before they are cached for the UI
 * or applied in a live session.
 *
 * `acp-extension-claude` started exposing an `agent`-id config option, but the
 * client does not support it yet, so we filter it out for now instead of
 * surfacing an unhandled selector. Tracked as
 * BC-2026-06-24-ACP-CONFIG-OPTION-AGENT-FILTERED in
 * `docs/backward-compatibility.md`; remove the id from this set once the option
 * is supported.
 */
export const FILTERED_ACP_CONFIG_OPTION_IDS: ReadonlySet<string> = new Set(['agent']);

/**
 * Returns only the config options whose id is not in
 * {@link FILTERED_ACP_CONFIG_OPTION_IDS}. Generic over the option shape so it
 * works on both the raw ACP `SessionConfigOption[]` and the normalized summary.
 */
export function filterAcpConfigOptions<T extends { id: string }>(options: readonly T[]): T[] {
  return options.filter((opt) => !FILTERED_ACP_CONFIG_OPTION_IDS.has(opt.id));
}
