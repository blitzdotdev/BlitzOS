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
  scope: string;
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
  autoLaunch: "Both callers are stubbed settings routes, and each operation returns unless its Electron flag is true.",
  shortcuts: "Both shortcut settings and their dispatcher are disabled in Blitz Web.",
  default: "This is the intentional lazy Electron-compatible window client.",
};

const allowance = (
  file: string,
  helper: string,
  scope: string,
  expectedCount: number,
  reason: string,
): AmbientIpcAllowance => ({ file, helper, scope, expectedCount, reason });

/** Exact named sites: moving a call to another function fails even if its file count is unchanged. */
const AMBIENT_IPC_ALLOWLIST: readonly AmbientIpcAllowance[] = [
  allowance("vendor/lody/packages/components/src/theme-provider.tsx", "getIpcServices", "LodyThemeProvider", 1, reasons.theme),
  allowance("vendor/lody/packages/components/src/theme-provider.tsx", "onIpcEvent", "LodyThemeProvider", 1, reasons.theme),
  allowance("vendor/lody/packages/components/src/atoms/local-probe.ts", "getIpcServices", "localProbeEffectAtom", 2, reasons.electron),
  allowance("vendor/lody/packages/components/src/atoms/local-probe.ts", "sendIpc", "localProbeEffectAtom", 1, reasons.electron),
  allowance("vendor/lody/packages/components/src/atoms/local-probe.ts", "onIpcEvent", "localProbeEffectAtom", 1, reasons.electron),
  allowance("vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts", "getIpcServices", "useElectronCliDaemon", 2, reasons.electron),
  allowance("vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts", "getIpcServices", "restart", 2, reasons.electron),
  allowance("vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts", "getIpcServices", "terminate", 2, reasons.electron),
  allowance("vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts", "sendIpc", "useElectronCliDaemon", 1, reasons.electron),
  allowance("vendor/lody/packages/components/src/hooks/use-electron-cli-daemon.ts", "onIpcEvent", "useElectronCliDaemon", 1, reasons.electron),
  ...["list", "open", "readClipboardText", "writeClipboardText", "createElectronTerminalChannel"].map(
    (scope) => allowance("vendor/lody/packages/components/src/components/terminal/electron-terminal-channel.ts", "getIpcServices", scope, 1, reasons.terminal),
  ),
  ...["attach", "input", "resize", "close", "closeSession"].map(
    (scope) => allowance("vendor/lody/packages/components/src/components/terminal/electron-terminal-channel.ts", "sendIpc", scope, 1, reasons.terminal),
  ),
  ...["onData", "onExit", "onTitle"].map(
    (scope) => allowance("vendor/lody/packages/components/src/components/terminal/electron-terminal-channel.ts", "onIpcEvent", scope, 1, reasons.terminal),
  ),
  allowance("vendor/lody/packages/components/src/components/sessions/session-chat-interface.tsx", "getIpcServices", "SessionChatInterface", 1, reasons.path),
  allowance("vendor/lody/packages/components/src/components/sessions/session-chat-interface.tsx", "getIpcServices", "launchPathWithLauncher", 2, reasons.path),
  allowance("vendor/lody/packages/components/src/lib/electron.ts", "getIpcServices", "ensureFullscreenBridge", 1, reasons.electron),
  allowance("vendor/lody/packages/components/src/lib/electron.ts", "onIpcEvent", "ensureFullscreenBridge", 1, reasons.electron),
  allowance("vendor/lody/packages/components/src/lib/native-browser.ts", "getIpcServices", "openExternalUrl", 2, reasons.native),
  allowance("vendor/lody/packages/components/src/lib/image-preview-export.ts", "getIpcServices", "getImagePreviewExportBridge", 1, reasons.native),
  allowance("vendor/lody/packages/components/src/lib/clear-local-cache.ts", "getIpcServices", "reloadApp", 2, reasons.electron),
  allowance("vendor/lody/packages/components/src/components/mobile/mobile-about-settings.tsx", "getIpcServices", "handleCheckForUpdates", 2, reasons.settings),
  allowance("vendor/lody/packages/components/src/components/mobile/mobile-about-settings.tsx", "getIpcServices", "handleQuitAndInstall", 2, reasons.settings),
  allowance("vendor/lody/packages/components/src/components/settings/about-setting.tsx", "getIpcServices", "handleCheckForUpdates", 2, reasons.settings),
  allowance("vendor/lody/packages/components/src/components/settings/about-setting.tsx", "getIpcServices", "handleQuitAndInstall", 2, reasons.settings),
  ...[
    ["readElectronNotificationPermission", 2], ["MobileGeneralSettings", 2],
    ["openSystemNotificationSettings", 2],
  ].map(([scope, count]) => allowance("vendor/lody/packages/components/src/components/mobile/mobile-general-settings.tsx", "getIpcServices", String(scope), Number(count), reasons.settings)),
  ...[
    ["useElectronEnabledSetting", 1], ["readElectronNotificationPermission", 1],
    ["GeneralSettingsComponent", 1], ["openSystemNotificationSettings", 1],
    ["handleToggleCliAutoStart", 2],
  ].map(([scope, count]) => allowance("vendor/lody/packages/components/src/components/settings/general-setting.tsx", "getIpcServices", String(scope), Number(count), reasons.settings)),
  ...["useElectronAutoLaunch", "updateEnabled", "updateHideWindow"].map((scope) =>
    allowance("vendor/lody/packages/components/src/hooks/use-electron-auto-launch.ts", "getIpcServices", scope, 1, reasons.autoLaunch)
  ),
  allowance("vendor/lody/packages/components/src/hooks/use-electron-updater-state.ts", "getIpcServices", "useElectronUpdaterState", 2, reasons.electron),
  allowance("vendor/lody/packages/components/src/hooks/use-electron-updater-state.ts", "onIpcEvent", "useElectronUpdaterState", 1, reasons.electron),
  allowance("vendor/lody/packages/components/src/lib/native-global-shortcuts.ts", "getIpcServices", "getGlobalShortcuts", 2, reasons.shortcuts),
  allowance("vendor/lody/packages/components/src/lib/native-global-shortcuts.ts", "getIpcServices", "setGlobalShortcutsSuspended", 1, reasons.shortcuts),
  allowance("vendor/lody/packages/components/src/lib/native-global-shortcuts.ts", "getIpcServices", "setGlobalShortcut", 2, reasons.shortcuts),
  allowance("vendor/lody/packages/components/src/lib/electron-ipc-client.ts", "window.ipc", "readIpcBridge", 1, reasons.default),
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

function identifierName(node: Node): string | null {
  if (node.type !== "Identifier") return null;
  const name = Reflect.get(node, "name");
  return typeof name === "string" ? name : null;
}

function wrapsFunction(node: Node): boolean {
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return true;
  if (node.type !== "CallExpression") return false;
  if (node.callee.type !== "Identifier"
    || !["atomEffect", "forwardRef", "memo", "useCallback"].includes(node.callee.name)) {
    return false;
  }
  return node.arguments.some((argument) => isNode(argument) && wrapsFunction(argument));
}

function childScope(node: Node, scope: string): string {
  if (node.type === "FunctionDeclaration") {
    const id = Reflect.get(node, "id");
    return isNode(id) ? identifierName(id) ?? scope : scope;
  }
  if (node.type === "VariableDeclarator") {
    const id = Reflect.get(node, "id");
    const init = Reflect.get(node, "init");
    if (isNode(id) && isNode(init) && wrapsFunction(init)) {
      return identifierName(id) ?? scope;
    }
  }
  if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
    const key = Reflect.get(node, "key");
    return isNode(key) ? identifierName(key) ?? scope : scope;
  }
  return scope;
}

