export type TerminalChoiceRow = {
  digits: string;
  hasCursor: boolean;
};

// Claude Code renders numbered picker rows with an optional cursor marker.
// Narrow terminals can omit the space after the dot ("2.Anthropic"), so keep
// that shipped form valid. This is the one parser used by scanning and taps.
const TERMINAL_CHOICE_ROW = /^\s*([❯>]\s*)?(\d{1,2})\.\s*\S/u;

export function parseTerminalChoiceRow(row: string): TerminalChoiceRow | null {
  const match = TERMINAL_CHOICE_ROW.exec(row);
  if (!match) return null;
  return {
    digits: match[2]!,
    hasCursor: match[1] !== undefined,
  };
}

export function hasTerminalChoiceMenu(rows: readonly string[]): boolean {
  const choices = new Set<string>();
  let hasCursor = false;
  for (const row of rows) {
    const choice = parseTerminalChoiceRow(row);
    if (!choice) continue;
    choices.add(choice.digits);
    hasCursor ||= choice.hasCursor;
  }
  return hasCursor && choices.size >= 2;
}
