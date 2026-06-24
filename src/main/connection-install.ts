// DEPRECATED (kept for reference, no longer invoked at boot). The BlitzOS Connector Chrome extension is no longer
// shipped, and Chrome is now driven EXTENSION-FREE via Apple Events (connection-chrome-applescript-link.mjs). The
// boot auto-install plus the setInstaller/startConnectorServer wiring in index.ts were removed, so nothing calls
// these functions anymore. They stay here only so the old force-install path is documented if we ever need it again.
//
// Force-install of the BlitzOS Connector Chrome extension. The user chose a RUNTIME ADMIN PROMPT (no .pkg):
// BlitzOS writes the ExtensionInstallForcelist managed policy to /Library/Managed Preferences via an
// AuthorizationServices admin prompt (osascript `with administrator privileges`), and self-hosts the .crx +
// updates.xml on a fixed localhost port. Chrome then installs + keeps the extension; deleting the policy key
// uninstalls it. Dev: load-unpacked, skip all this.
import { app } from 'electron'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONNECTOR_EXTENSION_ID } from './connection-tab-link.mjs'

const CRX_PORT = 7679 // below the tab-link range (7682+) so they never collide
const MANAGED_PREFS_DIR = '/Library/Managed Preferences'
const CHROME_DOMAIN = `${MANAGED_PREFS_DIR}/com.google.Chrome`
const CHROME_POLICY = `${CHROME_DOMAIN}.plist`

function connectorDir(): string {
  const cands = [
    app.isPackaged ? join(process.resourcesPath, 'extension') : null,
    join(app.getAppPath(), 'extension'),
    join(process.cwd(), 'extension')
  ].filter((p): p is string => !!p)
  for (const c of cands) if (existsSync(join(c, 'manifest.json'))) return c
  return cands[cands.length - 1]
}
// Chrome's --pack-extension writes `<dir>.crx` next to the source dir (repo root / resources).
function crxPath(): string {
  return join(connectorDir(), '..', 'extension.crx')
}

const updatesXml = (): string =>
  `<?xml version='1.0' encoding='UTF-8'?>\n` +
  `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
  `  <app appid='${CONNECTOR_EXTENSION_ID}'>\n` +
  `    <updatecheck codebase='http://127.0.0.1:${CRX_PORT}/connector.crx' version='0.1.0' />\n` +
  `  </app>\n</gupdate>\n`

let server: Server | null = null
export function startConnectorServer(): void {
  if (server || process.platform !== 'darwin') return
  server = createServer((req, res) => {
    if (req.url === '/updates.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(updatesXml())
      return
    }
    if (req.url === '/connector.crx') {
      const p = crxPath()
      if (!existsSync(p)) {
        res.writeHead(404)
        res.end('connector .crx not built — run: node scripts/build-extension.mjs')
        return
      }
      res.writeHead(200, { 'content-type': 'application/x-chrome-extension' })
      res.end(readFileSync(p))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  server.on('error', (e) => console.warn('[blitzos] connector crx server error:', (e as Error).message))
  server.listen(CRX_PORT, '127.0.0.1')
}

// Run a shell command as root via the native admin prompt (one prompt for the whole command).
function adminRun(shell: string): Promise<{ ok: boolean; error?: string }> {
  const esc = shell.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', `do shell script "${esc}" with administrator privileges`], { timeout: 120_000 }, (err, _o, stderr) => {
      if (err) {
        const msg = String(stderr || (err as Error).message).trim()
        // -128 = the user cancelled the admin prompt
        resolve({ ok: false, error: /-128|User canceled/i.test(msg) ? 'admin prompt cancelled' : msg })
      } else resolve({ ok: true })
    })
  })
}

/** Write the ExtensionInstallForcelist policy (admin prompt) so Chrome force-installs the connector from the
 *  self-hosted localhost .crx. Idempotent. */
export async function installConnector(): Promise<{ ok: boolean; error?: string; note?: string; extensionDir?: string; manual?: boolean }> {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS only' }
  if (!existsSync(crxPath())) return { ok: false, error: 'the connector .crx is not built — run: node scripts/build-extension.mjs (needs Google Chrome to pack it)', extensionDir: connectorDir() }
  // Force-install is a MANAGED policy under /Library/Managed Preferences. That directory only exists on an
  // MDM-managed Mac, and without a managed-preferences provider Chrome IGNORES a hand-written policy file there.
  // So on an unmanaged Mac, skip the useless admin prompt and hand back the reliable manual path (load-unpacked).
  if (!existsSync(MANAGED_PREFS_DIR)) {
    return {
      ok: false,
      manual: true,
      error: 'This Mac is not MDM-managed, so Chrome ignores force-install policies. To connect Chrome: open chrome://extensions, turn on Developer mode (top-right), click "Load unpacked", and select the folder below.',
      extensionDir: connectorDir()
    }
  }
  startConnectorServer()
  const value = `${CONNECTOR_EXTENSION_ID};http://127.0.0.1:${CRX_PORT}/updates.xml`
  const cmd = [
    `/bin/mkdir -p '${MANAGED_PREFS_DIR}'`,
    `/usr/bin/defaults write '${CHROME_DOMAIN}' ExtensionInstallForcelist -array '${value}'`,
    `/usr/sbin/chown root:wheel '${CHROME_POLICY}'`,
    `/bin/chmod 644 '${CHROME_POLICY}'`
  ].join(' && ')
  const r = await adminRun(cmd)
  // Always hand back the extension dir so the UI can offer the manual load-unpacked path if the policy install
  // doesn't actually result in a connection (some Chrome setups don't honor a self-hosted force-install).
  return r.ok
    ? { ok: true, extensionDir: connectorDir(), note: 'Chrome will install the BlitzOS Connector within ~10s (relaunch Chrome if needed). It shows "Managed by your organization" while connected — expected.' }
    : { ...r, extensionDir: connectorDir() }
}

export function isConnectorPolicyInstalled(): boolean {
  try {
    return existsSync(CHROME_POLICY) && readFileSync(CHROME_POLICY).includes(CONNECTOR_EXTENSION_ID)
  } catch {
    return false
  }
}
