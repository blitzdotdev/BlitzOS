import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {spawn} from "node:child_process";
import {afterEach, describe, expect, it, vi} from "vitest";

import {startCodexConnection} from "../CodexJsonRpcConnection";

vi.mock("node:child_process", () => ({spawn: vi.fn()}));

function createChildProcess(): ChildProcessWithoutNullStreams {
    return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams;
}

describe("startCodexConnection", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("hides the Windows shell used to launch a managed Codex runtime", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        const child = createChildProcess();
        vi.mocked(spawn).mockReturnValue(child);
        const env = {CODEX_HOME: "C:\\codex-home"};
        const codexPath = "C:\\Program Files\\Codex\\codex.exe";

        const {connection} = startCodexConnection(codexPath, env);

        expect(spawn).toHaveBeenCalledWith(`"${codexPath}" app-server`, {
            shell: true,
            env,
            windowsHide: true,
        });
        connection.dispose();
    });
});
