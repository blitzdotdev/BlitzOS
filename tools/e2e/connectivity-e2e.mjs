// Live e2e: cloud-VM workspace with zero local forwards.
// Proves: create -> tunnel+DNS provisioned -> terminal WS echo,
// files listing, preview fetch, leases API -> destroy -> tunnel+DNS removed.
// Auth: operator key -> session cookie only (exactly what the browser does).
import WebSocket from "ws";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envPath = join(repoRoot, ".env");

function readEnvValue(name) {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

const CP = (process.env.CP_URL ?? readEnvValue("CP_URL") ?? "").replace(/\/+$/u, "");
const LOG = new URL("connectivity-e2e.log", import.meta.url).pathname;
const OPERATOR_KEY = process.env.OPERATOR_API_KEY ?? readEnvValue("OPERATOR_API_KEY") ?? "";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? readEnvValue("CLOUDFLARE_API_TOKEN") ?? "";
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID ?? readEnvValue("CLOUDFLARE_ZONE_ID") ?? "";
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? readEnvValue("CLOUDFLARE_ACCOUNT_ID") ?? "";

// CP_URL joins the hard-required set rather than defaulting: this suite
// creates and destroys workspaces, and a forgotten value must not silently
// aim that at whichever deployment the default names.
const missing = [
  ["CP_URL", CP],
  ["OPERATOR_API_KEY", OPERATOR_KEY],
  ["CLOUDFLARE_API_TOKEN", CF_TOKEN],
  ["CLOUDFLARE_ZONE_ID", ZONE_ID],
  ["CLOUDFLARE_ACCOUNT_ID", ACCOUNT_ID],
].filter(([, value]) => value === "").map(([name]) => name);
if (missing.length > 0) {
  console.error(`Missing required configuration: ${missing.join(", ")}`);
  console.error(
    "Usage: CP_URL=<worker origin> OPERATOR_API_KEY=... CLOUDFLARE_API_TOKEN=... " +
      "CLOUDFLARE_ZONE_ID=<dns zone id> CLOUDFLARE_ACCOUNT_ID=<tunnel account id> node tools/e2e/connectivity-e2e.mjs",
  );
  console.error(`Each value may also be set in ${envPath}.`);
  process.exit(1);
}

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};
const fail = (m) => { log("FAIL:", m); process.exit(1); };

