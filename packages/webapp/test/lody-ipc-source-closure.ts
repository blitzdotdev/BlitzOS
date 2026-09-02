import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const WORKSPACE_ROOT = resolve(process.cwd(), "../..");
const WEBAPP_SOURCE_ROOT = resolve(process.cwd(), "src");
const VENDOR_COMPONENTS_ROOT = resolve(
  WORKSPACE_ROOT,
  "vendor/lody/packages/components/src",
);
const SURFACE_ENTRY = resolve(WEBAPP_SOURCE_ROOT, "lody/SessionSurface.tsx");

const IPC_HELPER_MIN_ARGUMENTS = new Map([
  ["getIpcServices", 1],
  ["onIpcEvent", 3],
  ["sendIpc", 3],
  ["sendLocalSessionControl", 3],
]);

/** Ambient sites that are deliberately unreachable or harmless in Blitz Web. */
const AMBIENT_IPC_ALLOWLIST = new Map<string, string>([
  [
    "vendor/lody/packages/components/src/theme-provider.tsx",
    "The hoisted theme owner only asks for native OS theme/window chrome; the Blitz bridge explicitly no-ops both channels.",
  ],
  [
    "vendor/lody/packages/components/src/atoms/local-probe.ts",
    "The effect returns before IPC unless window.__LODY_ELECTRON__ is true.",
  ],
  [
    "vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts",
    "The hook is inert unless window.__LODY_ELECTRON__ is true.",
  ],
  [
    "vendor/lody/packages/components/src/components/terminal/electron-terminal-channel.ts",
    "The terminal daemon channel is constructed only by the Electron-gated host.",
  ],
  [
    "vendor/lody/packages/components/src/components/sessions/session-chat-interface.tsx",
    "Its ambient calls are inside the Electron-only desktop path-launch branch.",
  ],
  [
    "vendor/lody/packages/components/src/lib/electron.ts",
    "Fullscreen IPC is guarded by isElectronRenderer().",
  ],
  [
    "vendor/lody/packages/components/src/lib/native-browser.ts",
    "Native URL opening checks the Electron/native shell before IPC.",
  ],
  [
    "vendor/lody/packages/components/src/lib/image-preview-export.ts",
    "Image export reaches IPC only in Electron.",
  ],
  [
    "vendor/lody/packages/components/src/lib/clear-local-cache.ts",
    "The reload request is Electron-gated; Web uses location.reload().",
  ],
  [
    "vendor/lody/packages/components/src/components/mobile/mobile-about-settings.tsx",
    "Blitz stubs every settings route; these updater actions are never mounted.",
  ],
  [
    "vendor/lody/packages/components/src/components/mobile/mobile-general-settings.tsx",
    "Blitz stubs every settings route; these notification and OS-setting controls are never mounted.",
  ],
  [
    "vendor/lody/packages/components/src/components/settings/about-setting.tsx",
    "Blitz stubs every settings route; these updater actions are never mounted.",
  ],
  [
    "vendor/lody/packages/components/src/components/settings/general-setting.tsx",
    "Blitz stubs every settings route; these notification and OS-setting controls are never mounted.",
  ],
  [
    "vendor/lody/packages/components/src/hooks/use-electron-updater-state.ts",
    "The effect returns unless window.__LODY_ELECTRON__ is true.",
  ],
  [
    "vendor/lody/packages/components/src/lib/native-global-shortcuts.ts",
    "All callers are Electron-only shortcut settings, and Blitz disables that settings surface and dispatcher.",
  ],
  [
    "vendor/lody/packages/components/src/lib/electron-ipc-client.ts",
    "This is the intentional Electron-compatible default implementation that alone reads window.ipc.",
  ],
]);