function patternBindings(node: Node): string[] {
  const own = identifierName(node);
  if (own !== null) return [own];
  const bindings: string[] = [];
  for (const key of ["left", "argument", "value", "elements", "properties", "parameter"]) {
    const value = Reflect.get(node, key);
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) bindings.push(...patternBindings(item));
    } else if (isNode(value)) {
      bindings.push(...patternBindings(value));
    }
  }
  return bindings;
}

function isFunctionNode(node: Node): boolean {
  return node.type === "ArrowFunctionExpression"
    || node.type === "FunctionDeclaration"
    || node.type === "FunctionExpression";
}

function clientOrigin(node: Node, bound: ReadonlySet<string>): boolean {
  if (node.type === "Identifier") return bound.has(node.name);
  if (node.type === "CallExpression") {
    return node.callee.type === "Identifier" && node.callee.name === "useIpcClient";
  }
  if (node.type === "MemberExpression") return clientOrigin(node.object, bound);
  if (node.type === "LogicalExpression" || node.type === "ConditionalExpression") {
    return Object.values(node).some((value) => isNode(value) && clientOrigin(value, bound));
  }
  for (const key of ["expression", "argument", "right"]) {
    const value = Reflect.get(node, key);
    if (isNode(value) && clientOrigin(value, bound)) return true;
  }
  return false;
}