let cookie = "";
const api = async (path, init = {}) => {
  const res = await fetch(`${CP}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: cookie },
  });
  return res;
};

// 1. login -> cookie (browser flow)
{
  const res = await fetch(`${CP}/sessions`, {
    method: "POST",
    headers: { "x-operator-key": OPERATOR_KEY },
  });
  if (res.status < 200 || res.status >= 300) fail(`login ${res.status}`);
  const setCookie = res.headers.get("set-cookie") || "";
  cookie = (setCookie.match(/blitz_session=[^;]+/) || [])[0] || "";
  if (!cookie) fail("no session cookie");
  log("STEP1 login ok");
}

// 2. pick a cloud (non-mv) machine type
let machineTypeId;
{
  const res = await api("/machine-types");
  if (res.status !== 200) fail(`machine-types ${res.status}`);
  const body = await res.json();
  const types = Array.isArray(body) ? body : body.machineTypes;
  const cloud = types.find((t) => !t.id.startsWith("mv-"));
  if (!cloud) fail("no cloud machine type");
  machineTypeId = cloud.id;
  log("STEP2 machine type:", machineTypeId);
}

// 3. create workspace (no ssh key, no volume -> pure browser default)
let id = process.env.REUSE_ID || "";
if (!id) {
  const res = await api("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineTypeId }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status >= 300) fail(`create ${res.status} ${JSON.stringify(body)}`);
  id = body.workspace?.id ?? body.id;
  if (!id) fail(`create returned no id: ${JSON.stringify(body).slice(0, 200)}`);
  log("STEP3 created:", id);
}

// 4. verify tunnel + DNS exist on Cloudflare (by name conventions)
const cf = async (path) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  });
  return res.json();
};
const findDns = async () => {
  const d = await cf(`/zones/${ZONE_ID}/dns_records?per_page=100`);
  return (d.result || []).filter((r) => r.name.includes(id.toLowerCase().slice(0, 8)) || r.name.startsWith("ws-"));
};

// 5. poll until ready (create returns before VM boots)
{
  const deadline = Date.now() + 8 * 60 * 1000;
  for (;;) {
    const res = await api("/workspaces");
    const listBody = await res.json();
    const list = Array.isArray(listBody) ? listBody : listBody.workspaces;
    const ws = list.find((w) => w.id === id);
    if (!ws) fail("workspace vanished while polling");
    log("  poll:", ws.phase ?? ws.status ?? JSON.stringify(ws).slice(0, 80));
    if ((ws.phase ?? ws.status) === "ready") break;
    if ((ws.phase ?? ws.status) === "error") fail(`workspace error: ${JSON.stringify(ws)}`);
    if (Date.now() > deadline) fail("timeout waiting for ready");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  log("STEP5 ready");
}

const dnsBefore = await findDns();
log("STEP4/6 dns records matching workspace:", JSON.stringify(dnsBefore.map((r) => r.name)));

// 7. terminal through CP webapp proxy: run a real command, capture output.
// The tunnel registers seconds after ready; retry like the webapp's
// auto-reconnect does instead of failing on the first 530.
const terminalOnce = () => new Promise((resolve, reject) => {
  const url = `${CP.replace("https://", "wss://")}/workspaces/${id}/webapp/7445/terminal/ws?arg=terminal&arg=e2e1`;
  const chunks = [];
  const w = new WebSocket(url, ["tty"], { headers: { Cookie: cookie, Origin: CP } });
  const timer = setTimeout(() => { w.close(); resolve(Buffer.concat(chunks).toString("utf8")); }, 20_000);
  w.on("unexpected-response", (_q, r) => { clearTimeout(timer); reject(new Error(`terminal HTTP ${r.statusCode}`)); });
  w.on("error", (e) => { clearTimeout(timer); reject(e); });
  w.on("open", () => {
    w.send(JSON.stringify({ AuthToken: "", columns: 120, rows: 30 }));
    setTimeout(() => w.send("0" + "echo blitz-$((21+21))-proof\r"), 3000);
  });
  w.on("message", (d) => { const b = Buffer.from(d); if (b[0] === 48) chunks.push(b.slice(1)); });
});
{
  const deadline = Date.now() + 90_000;
  let out = "";
  for (;;) {
    try {
      out = await terminalOnce();
      break;
    } catch (e) {
      if (Date.now() > deadline) fail(`terminal never connected: ${e.message}`);
      log("  terminal retry after:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!out.includes("blitz-42-proof")) fail(`terminal echo missing; got ${out.length} bytes: ${JSON.stringify(out.slice(-300))}`);
  log("STEP7 terminal echo ok (blitz-42-proof seen)");
}

// 9. files through CP webapp proxy (dufs JSON listing)
{
  const res = await api(`/workspaces/${id}/webapp/7445/?json`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (res.status !== 200) fail(`files ${res.status}: ${text.slice(0, 200)}`);
  log("STEP9 files listing ok:", text.slice(0, 100).replace(/\n/g, " "));
}

// 10. preview: start a server in the terminal, then fetch through /preview
{
  const url = `${CP.replace("https://", "wss://")}/workspaces/${id}/webapp/7445/terminal/ws?arg=terminal&arg=e2e1`;
  await new Promise((resolve, reject) => {
    const w = new WebSocket(url, ["tty"], { headers: { Cookie: cookie, Origin: CP } });
    const timer = setTimeout(() => { w.close(); resolve(); }, 8000);
    w.on("error", (e) => { clearTimeout(timer); reject(e); });
    w.on("open", () => {
      w.send(JSON.stringify({ AuthToken: "", columns: 120, rows: 30 }));
      setTimeout(() => { w.send("0" + "nohup node -e 'require(\"http\").createServer((q,s)=>s.end(\"tunnel-preview-proof\")).listen(4321)' >/dev/null 2>&1 &\r"); }, 2500);
    });
  });
  await new Promise((r) => setTimeout(r, 4000));
  const res = await api(`/workspaces/${id}/webapp/7445/preview/4321/`);
  const text = await res.text();
  if (res.status !== 200 || !text.includes("tunnel-preview-proof")) fail(`preview ${res.status}: ${text.slice(0, 200)}`);
  log("STEP10 preview ok through tunnel");
}

// 11. leases panel API (drawer)
{
  const res = await api(`/workspaces/${id}/leases`);
  if (res.status !== 200) fail(`leases ${res.status}`);
  log("STEP11 leases ok:", (await res.text()).slice(0, 80));
}

// 12. destroy and verify cleanup
{
  const res = await api(`/workspaces/${id}`, { method: "DELETE" });
  if (res.status >= 300) fail(`destroy ${res.status}`);
  log("STEP12 destroy accepted");
  await new Promise((r) => setTimeout(r, 20_000));
  const dnsAfter = await findDns();
  const stillThere = dnsAfter.filter((r) => dnsBefore.some((b) => b.id === r.id));
  if (stillThere.length > 0) fail(`dns records not cleaned: ${JSON.stringify(stillThere.map((r) => r.name))}`);
  const t = await cf(`/accounts/${ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=100`);
  const orphan = (t.result || []).filter((x) => x.name.includes(id.toLowerCase().slice(0, 8)));
  if (orphan.length > 0) fail(`tunnel not cleaned: ${JSON.stringify(orphan.map((x) => x.name))}`);
  log("STEP12 cleanup verified: dns + tunnel gone");
}

log("E2E PASS: all steps green");
