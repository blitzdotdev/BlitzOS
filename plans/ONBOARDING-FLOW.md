# BlitzOS Onboarding — run it

This scans the human's **local macOS footprint** (AI sessions, browsers, shell, git, editors, apps — and with Full Disk Access also Messages/Mail/Notes/Safari/app-usage), distills it into **one markdown doc**, and uses it to run a short, sharp onboarding interview so the agent learns the human fast instead of asking obvious questions.

Two pieces: `scripts/onboarding-scan.mjs` (the scan) and `src/main/blitzos-onboarding.md` (the interview prompt). One command combines them.

---

## ▶ If you are an AI agent: start here

You're about to onboard your human. Do exactly this:

1. **Check you can:** you're on **macOS**, in the **`agent-os` repo**, with **Node 18+**. (Not macOS → see Limitations; otherwise continue.)
2. **Run one command** (it prints ONE document to stdout — the interview prompt followed by a `=== SCANNED CONTEXT ===` block):
   - `npm run onboard` — **Branch B**, works with zero setup.
   - `npm run onboard:fda` — **Branch A+B**, richer; only adds data if Full Disk Access is granted (else it silently falls back to B and prints a one-line reminder — never errors).
3. **Read that output and do what it says.** It makes you the interviewer. The rules it gives you (summarized so you know what to expect):
   - Ask **at most 4 questions**, only genuine gaps; **skip anything the scan already answers**.
   - **Voice is the biggest gap and is NOT multiple-choice** — ask the human to *write one real sample* of the register the scan is thin on (usually their public-facing copy). One sample beats any quiz.
   - Derive the human's own rules/do-nots **from the scan**, don't assume them; confirm scope where useful.
   - Finish with a short "What I learned" summary and invite corrections.

That's the whole flow. Everything below is setup, privacy, and how to extend.

---

## Modes & Full Disk Access

| Command | Branch | Needs | Adds |
|---|---|---|---|
| `npm run onboard` | B | nothing | AI sessions, browsers, shell, git, editors, installed apps/dock, downloads, locale |
| `npm run onboard:fda` | A+B | Full Disk Access | + Messages/Mail (summary-only), Notes titles, Safari history, knowledgeC app-usage time, configured accounts |
| `npm run onboard:scan` | (B or A) | — | the scanned context only, no interview prompt (for inspection) |

**Grant Full Disk Access (for Branch A):** System Settings → **Privacy & Security → Full Disk Access** → add/enable your **terminal app** (Terminal, iTerm, Ghostty, …). It usually takes effect on the next command; if Branch-A sources still come back empty, fully quit & reopen the terminal once. Branch A without FDA just degrades to B — no error, no harm.

Direct form (no npm): `node scripts/onboarding-scan.mjs [--no-fda|--assume-fda] --prompt src/main/blitzos-onboarding.md --out -` · `node scripts/onboarding-scan.mjs --help` for all flags.

---

## Privacy (read before sharing output)

- **Local-only** (a startup self-check aborts if any network primitive is in the file) and **read-only** (every SQLite DB is copied to a temp dir and opened `immutable=1` — originals are never touched).
- **Secrets excluded** (credential stores/keys never opened), **contacts hashed** (`[contact-…]`), **comms summary-only** by default (no verbatim message/mail text unless you pass `--comms-content`).
- The output is the human's **private profile** — keep it on their machine. This repo gitignores `onboarding-context*`, `onboarding-session*`, and `mirror-*` so it can't be committed by accident. If you write it somewhere else, don't commit it.

---

## Add a source (scrape more)

Sources live in a registry in `scripts/onboarding-scan.mjs`. To add one:

1. Write a reader that pushes into the shared `ctx` buckets, using the existing helpers (`sqliteQuery(dbPath, sql)` copy-immutable, `plistJson(path)`, `sh(bin, args)`, `toUnixMs(raw)`, `redact(text)`):
   ```js
   function srcThing(ctx) {
     // ctx.text.push({ source:'thing', ts, text })        → voice / directives / entity mining
     // pushEvent(ctx, 'thing', ts, 'kind', key, {durSec})  → cadence / frequency
     // ctx.facts.* / ctx.tooling.set(k,n) / ctx.collab     → tooling / people aggregates
   }
   ```
2. Register it: add `{ id: 'thing', tier: 'none' | 'fda', run: srcThing }` to the `SOURCES` array (`tier:'fda'` = only runs when Full Disk Access is granted).

If it feeds an existing bucket it appears in the output automatically (no other edits). A brand-new *output section* also needs a line in `render()`. Keep it read-only and exclude secrets (extend `SECRET_RE` if your source touches credential-adjacent files).

---

## Limitations

- **macOS only** today (uses `sqlite3`/`plutil`/`mdfind`/`mdls`/`defaults` and `~/Library` paths). On Linux/Windows it won't produce useful output — a cross-platform port is a separate effort.
- Needs **Node 18+** and the **repo** (the `.mjs` + the prompt `.md`). Zero npm install required — it shells out to built-in macOS tools.
