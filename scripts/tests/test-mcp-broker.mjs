// HEADLESS test for src/main/mcp-broker.mjs — no human OAuth. Hits LIVE endpoints, so this is a real
// integration check of the broker (OAuth/DCR plumbing + the streamable-HTTP MCP client):
//   1. Fetch Notion's AS metadata (RFC 8414 well-known).
//   2. dcrRegister against Notion returns a client_id (no pre-registration, no user interaction).
//   3. mcpInitialize against a public unauthenticated MCP server returns a protocol result.
//   4. buildAuthorizeUrl on the real Notion AS yields a URL containing code_challenge, state, and resource.
//   5. mcpListTools against the same public server returns tools (proves session capture+echo + SSE parsing).
// Plus a pure-local PKCE/state self-check that needs no network (so a failure isolates broker-logic vs network).
//
// Why a public server (DeepWiki/GitMCP) for the MCP-client checks instead of Notion's /mcp: as of 2026-06-22
// Notion's /mcp HARD-requires a Bearer token even for `initialize` (returns HTTP 401 + WWW-Authenticate), so
// it can no longer prove the client transport headlessly. DeepWiki answers `initialize` over SSE with no auth;
// GitMCP additionally returns an mcp-session-id header — between them they exercise SSE-data parsing AND the
// session capture+echo path. Notion stays the canonical DCR target for checks 1/2/4 (the contract names it).
//
// Prints PASS/FAIL per check; exits non-zero on ANY fail. Never hardcodes a secret. Network-dependent: if an
// endpoint is unreachable the check FAILs loudly (it is never silently skipped) — run with connectivity.

import { dcrRegister, buildAuthorizeUrl, mcpInitialize, mcpListTools, supportsS256 } from '../../src/main/mcp-broker.mjs'

const NOTION_AS_METADATA = 'https://mcp.notion.com/.well-known/oauth-authorization-server'
const NOTION_MCP = 'https://mcp.notion.com/mcp'
// Public MCP servers that answer `initialize` unauthenticated. PUBLIC_MCP carries no session header (pure SSE
// data parse); SESSION_MCP returns an mcp-session-id header (capture + echo on tools/list).
const PUBLIC_MCP = 'https://mcp.deepwiki.com/mcp'
const SESSION_MCP = 'https://gitmcp.io/docs'
const REDIRECT = 'http://127.0.0.1:0/'

let failed = 0
function pass(name, extra) {
  console.log(`PASS  ${name}${extra ? '  — ' + extra : ''}`)
}
function fail(name, err) {
  failed++
  console.log(`FAIL  ${name}  — ${err?.message || err}`)
}

