/** One OSC 8 hyperlink: `ESC ] 8 ; params ; URI` closed by BEL or ST. The
 * params field carries `key=value` pairs separated by `:`, never `;`, so the
 * second `;` always opens the URI. claude-code writes the whole login URL in
 * that URI even when the visible copy wraps across rows, so the URI is the one
 * copy of the link no reflow can break. */
const OSC8_LINK = /\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x07|\x1b\\)/gu;

/** A hyperlink split across two websocket frames is only complete once both
 * halves are in hand, so an unterminated introducer is carried forward. The
 * cap stops a stream that never closes its escape from growing without end;
 * a real hyperlink is a few hundred bytes. */
const OSC8_CARRY_LIMIT = 4096;

export interface Osc8Scan {
  /** Hyperlink targets closed inside this chunk, in the order they arrived. */
  links: string[];
  /** Bytes to hand back as `carry` on the next chunk. */
  carry: string;
}

/** Reads the OSC 8 hyperlink targets out of one raw terminal write. */
export function scanOsc8Links(chunk: string, carry = ''): Osc8Scan {
  const text = carry + chunk;
  const links: string[] = [];
  let consumed = 0;
  OSC8_LINK.lastIndex = 0;
  for (let match = OSC8_LINK.exec(text); match !== null; match = OSC8_LINK.exec(text)) {
    const target = match[1] ?? '';
    // `ESC ] 8 ; ; ST` with an empty URI is the closing half of a hyperlink,
    // not a link of its own.
    if (target !== '') links.push(target);
    consumed = match.index + match[0].length;
  }
  const rest = text.slice(consumed);
  const opened = rest.lastIndexOf('\x1b]8;');
  const nextCarry = opened < 0 ? '' : rest.slice(opened);
  return { links, carry: nextCarry.length > OSC8_CARRY_LIMIT ? '' : nextCarry };
}

/** Reads the URLs on screen, stitching a URL that wrapped across rows back
 * together. Stitching needs the true wrap width: a row is a continuation only
 * when the row before it filled the screen exactly. When `cols` disagrees with
 * the width the rows were actually printed at — a resize the server has not
 * echoed yet — every wrapped URL comes back truncated at the first row end.
 *
 * `hyperlinks` are the OSC 8 targets the same stream carried. A stitched
 * candidate that is a prefix of one of them IS that link, seen wrapped, so the
 * target replaces it in place. Position is kept, so a caller that takes the
 * last match still takes the last URL on screen. */
export function extractTerminalUrls(
  rows: string[],
  cols?: number,
  hyperlinks: readonly string[] = [],
): string[] {
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

      const resolved = hyperlinks.find((link) => link.startsWith(candidate)) ?? candidate;
      if (!seen.has(resolved)) {
        seen.add(resolved);
        urls.push(resolved);
      }
      searchFrom = start + 'https://'.length;
      start = row.indexOf('https://', searchFrom);
    }
  }

  return urls;
}
