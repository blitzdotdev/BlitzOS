import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { UPLOAD_ORDER } from "../scripts/lib/worker-source.mjs";
import {
  fetchMigrationText,
  managedApiRequest,
  migrationText,
  pushManagedSet,
  redactSecrets,
  saveVersion,
} from "../scripts/lib/managed-api.mjs";

// Vendor-only: this suite exercises the blitz.dev managed platform client,
// which forks do not deploy through. Skipped unless BLITZDEV_MANAGED=1.
const managedToolchainEnabled = env.BLITZDEV_MANAGED === "1";

const access = {
  base: "https://blitz.dev/api/v1/projects/example",
  appUrl: "https://example.app.blitz.dev",
  token: "private-agent-token",
};

function fakeUploadSet(): { files: { path: string; source: string; bytes: number; sha256: string }[]; releaseHash: string } {
  return {
    files: UPLOAD_ORDER.map((uploadPath) => ({
      path: uploadPath,
      source: `// ${uploadPath}\n`,
      bytes: uploadPath.length,
      sha256: `sha-${uploadPath}`,
    })),
    releaseHash: "release-hash",
  };
}

/**
 * A blitz.dev project that behaves the way the real one did in run 2: it
 * serves a migration while the applied schema differs from the uploaded one,
 * and answers file_not_found for @migration.sql once a commit has made them
 * match.
 */
function fakeProject(migrationSql = "CREATE TABLE users (id TEXT);"): {
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  out: { write(text: string): void };
  written: () => string;
  commits: number;
} {
  const lines: string[] = [];
  const project = {
    commits: 0,
    out: { write: (text: string) => void lines.push(text) },
    written: () => lines.join(""),
    fetcher: async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/commit")) {
        project.commits += 1;
        return new Response('{"success":true,"result":{"commit":"abc123"}}');
      }
      if (url.includes("%40migration.sql")) {
        return project.commits === 0
          ? new Response(migrationSql)
          : new Response('{"error":{"code":404,"message":"file_not_found"}}', { status: 404 });
      }
      return new Response(
        '{"success":true,"result":{"version":1,"config":{"ok":true},"bundle":{"ok":true}}}',
        { headers: { "x-save-version": "1" } },
      );
    },
  };
  return project;
}