function sourceFileFor(importer: string, specifier: string): string | null {
  let unresolved: string;
  if (specifier.startsWith(".")) {
    unresolved = resolve(dirname(importer), specifier);
  } else if (specifier.startsWith("@lody/components/")) {
    unresolved = resolve(VENDOR_COMPONENTS_ROOT, specifier.slice("@lody/components/".length));
  } else if (specifier.startsWith("@/") && importer.startsWith(VENDOR_COMPONENTS_ROOT)) {
    unresolved = resolve(VENDOR_COMPONENTS_ROOT, specifier.slice(2));
  } else {
    return null;
  }
  const withoutJs = unresolved.replace(/\.(?:m?js|cjs)$/u, "");
  for (const candidate of [
    unresolved,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    resolve(withoutJs, "index.ts"),
    resolve(withoutJs, "index.tsx"),
  ]) {
    if (
      existsSync(candidate) &&
      statSync(candidate).isFile() &&
      (candidate.startsWith(WEBAPP_SOURCE_ROOT) || candidate.startsWith(VENDOR_COMPONENTS_ROOT))
    ) {
      return candidate;
    }
  }
  return null;
}

function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gu,
    /(?:^|\n)\s*export\s+(?:type\s+)?[^;]*?\s+from\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

export async function mountedSourceClosure(): Promise<string[]> {
  const pending = [SURFACE_ENTRY];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    for (const specifier of importSpecifiers(file)) {
      const dependency = sourceFileFor(file, specifier);
      if (dependency !== null && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited].sort();
}

export function workspacePath(file: string): string {
  return relative(WORKSPACE_ROOT, file).replaceAll("\\", "/");
}

/** Mask comments and literals while preserving byte offsets and line breaks. */
function maskNonCode(source: string): string {
  const masked = source.split("");
  let quote: "\"" | "'" | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      else masked[index] = " ";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        masked[index] = " ";
        masked[index + 1] = " ";
        blockComment = false;
        index += 1;
      } else if (character !== "\n") {
        masked[index] = " ";
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") {
        masked[index] = " ";
        if (source[index + 1] !== "\n") masked[index + 1] = " ";
        index += 1;
      } else {
        if (character === quote) quote = null;
        if (character !== "\n") masked[index] = " ";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      masked[index] = " ";
      masked[index + 1] = " ";
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      masked[index] = " ";
      masked[index + 1] = " ";
      blockComment = true;
      index += 1;
    } else if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      masked[index] = " ";
    }
  }
  return masked.join("");
}

function findCallEnd(source: string, openingParenthesis: number): number {
  let depth = 1;
  for (let index = openingParenthesis + 1; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function topLevelArgumentCount(source: string): number {
  if (source.trim() === "") return 0;
  let depth = 0;
  let commas = 0;
  for (const character of source) {
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (character === "," && depth === 0) commas += 1;
  }
  return commas + 1;
}

export function findUnscopedIpcCalls(file: string): string[] {
  const sourceText = readFileSync(file, "utf8");
  const source = maskNonCode(sourceText);
  const failures: string[] = [];
  const relativePath = workspacePath(file);
  if (AMBIENT_IPC_ALLOWLIST.has(relativePath)) return failures;
  const report = (index: number, label: string): void => {
    const line = source.slice(0, index).split("\n").length;
    failures.push(`${relativePath}:${line} ${label}`);
  };
  for (const [helper, minimum] of IPC_HELPER_MIN_ARGUMENTS) {
    const pattern = new RegExp(`\\b${helper}\\s*\\(`, "gu");
    for (const match of source.matchAll(pattern)) {
      const index = match.index;
      if (/\bfunction\s*$/u.test(source.slice(Math.max(0, index - 32), index))) continue;
      const opening = source.indexOf("(", index);
      const closing = findCallEnd(source, opening);
      if (topLevelArgumentCount(source.slice(opening + 1, closing)) < minimum) {
        report(index, helper);
      }
    }
  }
  for (const match of source.matchAll(/\bwindow\s*\.\s*ipc\b/gu)) {
    report(match.index, "window.ipc");
  }
  return failures;
}
