import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Node, Program } from "@oxc-project/types";
import { parseSync } from "rolldown/experimental";
import { LODY_VENDOR_SOURCE_ALIASES } from "../src/lody/vendor-bridge.js";

const WORKSPACE_ROOT = resolve(process.cwd(), "../..");
const WEBAPP_SOURCE_ROOT = resolve(process.cwd(), "src");
const VENDOR_PACKAGES_ROOT = resolve(WORKSPACE_ROOT, "vendor/lody/packages");
const VENDOR_COMPONENTS_ROOT = resolve(VENDOR_PACKAGES_ROOT, "components/src");
const SURFACE_ENTRY = resolve(WEBAPP_SOURCE_ROOT, "lody/SessionSurface.tsx");

const IPC_HELPER_MIN_ARGUMENTS = new Map([
  ["getIpcServices", 1],
  ["getPublicBrowserBridge", 1],
  ["onIpcEvent", 3],
  ["sendIpc", 3],
  ["sendLocalSessionControl", 3],
]);

interface AmbientIpcAllowance {
  file: string;
  helper: string;
  expectedCount: number;
  reason: string;
}

const reasons = {
  theme: "The hoisted owner uses native theme/window chrome channels that the Blitz bridge no-ops.",
  electron: "The call site returns before IPC unless the Electron renderer flag is true.",
  terminal: "The channel is constructed only by the Electron-gated terminal host.",
  path: "The desktop path-launch branch is Electron-only.",
  native: "The native operation checks the Electron/native shell before IPC.",
  settings: "Blitz stubs the settings route, so these native controls are not mounted.",
  shortcuts: "Both shortcut settings and their dispatcher are disabled in Blitz Web.",
  default: "This is the intentional lazy Electron-compatible window client.",
};

