import { chromium } from "/opt/blitz/npm/lib/node_modules/playwright-core/index.mjs";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// Required lane parameters. Use command-line flags or the matching variables.
const PARAMETER_ENV = Object.freeze({
  origin: "QA_ORIGIN",
  workspace: "QA_WORKSPACE_ID",
  tokenFile: "QA_TOKEN_FILE",
  cdpPort: "QA_CDP_PORT",
  outDir: "QA_ARTIFACT_DIR",
  route: "QA_ROUTE",
  settleMs: "QA_SETTLE_MS",
});
const KNOWN_FLAGS = new Set([
  "origin",
  "workspace",
  "token-file",
  "cdp-port",
  "out-dir",
  "route",
  "settle-ms",
]);

const USAGE = `Usage:
  node qa/harness/driver.mjs \\
    --origin <control-plane-origin> \\
    --workspace <workspace-id> \\
    --token-file <session-token-file> \\
    [--cdp-port <port>] \\
    [--out-dir <directory>] \\
    [--route </chat>] \\
    [--settle-ms <milliseconds>]

Environment alternatives:
  QA_ORIGIN, QA_WORKSPACE_ID, QA_TOKEN_FILE, QA_CDP_PORT, QA_ARTIFACT_DIR,
  QA_ROUTE, QA_SETTLE_MS
`;

function parseArguments(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      parsed.set("help", "true");
      continue;
    }
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
    if (!KNOWN_FLAGS.has(flag.slice(2))) throw new Error(`Unknown flag: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    parsed.set(flag.slice(2), value);
    index += 1;
  }
  return parsed;
}

function parameter(argumentsMap, flag, environmentName, fallback) {
  return argumentsMap.get(flag) ?? process.env[environmentName] ?? fallback;
}

function required(value, name) {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing ${name}.\n\n${USAGE}`);
  }
  return value.trim();
}

function integerParameter(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

function safeRequestUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid request URL";
  }
}

function safeArtifactName(name) {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "state";
}

export async function clickDeepestByText(page, rootSelector, text, occurrence = 0) {
  const result = await page.evaluate(
    ([selector, expectedText, expectedOccurrence]) => {
      const root = document.querySelector(selector);
      if (root === null) return { error: `Root not found: ${selector}` };
      const candidates = [...root.querySelectorAll("button,[role=menuitem],[role=button],div,span")]
        .filter((element) => (element.innerText ?? "").trim().startsWith(expectedText)
          && element.getClientRects().length > 0);
      const deepest = candidates.filter((element) => !candidates.some(
        (other) => other !== element && element.contains(other),
      ));
      const target = deepest[expectedOccurrence];
      if (target === undefined) return { error: `Text not found: ${expectedText}` };
      target.scrollIntoView({ block: "center", inline: "center" });
      const bounds = target.getBoundingClientRect();
      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
        tag: target.tagName,
        label: target.getAttribute("aria-label"),
      };
    },
    [rootSelector, text, occurrence],
  );
  if ("error" in result) throw new Error(result.error);
  await page.mouse.click(result.x, result.y);
  return { tag: result.tag, label: result.label };
}

