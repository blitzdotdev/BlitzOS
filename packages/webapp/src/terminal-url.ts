export function extractTerminalUrls(rows: string[], cols?: number): string[] {
  const fullWidth = cols && cols > 0
    ? cols
    : rows.reduce((longest, row) => Math.max(longest, row.length), 0);
  const urls: string[] = [];
  const seen = new Set<string>();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    let searchFrom = 0;
    let start = row.indexOf('https://', searchFrom);
    while (start >= 0) {
      let candidate = '';
      let candidateRow = rowIndex;
      let offset = start;

      while (candidateRow < rows.length) {
        const current = rows[candidateRow]!;
        const segment = current.slice(offset);
        const whitespace = segment.search(/\s/u);
        if (whitespace >= 0) {
          candidate += segment.slice(0, whitespace);
          break;
        }
        candidate += segment;
        const next = rows[candidateRow + 1];
        if (current.length !== fullWidth || next === undefined || /^\s/u.test(next)) break;
        candidateRow += 1;
        offset = 0;
      }

      if (!seen.has(candidate)) {
        seen.add(candidate);
        urls.push(candidate);
      }
      searchFrom = start + 'https://'.length;
      start = row.indexOf('https://', searchFrom);
    }
  }

  return urls;
}