async function main() {
  // ---- Check 0 (local, no network): PKCE S256 + state + resource land in the URL deterministically. -------
  try {
    const asMeta = { authorization_endpoint: 'https://example.com/auth' }
    const { url, verifier, state } = buildAuthorizeUrl({
      asMeta,
      clientId: 'test-client',
      scopes: ['read', 'write'],
      redirectUri: REDIRECT,
      resource: NOTION_MCP
    })
    const u = new URL(url)
    const cc = u.searchParams.get('code_challenge')
    const ccm = u.searchParams.get('code_challenge_method')
    const st = u.searchParams.get('state')
    const rs = u.searchParams.get('resource')
    if (!cc) throw new Error('missing code_challenge')
    if (ccm !== 'S256') throw new Error(`code_challenge_method != S256 (got ${ccm})`)
    if (st !== state) throw new Error('state in URL does not match returned state')
    if (rs !== NOTION_MCP) throw new Error('resource not in URL')
    if (!verifier || verifier.length < 43) throw new Error('verifier too short for PKCE')
    // The challenge must NOT equal the verifier (that would be the insecure 'plain' method).
    if (cc === verifier) throw new Error('code_challenge equals verifier (plain, not S256)')
    pass('0 buildAuthorizeUrl local PKCE/state/resource', `verifier=${verifier.length}ch, state=${state.length}ch`)
  } catch (e) {
    fail('0 buildAuthorizeUrl local PKCE/state/resource', e)
  }

  // ---- Check 1: fetch Notion AS metadata. ----------------------------------------------------------------
  let asMeta = null
  try {
    const res = await fetch(NOTION_AS_METADATA, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    asMeta = await res.json()
    if (!asMeta.authorization_endpoint || !asMeta.token_endpoint) {
      throw new Error('metadata missing authorization_endpoint/token_endpoint')
    }
    pass('1 fetch Notion AS metadata', `issuer=${asMeta.issuer || '?'}, dcr=${asMeta.registration_endpoint ? 'yes' : 'no'}, S256=${supportsS256(asMeta)}`)
  } catch (e) {
    fail('1 fetch Notion AS metadata', e)
  }

  // ---- Check 2: DCR against Notion returns a client_id. --------------------------------------------------
  try {
    if (!asMeta) throw new Error('no AS metadata from check 1')
    if (!asMeta.registration_endpoint) throw new Error('AS is not DCR-capable (no registration_endpoint)')
    const reg = await dcrRegister(asMeta, {
      clientName: 'BlitzOS test (' + new Date().toISOString().slice(0, 10) + ')',
      redirectUri: REDIRECT,
      scopes: asMeta.scopes_supported
    })
    if (!reg.client_id) throw new Error('no client_id returned')
    pass('2 dcrRegister returns client_id', `client_id=${reg.client_id.slice(0, 12)}…, secret=${reg.client_secret ? 'yes' : 'no'}`)
  } catch (e) {
    fail('2 dcrRegister returns client_id', e)
  }

  // ---- Check 3: mcpInitialize against a public unauthenticated MCP server returns a protocol result. ------
  try {
    const { session, result } = await mcpInitialize(PUBLIC_MCP)
    if (!result) throw new Error('no initialize result')
    if (!result.protocolVersion && !result.serverInfo && !result.capabilities) {
      throw new Error('result missing protocolVersion/serverInfo/capabilities')
    }
    const name = result.serverInfo?.name || '?'
    pass('3 mcpInitialize returns protocol result', `protocol=${result.protocolVersion || '?'}, server=${name}, session=${session ? 'yes' : 'none'}`)
  } catch (e) {
    fail('3 mcpInitialize returns protocol result', e)
  }

  // ---- Check 4: buildAuthorizeUrl on the REAL Notion AS contains code_challenge + state + resource. ------
  try {
    if (!asMeta) throw new Error('no AS metadata from check 1')
    const { url, verifier, state } = buildAuthorizeUrl({
      asMeta,
      clientId: 'test-client-id',
      scopes: asMeta.scopes_supported,
      redirectUri: REDIRECT,
      resource: NOTION_MCP
    })
    const u = new URL(url)
    if (u.origin + u.pathname !== asMeta.authorization_endpoint) throw new Error('URL is not the AS authorization_endpoint')
    if (!u.searchParams.get('code_challenge')) throw new Error('missing code_challenge')
    if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('missing/incorrect code_challenge_method')
    if (u.searchParams.get('state') !== state) throw new Error('missing/mismatched state')
    if (u.searchParams.get('resource') !== NOTION_MCP) throw new Error('missing resource')
    if (!verifier) throw new Error('no verifier returned')
    pass('4 buildAuthorizeUrl on real Notion AS', `endpoint=${asMeta.authorization_endpoint}`)
  } catch (e) {
    fail('4 buildAuthorizeUrl on real Notion AS', e)
  }

  // ---- Check 5: initialize→tools/list against the session-bearing server (capture mcp-session-id, echo it,
  // parse the SSE tool list). Proves the full client round-trip, not just initialize. -----------------------
  try {
    const { session, result } = await mcpInitialize(SESSION_MCP)
    if (!result) throw new Error('initialize returned no result')
    if (!session) throw new Error('server did not return an mcp-session-id to capture')
    const tools = await mcpListTools(SESSION_MCP, undefined, session)
    if (!Array.isArray(tools) || tools.length === 0) throw new Error('tools/list returned no tools')
    if (!tools[0].name) throw new Error('first tool has no name field')
    pass('5 mcpInitialize+mcpListTools (session capture/echo)', `server=${result.serverInfo?.name || '?'}, tools=${tools.length} (${tools.slice(0, 3).map((t) => t.name).join(', ')})`)
  } catch (e) {
    fail('5 mcpInitialize+mcpListTools (session capture/echo)', e)
  }

  console.log('')
  if (failed > 0) {
    console.log(`RESULT: ${failed} FAIL`)
    process.exit(1)
  }
  console.log('RESULT: ALL PASS')
  process.exit(0)
}

main().catch((e) => {
  console.log(`FAIL  harness crashed  — ${e?.stack || e}`)
  process.exit(1)
})
