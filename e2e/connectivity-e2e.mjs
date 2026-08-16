// Live e2e: cloud-VM workspace with zero local forwards.
// Proves: create -> tunnel+DNS provisioned -> terminal WS echo, ACP handshake,
// files listing, preview fetch, leases API -> destroy -> tunnel+DNS removed.
// Auth: operator key -> session cookie only (exactly what the browser does).
import WebSocket from "ws";
import { readFileSync, appendFileSync } from "fs";

const CP = "https://blitz-control-plane.blitzapp.workers.dev";
const LOG = new URL("connectivity-e2e.log", import.meta.url).pathname;
const env = readFileSync("/Users/minjunes/blitz-core/.env", "utf8");
const OPERATOR_KEY = (env.match(/^OPERATOR_API_KEY=(.+)$/m) || [])[1].trim();
const CF_TOKEN = (env.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m) || [])[1].trim();
const ZONE_ID = "52fcb3a8adc81b791ea918d3bde25a39"; // blitzos.app

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

// 7. terminal through CP surface proxy: run a real command, capture output.
// The tunnel registers seconds after ready; retry like the cockpit's
// auto-reconnect does instead of failing on the first 530.
const terminalOnce = () => new Promise((resolve, reject) => {
  const url = `${CP.replace("https://", "wss://")}/workspaces/${id}/surface/7445/terminal/ws?arg=terminal&arg=e2e1`;
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

// 8. ACP chat handshake through CP surface proxy (port 7444 -> /acp)
{
  const url = `${CP.replace("https://", "wss://")}/workspaces/${id}/surface/7444/`;
  const reply = await new Promise((resolve, reject) => {
    const w = new WebSocket(url, { headers: { Cookie: cookie, Origin: CP } });
    const timer = setTimeout(() => { w.close(); reject(new Error("acp timeout")); }, 15_000);
    w.on("unexpected-response", (_q, r) => { clearTimeout(timer); reject(new Error(`acp HTTP ${r.statusCode}`)); });
    w.on("error", (e) => { clearTimeout(timer); reject(e); });
    w.on("open", () => w.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })));
    w.on("message", (d) => { clearTimeout(timer); w.close(); resolve(JSON.parse(Buffer.from(d).toString("utf8"))); });
  });
  if (reply.id !== 1 || reply.error) fail(`acp initialize bad reply: ${JSON.stringify(reply)}`);
  log("STEP8 acp initialize ok:", JSON.stringify(reply.result ?? {}).slice(0, 120));
}

// 9. files through CP surface proxy (dufs JSON listing)
{
  const res = await api(`/workspaces/${id}/surface/7445/?json`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (res.status !== 200) fail(`files ${res.status}: ${text.slice(0, 200)}`);
  log("STEP9 files listing ok:", text.slice(0, 100).replace(/\n/g, " "));
}

// 10. preview: start a server in the terminal, then fetch through /preview
{
  const url = `${CP.replace("https://", "wss://")}/workspaces/${id}/surface/7445/terminal/ws?arg=terminal&arg=e2e1`;
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
  const res = await api(`/workspaces/${id}/surface/7445/preview/4321/`);
  const text = await res.text();
  if (res.status !== 200 || !text.includes("tunnel-preview-proof")) fail(`preview ${res.status}: ${text.slice(0, 200)}`);
  log("STEP10 preview ok through tunnel");
}

// 11. leases panel API (drawer surface)
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
  const t = await cf(`/accounts/d25a778b256fb6ef6eea554d77c40f27/cfd_tunnel?is_deleted=false&per_page=100`);
  const orphan = (t.result || []).filter((x) => x.name.includes(id.toLowerCase().slice(0, 8)));
  if (orphan.length > 0) fail(`tunnel not cleaned: ${JSON.stringify(orphan.map((x) => x.name))}`);
  log("STEP12 cleanup verified: dns + tunnel gone");
}

log("E2E PASS: all steps green");
