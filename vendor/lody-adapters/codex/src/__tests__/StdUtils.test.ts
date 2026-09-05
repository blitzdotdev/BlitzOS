import {PassThrough} from "node:stream";
import {describe, expect, it, vi} from "vitest";

import {createJSONRPCReader} from "../StdUtils";

describe("createJSONRPCReader", () => {
    it("preserves UTF-8 characters split across stdout chunks", () => {
        const stdout = new PassThrough();
        const onMessage = vi.fn();
        createJSONRPCReader(stdout).listen(onMessage);

        const prefix = Buffer.from('{"method":"test","params":{"title":"');
        const firstCharacter = Buffer.from("\u4F60");
        stdout.write(Buffer.concat([prefix, firstCharacter.subarray(0, 2)]));
        stdout.write(Buffer.concat([firstCharacter.subarray(2), Buffer.from('\u597D"}}\n')]));

        expect(onMessage).toHaveBeenCalledOnce();
        expect(onMessage).toHaveBeenCalledWith({
            jsonrpc: "2.0",
            method: "test",
            params: {title: "\u4F60\u597D"},
        });
    });
});
