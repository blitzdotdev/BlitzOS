// Guards the files that reach the origin as static assets but that nothing
// imports: /terms, /privacy, /security, /landing and the icons.
//
// Vite copies packages/webapp/public/ into dist/, and the Worker serves dist/
// through its ASSETS binding. Because no module references those files, a
// missing one breaks no build and fails no type check — it just un-publishes
// the page on the next deploy. That is exactly how they survived untracked in
// a single working tree while the deployed site served them.
//
// packages/webapp/published-assets.json is the manifest. Two callers read it:
// this check, which the deploy runs before it touches Cloudflare, and
// test/published-assets.test.ts, which runs on every push.
//
// Fails closed. An unreadable or empty manifest is an error, not a pass — a
// guard that reports success when it could not check anything is worse than no
// guard.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEBAPP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Throws when a manifest entry is missing or empty in public/.
 * @param {string} webappDir absolute path to packages/webapp
 */
export function assertPublishedAssets(webappDir = WEBAPP_DIR) {
  const manifestPath = path.join(webappDir, "published-assets.json");

  let files;
  try {
    files = JSON.parse(readFileSync(manifestPath, "utf8")).files;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unreadable";
    throw new Error(`Cannot read ${manifestPath}: ${reason}`);
  }

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      `${manifestPath} lists no files. It must name every static asset a deploy has to publish.`,
    );
  }

  const missing = files.filter((name) => {
    const stats = statSync(path.join(webappDir, "public", name), { throwIfNoEntry: false });
    return stats?.isFile() !== true || stats.size === 0;
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing from packages/webapp/public/: ${missing.join(", ")}\n` +
        "These are listed in packages/webapp/published-assets.json and must be committed. " +
        "Deploying without them would un-publish those pages, so the deploy stops here.",
    );
  }

  return files.length;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    console.log(`published assets: ${assertPublishedAssets()} present`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "published asset check failed");
    process.exit(1);
  }
}