describe.skipIf(!managedToolchainEnabled)("blitz.dev managed API response contract [vendor-only: set BLITZDEV_MANAGED=1 to run]", () => {
  it("constructs authenticated requests and preserves JSON and text bodies", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"success":true}', {
        headers: { "x-save-version": "7" },
      }));

    const result = await managedApiRequest(
      access,
      "/files?path=core%2Findex.ts",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8", "If-Match": "6" },
        body: "source",
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://blitz.dev/api/v1/projects/example/files?path=core%2Findex.ts",
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer private-agent-token",
          "Content-Type": "text/plain; charset=utf-8",
          "If-Match": "6",
        },
        body: "source",
      },
    );
    expect(result.body).toEqual({ success: true });
    expect(saveVersion(result.response, result.body)).toBe("7");

    const textFetcher = vi.fn(async () => new Response("SELECT 1;"));
    await expect(managedApiRequest(access, "/files?path=%40migration.sql", {}, textFetcher))
      .resolves.toMatchObject({ body: "SELECT 1;" });
  });

  it("keeps response-version precedence and migration payload candidate order", () => {
    const response = new Response("", {
      headers: { "x-save-version": "header", etag: 'W/"etag"' },
    });
    expect(saveVersion(response, { result: { version: 42 } })).toBe("42");
    expect(saveVersion(response, {})).toBe("header");
    expect(saveVersion(new Response("", { headers: { etag: 'W/"etag"' } }), {})).toBe("etag");
    expect(migrationText("SELECT direct;")).toBe("SELECT direct;");
    expect(migrationText({
      result: { content: "SELECT content;", text: "SELECT text;", sql: "SELECT sql;" },
      content: "SELECT outer;",
    })).toBe("SELECT content;");
    expect(() => migrationText({ result: {} })).toThrow(
      "migration response did not contain SQL text",
    );
  });

  it("rejects non-success responses with redacted credentials", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ token: "tp__secret-value", password: "project-secret" }),
      { status: 409 },
    ));

    await expect(managedApiRequest(access, "/files", {}, fetcher)).rejects.toThrow(
      'API 409: {"token":"[REDACTED]","password":"[REDACTED]"}',
    );
  });

  // B9. Real platform tokens carry a single-underscore `tp_`; the pattern
  // required `tp__`, so every live token passed through unredacted and had to
  // be scrubbed by hand. Both shapes below are fake.
  it("redacts single-underscore tp_ tokens, not just the doubled form", () => {
    const single = "tp_a1b2c3d4e5f6g7h8i9j0";
    const doubled = "tp__a1b2c3d4e5f6g7h8i9j0";

    expect(redactSecrets(`token=${single}`)).toBe("token=[REDACTED]");
    expect(redactSecrets(`token=${doubled}`)).toBe("token=[REDACTED]");
    expect(redactSecrets(`{"agent_link":"https://blitz.dev/agent/${single}/agents.md"}`))
      .not.toContain(single);
    // Not a token prefix, and must survive untouched.
    expect(redactSecrets("http_status=200 tpx_keepme")).toBe("http_status=200 tpx_keepme");
  });

  // B10. GET @migration.sql answers file_not_found once the applied schema
  // matches the uploaded one. Treating that as an error made every re-run of
  // an already-current project exit 1 after all files had saved fine.
  it("reads an absent migration as an empty diff, not an error", async () => {
    expect(migrationText({ error: { code: 404, message: "file_not_found" } })).toBe("");
    expect(migrationText("file_not_found")).toBe("");
    expect(migrationText(null)).toBe("");

    const notFound = vi.fn(async () => new Response('{"error":"file_not_found"}', { status: 404 }));
    await expect(fetchMigrationText(access, notFound)).resolves.toBe("");

    const pending = vi.fn(async () => new Response("ALTER TABLE users ADD COLUMN x TEXT;"));
    await expect(fetchMigrationText(access, pending)).resolves.toBe("ALTER TABLE users ADD COLUMN x TEXT;");
  });

  it("re-runs a deploy against an already-current project as a clean no-op", async () => {
    const platform = fakeProject();
    const uploadSet = fakeUploadSet();

    const first = await pushManagedSet(uploadSet, access, { commit: true, fetcher: platform.fetcher, out: platform.out });
    expect(first.migration).toContain("CREATE TABLE");
    expect(first.committed).toBe(true);
    expect(platform.commits).toBe(1);

    // Second run: same artifact, schema already applied, so the platform
    // serves no migration. This is the run that used to throw and exit 1.
    const second = await pushManagedSet(uploadSet, access, { commit: true, fetcher: platform.fetcher, out: platform.out });
    expect(second.migration).toBe("");
    expect(second.committed).toBe(true);
    expect(second.saves).toHaveLength(UPLOAD_ORDER.length);
    expect(platform.commits).toBe(2);
    expect(platform.written()).toContain("migration\tempty\tschema-already-current");
  });

  // The other half of B9: redaction guarded thrown messages only, so the
  // platform's own migration preview printed to stdout raw.
  it("redacts what the deploy prints, not only what it throws", async () => {
    const platform = fakeProject(`-- restoring agent link\n-- https://blitz.dev/agent/tp_a1b2c3d4e5f6g7h8/agents.md\nCREATE TABLE users (id TEXT);`);
    await pushManagedSet(fakeUploadSet(), access, { fetcher: platform.fetcher, out: platform.out });

    expect(platform.written()).not.toContain("tp_a1b2c3d4e5f6g7h8");
    expect(platform.written()).toContain("[REDACTED]");
  });
});
