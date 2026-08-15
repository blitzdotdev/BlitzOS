import { MOBILE_PROMPT_REGION_ROWS } from './terminal-touch';

export type TerminalInputRowDecision = 'input' | 'outside' | 'fallback';

const BOX_TOP_BORDER = /^[╭┌]/u;
const BOX_BOTTOM_BORDER = /^[╰└]/u;
const BOX_CONTENT_ROW = /^│.*│$/u;
const PROMPT_CARET = /^[❯>]/u;

export function classifyTerminalInputRow(
  rows: readonly string[],
  tappedRow: number,
): TerminalInputRowDecision {
  if (!Number.isInteger(tappedRow) || tappedRow < 0 || tappedRow >= rows.length) {
    return 'outside';
  }

  let lastNonEmptyRow = rows.length - 1;
  while (lastNonEmptyRow >= 0 && !rows[lastNonEmptyRow]?.trim()) lastNonEmptyRow -= 1;
  if (lastNonEmptyRow < 0) return 'fallback';

  const trimmedRows = rows.map((row) => row.trim());
  const signatureStart = Math.max(0, lastNonEmptyRow - MOBILE_PROMPT_REGION_ROWS + 1);
  const nearBottom = trimmedRows.slice(signatureStart, lastNonEmptyRow + 1);
  const hasInputSignature = nearBottom.some((row) => (
    BOX_TOP_BORDER.test(row)
    || BOX_BOTTOM_BORDER.test(row)
    || BOX_CONTENT_ROW.test(row)
    || PROMPT_CARET.test(row)
  ));
  if (!hasInputSignature) return 'fallback';

  const tapped = trimmedRows[tappedRow] ?? '';
  if (PROMPT_CARET.test(tapped) || BOX_CONTENT_ROW.test(tapped)) return 'input';

  let boxTop = -1;
  for (let row = lastNonEmptyRow; row >= 0; row -= 1) {
    if (BOX_TOP_BORDER.test(trimmedRows[row] ?? '')) {
      boxTop = row;
      break;
    }
  }
  if (boxTop < 0) return 'outside';

  let boxBottom = lastNonEmptyRow;
  for (let row = boxTop + 1; row <= lastNonEmptyRow; row += 1) {
    if (BOX_BOTTOM_BORDER.test(trimmedRows[row] ?? '')) {
      boxBottom = row;
      break;
    }
  }
  return tappedRow >= boxTop && tappedRow <= boxBottom ? 'input' : 'outside';
}