/** Exact helper counts: a new ambient call in any listed file fails this audit. */
const AMBIENT_IPC_ALLOWLIST: readonly AmbientIpcAllowance[] = [
  { file: "vendor/lody/packages/components/src/theme-provider.tsx", helper: "getIpcServices", expectedCount: 1, reason: reasons.theme },
  { file: "vendor/lody/packages/components/src/theme-provider.tsx", helper: "onIpcEvent", expectedCount: 1, reason: reasons.theme },
  { file: "vendor/lody/packages/components/src/atoms/local-probe.ts", helper: "getIpcServices", expectedCount: 2, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/atoms/local-probe.ts", helper: "sendIpc", expectedCount: 1, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/atoms/local-probe.ts", helper: "onIpcEvent", expectedCount: 1, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts", helper: "getIpcServices", expectedCount: 6, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts", helper: "sendIpc", expectedCount: 1, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts", helper: "onIpcEvent", expectedCount: 1, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/components/terminal/electron-terminal-channel.ts", helper: "getIpcServices", expectedCount: 5, reason: reasons.terminal },
  { file: "vendor/lody/packages/components/src/components/terminal/electron-terminal-channel.ts", helper: "sendIpc", expectedCount: 5, reason: reasons.terminal },
  { file: "vendor/lody/packages/components/src/components/terminal/electron-terminal-channel.ts", helper: "onIpcEvent", expectedCount: 3, reason: reasons.terminal },
  { file: "vendor/lody/packages/components/src/components/sessions/session-chat-interface.tsx", helper: "getIpcServices", expectedCount: 3, reason: reasons.path },
  { file: "vendor/lody/packages/components/src/lib/electron.ts", helper: "getIpcServices", expectedCount: 1, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/lib/electron.ts", helper: "onIpcEvent", expectedCount: 1, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/lib/native-browser.ts", helper: "getIpcServices", expectedCount: 2, reason: reasons.native },
  { file: "vendor/lody/packages/components/src/lib/image-preview-export.ts", helper: "getIpcServices", expectedCount: 1, reason: reasons.native },
  { file: "vendor/lody/packages/components/src/lib/clear-local-cache.ts", helper: "getIpcServices", expectedCount: 2, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/components/mobile/mobile-about-settings.tsx", helper: "getIpcServices", expectedCount: 4, reason: reasons.settings },
  { file: "vendor/lody/packages/components/src/components/mobile/mobile-general-settings.tsx", helper: "getIpcServices", expectedCount: 9, reason: reasons.settings },
  { file: "vendor/lody/packages/components/src/components/settings/about-setting.tsx", helper: "getIpcServices", expectedCount: 4, reason: reasons.settings },
  { file: "vendor/lody/packages/components/src/components/settings/general-setting.tsx", helper: "getIpcServices", expectedCount: 9, reason: reasons.settings },
  { file: "vendor/lody/packages/components/src/hooks/use-electron-updater-state.ts", helper: "getIpcServices", expectedCount: 2, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/hooks/use-electron-updater-state.ts", helper: "onIpcEvent", expectedCount: 1, reason: reasons.electron },
  { file: "vendor/lody/packages/components/src/lib/native-global-shortcuts.ts", helper: "getIpcServices", expectedCount: 5, reason: reasons.shortcuts },
  { file: "vendor/lody/packages/components/src/lib/electron-ipc-client.ts", helper: "window.ipc", expectedCount: 1, reason: reasons.default },
];

interface InternalAlias {
  find: string;
  replacement: string;
}

function internalAliases(): InternalAlias[] {
  const aliases: InternalAlias[] = LODY_VENDOR_SOURCE_ALIASES.map((alias) => ({
    find: alias.find,
    replacement: resolve(WORKSPACE_ROOT, "vendor/lody", alias.vendorSource),
  }));
  aliases.push({ find: "@/", replacement: VENDOR_COMPONENTS_ROOT });
  return aliases;
}

function aliasedBase(importer: string, specifier: string): string | null {
  const cleanSpecifier = specifier.replace(/[?#].*$/u, "");
  if (cleanSpecifier.startsWith(".")) return resolve(dirname(importer), cleanSpecifier);
  for (const alias of internalAliases()) {
    if (alias.find === "@/" && !importer.startsWith(VENDOR_COMPONENTS_ROOT)) continue;
    const prefixMatch = alias.find.endsWith("/")
      ? cleanSpecifier.startsWith(alias.find)
      : cleanSpecifier === alias.find || cleanSpecifier.startsWith(`${alias.find}/`);
    if (!prefixMatch) continue;
    const suffix = cleanSpecifier.slice(alias.find.length).replace(/^\//u, "");
    return resolve(alias.replacement, suffix);
  }
  return null;
}

function sourceFileFor(importer: string, specifier: string): string | null | undefined {
  const unresolved = aliasedBase(importer, specifier);
  if (unresolved === null) return undefined;
  const withoutScriptExtension = unresolved.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
  const candidates = [
    unresolved,
    ...["ts", "tsx", "js", "jsx", "mts", "mjs", "cts", "cjs"].map(
      (extension) => `${withoutScriptExtension}.${extension}`,
    ),
    ...["ts", "tsx", "js", "jsx"].map(
      (extension) => resolve(withoutScriptExtension, `index.${extension}`),
    ),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    if (!/\.[cm]?[jt]sx?$/u.test(candidate)) return undefined;
    if (candidate.startsWith(WEBAPP_SOURCE_ROOT) || candidate.startsWith(VENDOR_PACKAGES_ROOT)) {
      return candidate;
    }
  }
  throw new Error(`${workspacePath(importer)}: unresolved internal import ${JSON.stringify(specifier)}`);
}

const sourceFiles = new Map<string, Program>();
const sourceText = new Map<string, string>();
const IPC_CANDIDATE = new RegExp(
  String.raw`\b(?:${[...IPC_HELPER_MIN_ARGUMENTS.keys()].join("|")})\s*\(|\bwindow\s*\.\s*ipc\b`,
  "u",
);

function importSpecifiers(file: string): string[] {
  const source = readSource(file);
  const parsed = parseSync(file, source, { astType: "js" });
  if (parsed.errors.length > 0) {
    throw new Error(`${workspacePath(file)}: ${parsed.errors.map((error) => error.message).join("; ")}`);
  }
  if (IPC_CANDIDATE.test(source)) sourceFiles.set(file, parsed.program);
  const specifiers = new Set<string>();
  for (const imported of parsed.module.staticImports) {
    if (imported.entries.length === 0 || imported.entries.some((entry) => !entry.isType)) {
      specifiers.add(imported.moduleRequest.value);
    }
  }
  for (const exported of parsed.module.staticExports) {
    for (const entry of exported.entries) {
      if (!entry.isType && entry.moduleRequest !== null) specifiers.add(entry.moduleRequest.value);
    }
  }
  for (const imported of parsed.module.dynamicImports) {
    const raw = source.slice(imported.moduleRequest.start, imported.moduleRequest.end);
    const quote = raw.at(0);
    if ((quote === '"' || quote === "'") && raw.at(-1) === quote) {
      specifiers.add(raw.slice(1, -1).replaceAll(`\\${quote}`, quote));
    }
  }
  return [...specifiers];
}

function readSource(file: string): string {
  const cached = sourceText.get(file);
  if (cached !== undefined) return cached;
  const source = readFileSync(file, "utf8");
  sourceText.set(file, source);
  return source;
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
      if (dependency !== undefined && dependency !== null && !visited.has(dependency)) {
        pending.push(dependency);
      }
    }
  }
  const closure = [...visited].sort();
  return closure;
}

export function workspacePath(file: string): string {
  return relative(WORKSPACE_ROOT, file).replaceAll("\\", "/");
}

function isNode(value: unknown): value is Node {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "type") === "string"
    && typeof Reflect.get(value, "start") === "number"
    && typeof Reflect.get(value, "end") === "number";
}

function visitNodes(node: Node, visit: (candidate: Node) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visitNodes(item, visit);
    } else if (isNode(value)) {
      visitNodes(value, visit);
    }
  }
}

