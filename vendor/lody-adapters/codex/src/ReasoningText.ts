const COMPLETE_EMPTY_COMMENT = /^<!--\s*(?:\*\/\s*)?-->\s*$/u;
const PARTIAL_COMMENT_BODY = /^\s*(?:\*\/?\s*)?$/u;
const PARTIAL_COMMENT_CLOSE = /^\s*(?:\*\/\s*)?-{1,2}$/u;

const isHorizontalWhitespace = (char: string): boolean => char === " " || char === "\t";

const canBecomeEmptyComment = (text: string): boolean => {
    if (text === "<" || text === "<!" || text === "<!-") {
        return true;
    }
    if (!text.startsWith("<!--")) {
        return false;
    }

    const tail = text.slice(4);
    return COMPLETE_EMPTY_COMMENT.test(text)
        || PARTIAL_COMMENT_BODY.test(tail)
        || PARTIAL_COMMENT_CLOSE.test(tail);
};

/**
 * Removes Codex's trailing, line-isolated empty reasoning comments.
 *
 * The marker can be split across JSON-RPC deltas, so a per-delta regex would miss it. Text that
 * stops matching the narrow marker grammar is released immediately and unchanged.
 */
export class ReasoningSummaryFilter {
    private pending = "";
    private lineHasContent = false;

    push(delta: string): string {
        let output = "";

        const emit = (text: string) => {
            output += text;
            for (const char of text) {
                if (char === "\n" || char === "\r") {
                    this.lineHasContent = false;
                } else if (!isHorizontalWhitespace(char)) {
                    this.lineHasContent = true;
                }
            }
        };

        for (const char of delta) {
            if (this.pending) {
                this.pending += char;
                if (canBecomeEmptyComment(this.pending)) {
                    continue;
                }
                emit(this.pending);
                this.pending = "";
                continue;
            }

            if (char === "<" && !this.lineHasContent) {
                this.pending = char;
            } else {
                emit(char);
            }
        }

        return output;
    }

    finish(): string {
        const output = COMPLETE_EMPTY_COMMENT.test(this.pending) ? "" : this.pending;
        this.pending = "";
        this.lineHasContent = false;
        return output;
    }
}

export function stripEmptyReasoningComments(text: string): string {
    const filter = new ReasoningSummaryFilter();
    return filter.push(text) + filter.finish();
}

/**
 * Selects a reasoning item's displayable parts: summary when present, else raw content. Only the
 * summary carries the model's empty-comment markers, so stripping is applied to summary parts only,
 * never to raw content. Empty parts are dropped.
 */
export function sanitizeReasoningParts(summary: string[], content: string[]): string[] {
    const useSummary = summary.length > 0;
    const parts = useSummary ? summary : content;
    return parts
        .map((part) => useSummary ? stripEmptyReasoningComments(part) : part)
        .filter((part) => part.length > 0);
}
