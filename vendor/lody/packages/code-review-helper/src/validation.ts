import type {
  LineRange,
  ReviewBundle,
  ReviewDiagnostic,
  ReviewDocument,
  ReviewResolvedBlock,
} from './types';

export function validateParsedReviewDocument(document: ReviewDocument): ReviewDiagnostic[] {
  const diagnostics: ReviewDiagnostic[] = [...document.diagnostics];
  const budget = document.frontmatter.lineBudget;

  for (const group of document.groups) {
    if (group.changedLines !== undefined && group.changedLines > budget) {
      diagnostics.push({
        severity: 'warning',
        message: `Group "${group.title}" declares ${group.changedLines} changed lines, above budget ${budget}.`,
        line: group.line,
        code: 'group_over_budget',
      });
    }
    const changeBlocks = group.blocks.filter((block) => block.kind === 'change');
    if (group.blocks.length === 0) {
      diagnostics.push({
        severity: 'warning',
        message: `Group "${group.title}" has no changes:// or context:// block.`,
        line: group.line,
        code: 'group_without_blocks',
      });
    } else if (changeBlocks.length === 0) {
      diagnostics.push({
        severity: 'info',
        message: `Group "${group.title}" contains only context:// blocks.`,
        line: group.line,
        code: 'group_only_context_blocks',
      });
    }
  }

  // A `## Review` finding must reference files shown in some group, or its chip has
  // nowhere to jump.
  const renderedPaths = new Set<string>();
  for (const group of document.groups) {
    for (const block of group.blocks) {
      renderedPaths.add(block.path);
    }
  }
  for (const finding of document.findings ?? []) {
    for (const ref of finding.refs) {
      if (!renderedPaths.has(ref.path)) {
        diagnostics.push({
          severity: 'warning',
          message: `Review finding references "${ref.path}", which is not shown in any group (its chip will not jump anywhere).`,
          line: finding.line,
          code: 'finding_ref_unresolved',
        });
      }
    }
  }

  return diagnostics;
}

export function collectBundleDiagnostics(bundle: ReviewBundle): ReviewDiagnostic[] {
  // `bundle.diagnostics` already includes `validateParsedReviewDocument(document)`
  // (set in resolveReviewBundle), so we must NOT validate the document again here, or
  // every parser/budget diagnostic would be reported twice.
  return [
    ...bundle.diagnostics,
    ...bundle.groups.flatMap((group) => group.diagnostics),
    ...bundle.groups.flatMap((group) => group.blocks.flatMap((block) => block.diagnostics)),
    ...Object.values(bundle.files).flatMap((file) => file.diagnostics),
  ];
}

export function validateResolvedBlock(block: ReviewResolvedBlock): ReviewDiagnostic[] {
  const diagnostics: ReviewDiagnostic[] = [];
  const file = block.file;
  if (!file) {
    diagnostics.push({
      severity: 'error',
      message: `No Git diff data was resolved for ${block.path}.`,
      line: block.line,
      code: 'missing_resolved_file',
    });
    return diagnostics;
  }

  validateRange(block.oldRange, file.oldText, 'old', block.line, diagnostics);
  validateRange(block.newRange, file.newText, 'new', block.line, diagnostics);
  for (const note of block.notes) {
    validateRange(
      note.range,
      note.side === 'old' ? file.oldText : file.newText,
      note.side,
      note.line,
      diagnostics
    );
  }
  return diagnostics;
}

function validateRange(
  range: LineRange | undefined,
  text: string,
  side: 'old' | 'new',
  line: number,
  diagnostics: ReviewDiagnostic[]
): void {
  if (!range) {
    return;
  }
  const lineCount = countLines(text);
  if (range.end > lineCount) {
    diagnostics.push({
      severity: 'error',
      message: `${side}://L${range.start}-L${range.end} exceeds ${side} file line count ${lineCount}.`,
      line,
      code: 'line_reference_out_of_bounds',
    });
  }
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length;
}

export function hasErrorDiagnostics(diagnostics: readonly ReviewDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