function lineOf(file: string, node: Node): number {
  return readSource(file).slice(0, node.start).split("\n").length;
}

export function findUnscopedIpcCalls(file: string): string[] {
  if (!IPC_CANDIDATE.test(readSource(file))) return [];
  const source = sourceFiles.get(file);
  if (source === undefined) throw new Error(`Source AST was not loaded for ${workspacePath(file)}`);
  const relativePath = workspacePath(file);
  const sites = new Map<string, number[]>();
  const add = (helper: string, node: Node): void => {
    const lines = sites.get(helper) ?? [];
    lines.push(lineOf(file, node));
    sites.set(helper, lines);
  };
  visitNodes(source, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const minimum = IPC_HELPER_MIN_ARGUMENTS.get(node.callee.name);
      if (minimum !== undefined && node.arguments.length < minimum) add(node.callee.name, node);
    }
    if (node.type === "MemberExpression"
      && !node.computed
      && node.object.type === "Identifier"
      && node.object.name === "window"
      && node.property.type === "Identifier"
      && node.property.name === "ipc") {
      add("window.ipc", node);
    }
  });

  const failures: string[] = [];
  const allowances = AMBIENT_IPC_ALLOWLIST.filter((entry) => entry.file === relativePath);
  for (const allowance of allowances) {
    const actual = sites.get(allowance.helper)?.length ?? 0;
    if (actual !== allowance.expectedCount) {
      failures.push(
        `${relativePath} ${allowance.helper}: expected ${allowance.expectedCount} ambient call(s), found ${actual}; ${allowance.reason}`,
      );
    }
    sites.delete(allowance.helper);
  }
  for (const [helper, lines] of sites) {
    for (const line of lines) failures.push(`${relativePath}:${line} ${helper}`);
  }
  return failures;
}