function visitNodes(
  node: Node,
  visit: (candidate: Node, scope: string, boundClients: ReadonlySet<string>) => void,
  scope = "<module>",
  inheritedClients: Set<string> = new Set(),
): void {
  const nestedScope = childScope(node, scope);
  const boundClients = isFunctionNode(node) || node.type === "BlockStatement"
    ? new Set(inheritedClients)
    : inheritedClients;
  if (isFunctionNode(node)) {
    const params = Reflect.get(node, "params");
    if (Array.isArray(params)) {
      for (const param of params) {
        if (!isNode(param)) continue;
        for (const binding of patternBindings(param)) boundClients.add(binding);
      }
    }
  }
  if (node.type === "VariableDeclarator") {
    const id = Reflect.get(node, "id");
    const init = Reflect.get(node, "init");
    if (isNode(id) && isNode(init) && clientOrigin(init, boundClients)) {
      for (const binding of patternBindings(id)) boundClients.add(binding);
    }
  }
  visit(node, nestedScope, boundClients);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) visitNodes(item, visit, nestedScope, boundClients);
      }
    } else if (isNode(value)) {
      visitNodes(value, visit, nestedScope, boundClients);
    }
  }
}

export function findUnscopedIpcCalls(file: string, sourceOverride?: string): string[] {
  const text = sourceOverride ?? readSource(file);
  if (!IPC_CANDIDATE.test(text)) return [];
  const source = sourceOverride === undefined
    ? sourceFiles.get(file)
    : parseSync(file, text, { astType: "js" }).program;
  if (source === undefined) throw new Error(`Source AST was not loaded for ${workspacePath(file)}`);
  const relativePath = workspacePath(file);
  const sites = new Map<string, Array<{ line: number; scope: string }>>();
  const add = (helper: string, node: Node, scope: string): void => {
    const lines = sites.get(helper) ?? [];
    const line = text.slice(0, node.start).split("\n").length;
    lines.push({ line, scope });
    sites.set(helper, lines);
  };
  visitNodes(source, (node, scope, boundClients) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const minimum = IPC_HELPER_MIN_ARGUMENTS.get(node.callee.name);
      if (minimum !== undefined) {
        const client = node.arguments[minimum - 1];
        if (node.arguments.length < minimum
          || !isNode(client)
          || !clientOrigin(client, boundClients)) {
          add(node.callee.name, node, scope);
        }
      }
    }
    if (node.type === "MemberExpression"
      && !node.computed
      && node.object.type === "Identifier"
      && node.object.name === "window"
      && node.property.type === "Identifier"
      && node.property.name === "ipc") {
      add("window.ipc", node, scope);
    }
  });

  const failures: string[] = [];
  const allowances = AMBIENT_IPC_ALLOWLIST.filter((entry) => entry.file === relativePath);
  for (const allowance of allowances) {
    const helperSites = sites.get(allowance.helper) ?? [];
    const allowedSites = helperSites.filter((site) => site.scope === allowance.scope);
    if (allowedSites.length !== allowance.expectedCount) {
      failures.push(
        `${relativePath} ${allowance.helper} in ${allowance.scope}: expected `
        + `${allowance.expectedCount} ambient call(s), found ${allowedSites.length}; ${allowance.reason}`,
      );
    }
    sites.set(
      allowance.helper,
      helperSites.filter((site) => site.scope !== allowance.scope),
    );
  }
  for (const [helper, remaining] of sites) {
    for (const site of remaining) {
      failures.push(`${relativePath}:${site.line} ${helper} in ${site.scope}`);
    }
  }
  return failures;
}
