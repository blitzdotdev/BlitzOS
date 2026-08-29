import type { AcpCommandSummary } from '@lody/shared';

type TextMatchRank = {
  score: number;
};

const WORD_BOUNDARY_CHARS = new Set([' ', '\t', '\n', '\r', '-', '_', '/', ':', '.']);

function normalizeSearchTerm(value: string): string {
  return value.trim().replace(/^\/+/, '').toLowerCase();
}

function normalizeCommandName(value: string): string {
  return value.trim().replace(/^\/+/, '').toLowerCase();
}

function findWordPrefixIndex(text: string, term: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (index > 0 && !WORD_BOUNDARY_CHARS.has(text[index - 1] ?? '')) continue;
    if (text.startsWith(term, index)) return index;
  }

  return -1;
}

function getSubsequenceMatchScore(text: string, term: string): number | null {
  let searchFrom = 0;
  let firstIndex = -1;
  let previousIndex = -1;
  let lastIndex = -1;
  let gapCount = 0;

  for (const char of term) {
    const index = text.indexOf(char, searchFrom);
    if (index === -1) return null;

    if (firstIndex === -1) firstIndex = index;
    if (previousIndex !== -1) gapCount += index - previousIndex - 1;
    previousIndex = index;
    lastIndex = index;
    searchFrom = index + 1;
  }

  const span = lastIndex - firstIndex + 1;
  return 60 + firstIndex * 4 + gapCount * 3 + (span - term.length);
}

function rankTextMatch(
  text: string | undefined,
  term: string,
  baseScore: number
): TextMatchRank | null {
  if (!text) return null;

  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized === term) return { score: baseScore };

  if (normalized.startsWith(term)) {
    return { score: baseScore + 10 + normalized.length - term.length };
  }

  const wordPrefixIndex = findWordPrefixIndex(normalized, term);
  if (wordPrefixIndex !== -1) {
    return { score: baseScore + 30 + wordPrefixIndex + normalized.length - term.length };
  }

  const substringIndex = normalized.indexOf(term);
  if (substringIndex !== -1) {
    return { score: baseScore + 45 + substringIndex * 2 + normalized.length - term.length };
  }

  const fuzzyScore = getSubsequenceMatchScore(normalized, term);
  if (fuzzyScore !== null) {
    return { score: baseScore + fuzzyScore + normalized.length - term.length };
  }

  return null;
}

export function rankSlashCommand(command: AcpCommandSummary, searchTerm: string): number | null {
  const term = normalizeSearchTerm(searchTerm);
  if (!term) return 0;

  const nameRank = rankTextMatch(normalizeCommandName(command.name), term, 0);
  const rawNameRank = rankTextMatch(command.name, term, 5);
  const descriptionRank = rankTextMatch(command.description, term, 120);
  const bestRank = [nameRank, rawNameRank, descriptionRank]
    .filter((rank): rank is TextMatchRank => rank !== null)
    .toSorted((a, b) => a.score - b.score)[0];

  return bestRank?.score ?? null;
}

export function filterAndRankSlashCommands(
  commands: AcpCommandSummary[],
  searchTerm: string
): AcpCommandSummary[] {
  const term = normalizeSearchTerm(searchTerm);
  if (!term) return commands;

  return commands
    .map((command, index) => ({
      command,
      index,
      rank: rankSlashCommand(command, term),
    }))
    .filter((entry): entry is { command: AcpCommandSummary; index: number; rank: number } => {
      return entry.rank !== null;
    })
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}