async function captureState(page, outputDirectory, name) {
  const artifactName = safeArtifactName(name);
  const screenshotPath = join(outputDirectory, `${artifactName}.png`);
  const domPath = join(outputDirectory, `${artifactName}.dom.json`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const state = await page.evaluate(() => ({
    path: `${location.pathname}${location.search}`,
    title: document.title,
    bodyText: (document.body?.innerText ?? "").slice(0, 20_000),
    dialogs: [...document.querySelectorAll("[role=dialog]")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => (element.innerText ?? "").slice(0, 2_000)),
    buttons: [...document.querySelectorAll("button")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({
        text: (element.innerText ?? "").trim().slice(0, 120),
        label: element.getAttribute("aria-label"),
        disabled: element.disabled,
      })),
    railText: (document.querySelector(".session-rail")?.innerText ?? "").slice(0, 5_000),
    surfacePresent: document.querySelector(".lody-surface") !== null,
    textareas: [...document.querySelectorAll("textarea")].map((element) => ({
      placeholder: element.placeholder,
      disabled: element.disabled,
      readOnly: element.readOnly,
      valueLength: element.value.length,
    })),
  }));
  writeFileSync(domPath, `${JSON.stringify(state, null, 2)}\n`);
  return { screenshotPath, domPath, state };
}

const argumentsMap = parseArguments(process.argv.slice(2));
if (argumentsMap.get("help") === "true") {
  process.stdout.write(USAGE);
  process.exit(0);
}

const originUrl = new URL(required(
  parameter(argumentsMap, "origin", PARAMETER_ENV.origin),
  "--origin or QA_ORIGIN",
));
const workspaceId = required(
  parameter(argumentsMap, "workspace", PARAMETER_ENV.workspace),
  "--workspace or QA_WORKSPACE_ID",
);
const tokenFile = resolve(required(
  parameter(argumentsMap, "token-file", PARAMETER_ENV.tokenFile),
  "--token-file or QA_TOKEN_FILE",
));
const cdpPort = integerParameter(
  parameter(argumentsMap, "cdp-port", PARAMETER_ENV.cdpPort, "9222"),
  "CDP port",
  1,
  65_535,
);
const outputDirectory = resolve(
  parameter(argumentsMap, "out-dir", PARAMETER_ENV.outDir, "qa-artifacts"),
);
const route = parameter(argumentsMap, "route", PARAMETER_ENV.route, "/chat");
const settleMilliseconds = integerParameter(
  parameter(argumentsMap, "settle-ms", PARAMETER_ENV.settleMs, "15000"),
  "settle time",
  0,
  300_000,
);
if (!route.startsWith("/")) throw new Error("--route must start with a slash.");

originUrl.pathname = "";
originUrl.search = "";
originUrl.hash = "";
mkdirSync(outputDirectory, { recursive: true });
const sessionToken = readFileSync(tokenFile, "utf8").split("\n")[0]?.trim() ?? "";
if (sessionToken === "") throw new Error("The session token file is empty.");

const browserLog = [];
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

try {
  await context.addCookies([{
    name: "blitz_session",
    value: sessionToken,
    domain: originUrl.hostname,
    path: "/",
    httpOnly: true,
    secure: originUrl.protocol === "https:",
    sameSite: "Lax",
  }]);
  const page = await context.newPage();
  page.on("console", (message) => {
    browserLog.push(`[${message.type()}] ${message.text()}`.slice(0, 500));
  });
  page.on("pageerror", (error) => {
    browserLog.push(`[pageerror] ${error.message}`.slice(0, 500));
  });
  page.on("requestfailed", (request) => {
    browserLog.push(
      `[requestfailed] ${request.method()} ${safeRequestUrl(request.url())} ${request.failure()?.errorText ?? ""}`
        .slice(0, 500),
    );
  });

  const targetUrl = new URL(
    `/workspaces/${encodeURIComponent(workspaceId)}${route}`,
    originUrl,
  );
  await page.goto(targetUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(settleMilliseconds);
  const evidence = await captureState(page, outputDirectory, "00-landing");
  process.stdout.write(`${JSON.stringify({
    path: evidence.state.path,
    screenshot: evidence.screenshotPath,
    dom: evidence.domPath,
  }, null, 2)}\n`);

  // Add row actions here. Use stable selectors or clickDeepestByText(), for
  // example: await clickDeepestByText(page, ".session-rail", "New session");
  // Capture another named state after every material action.
} finally {
  writeFileSync(
    join(outputDirectory, "browser.log.json"),
    `${JSON.stringify(browserLog.slice(-200), null, 2)}\n`,
  );
  await context.close();
  // For connectOverCDP(), this disconnects the client. The lane cleanup trap
  // owns the browser process and container.
  await browser.close();
}
