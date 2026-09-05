import { describe, expect, it } from "vitest";
import { ReasoningSummaryFilter, stripEmptyReasoningComments } from "../ReasoningText";

describe("reasoning summary text", () => {
    it("strips trailing empty comments, including the observed malformed variant", () => {
        expect(stripEmptyReasoningComments("**Checking files**\n\n<!-- -->")).toBe(
            "**Checking files**\n\n"
        );
        expect(stripEmptyReasoningComments("**Checking files**\n\n<!-- */-->  \n")).toBe(
            "**Checking files**\n\n"
        );
    });

    it("handles a marker split at every delta boundary", () => {
        const text = "**Checking files**\n\n<!-- -->";
        for (let split = 0; split <= text.length; split += 1) {
            const filter = new ReasoningSummaryFilter();
            const output = filter.push(text.slice(0, split))
                + filter.push(text.slice(split))
                + filter.finish();
            expect(output).toBe("**Checking files**\n\n");
        }
    });

    it("preserves comments that may be meaningful", () => {
        expect(stripEmptyReasoningComments("Text <!-- -->")).toBe("Text <!-- -->");
        expect(stripEmptyReasoningComments("<!-- keep this -->")).toBe("<!-- keep this -->");
        expect(stripEmptyReasoningComments("<!-- -->\nMore text")).toBe("<!-- -->\nMore text");
        expect(stripEmptyReasoningComments("```html\n<!-- -->\n```"))
            .toBe("```html\n<!-- -->\n```");
    });
});
