// Pure-DOM fallback UI used when the React tree cannot mount or has crashed
// during boot. Lives outside the React tree so it works even when no
// component or hook has had a chance to run.
//
// Design decisions:
// - No React: render via createElement/appendChild + addEventListener so the
//   page renders even if the React bundle never executes.
// - No external CSS: inline styles avoid relying on tailwind being loaded.
// - Inline styles only (no inline scripts) keep us compatible with the
//   renderer CSP, which allows `style-src 'self' 'unsafe-inline'` but
//   blocks `script-src 'unsafe-inline'`.
// - Two affordances by design: a "Copy" button (so users can share the
//   raw error with us) and a "Reload" button (so users can recover
//   in-page instead of force-quitting).

export type BootDiagnostics = {
  message: string;
  hint: string;
  details: string;
  copyableText: string;
};

// Normalized, low-cardinality classification of why boot failed (spec §7.4).
// Used as the `failure_kind` property on the pre-React `app/boot_failed` beacon.
export type BootFailureKind =
  | 'stale_asset'
  | 'legacy_browser'
  | 'offline'
  | 'module_load'
  | 'unknown';

export type BootFailureOptions = {
  /** Free-form hint shown between the error message and the diagnostics block. */
  hint?: string;
  /**
   * Extra key/value pairs appended to the diagnostics block. Useful for build
   * commit, app version, runtime (electron/web), etc.
   */
  buildInfo?: Record<string, string>;
  /**
   * Normalized boot-failure classification for the `app/boot_failed` beacon.
   * Per-shell callers already compute the specific kind (stale asset / legacy
   * browser / offline); pass it here. When omitted we classify from the error.
   */
  failureKind?: BootFailureKind;
  /**
   * Platform tag for the beacon (web/electron/mobile). Defaults to 'web'.
   */
  platform?: string;
  /**
   * Override the Reload button behavior. Defaults to `window.location.reload()`.
   * Return a Promise to keep the button disabled while the reload is in flight.
   */
  onReload?: () => void | Promise<void>;
  /**
   * Optional hook that runs once the user clicks "Copy". Receives the full
   * copyable text. Use this to forward to telemetry/logging.
   */
  onCopy?: (text: string) => void;
};

function getMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name ? `${error.name}: ${error.message}` : error.message;
  }
  if (typeof error === 'string') return error;
  if (error == null) return 'Unknown error';
  if (typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const BOOT_BEACON_INSTALL_ID_KEY = 'lody_install_id';

// Classify a boot failure into a stable, low-cardinality kind for analytics.
// Message-pattern based because at boot time we only have the raw throw — but we
// never SEND the message, only the resulting enum (spec §2.3/§7.4).
export function classifyBootFailureKind(error: unknown): BootFailureKind {
  const message = (
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  ).toLowerCase();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline';
  }
  if (
    message.includes('mime type') ||
    message.includes('is not a valid javascript') ||
    message.includes('stale')
  ) {
    return 'stale_asset';
  }
  if (
    message.includes('invalid group specifier') ||
    message.includes('invalid regular expression') ||
    message.includes('invalid escape') ||
    (error instanceof SyntaxError && message.includes('unexpected token'))
  ) {
    return 'legacy_browser';
  }
  if (
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('error loading') ||
    message.includes('chunkloaderror') ||
    message.includes('failed to fetch')
  ) {
    return 'module_load';
  }
  return 'unknown';
}

function resolveBootBeaconInstallId(): string {
  if (typeof window === 'undefined') return 'anonymous';
  try {
    const existing = window.localStorage.getItem(BOOT_BEACON_INSTALL_ID_KEY);
    if (existing) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(BOOT_BEACON_INSTALL_ID_KEY, generated);
    return generated;
  } catch {
    return 'anonymous';
  }
}

function getBootBeaconConfig(): { key: string; host: string } | null {
  // import.meta.env is statically replaced by Vite at build time in every shell
  // that bundles this module, so reading it here works pre-React.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const key = env.VITE_PUBLIC_POSTHOG_KEY;
  const host = env.VITE_PUBLIC_POSTHOG_HOST;
  if (!key || !host) return null;
  return { key, host: host.replace(/\/$/, '') };
}

// Low-level pre-React capture poster. The PostHog SDK is NOT mounted when boot
// fails, so we POST the capture payload directly via sendBeacon (survives the
// imminent reload/navigation) with a fetch keepalive fallback. Fire-and-forget;
// any failure is swallowed so it can never compound the boot failure (spec §7.4).
function postBootBeaconEvent(eventName: string, properties: Record<string, unknown>): void {
  try {
    const config = getBootBeaconConfig();
    if (!config) return;

    const payload = {
      api_key: config.key,
      event: eventName,
      distinct_id: resolveBootBeaconInstallId(),
      properties: {
        // $process_person_profile=false: these anonymous pre-auth beacons must
        // not create or mutate a person profile before the user is identified.
        $process_person_profile: false,
        client_ts_ms: Date.now(),
        ...properties,
      },
    };

    // PostHog's single-event capture endpoint (same one posthog-node/CLI use).
    const url = `${config.host}/capture/`;
    const body = JSON.stringify(payload);

    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      typeof Blob !== 'undefined'
    ) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) {
        return;
      }
    }

    if (typeof fetch === 'function') {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        mode: 'cors',
      }).catch(() => {
        // Swallow: a failed analytics beacon must not surface during boot.
      });
    }
  } catch {
    // Never let a boot beacon throw on top of an already-failed boot.
  }
}

// Pre-React `app/boot_failed` beacon (spec §7.4, tier A — full, never sampled).
export function captureBootFailedBeacon(error: unknown, options: BootFailureOptions = {}): void {
  const failureKind = options.failureKind ?? classifyBootFailureKind(error);
  postBootBeaconEvent('app/boot_failed', {
    failure_kind: failureKind,
    platform: options.platform ?? 'web',
    error_type: error instanceof Error ? error.name : typeof error,
    is_online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    // install_id doubles as the distinct id; surface it as a prop too so it
    // joins with `app/launch.install_id` for the same install.
    install_id: resolveBootBeaconInstallId(),
  });
}

export function collectBootDiagnostics(
  error: unknown,
  options: BootFailureOptions = {}
): BootDiagnostics {
  const message = getMessage(error);

  const detailLines: string[] = [];
  if (typeof window !== 'undefined') {
    detailLines.push(`URL: ${window.location.href}`);
  }
  if (typeof navigator !== 'undefined') {
    detailLines.push(`User-Agent: ${navigator.userAgent}`);
    detailLines.push(`Online: ${navigator.onLine}`);
  }
  detailLines.push(`Time: ${new Date().toISOString()}`);

  if (options.buildInfo) {
    for (const [key, value] of Object.entries(options.buildInfo)) {
      detailLines.push(`${key}: ${value}`);
    }
  }

  if (error instanceof Error && error.stack) {
    detailLines.push('');
    detailLines.push('Stack:');
    detailLines.push(error.stack);
  }

  const details = detailLines.join('\n');
  const copyableText = `${message}\n\n${details}`;

  return {
    message,
    hint: options.hint ?? '',
    details,
    copyableText,
  };
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback.
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

const CARD_STYLE =
  'width:min(100%,640px);border-radius:24px;border:1px solid rgba(148,163,184,0.35);' +
  'background:rgba(255,255,255,0.92);padding:24px;box-shadow:0 24px 80px rgba(15,23,42,0.14);';

const CONTAINER_STYLE =
  'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;' +
  'background:#f8fafc;color:#0f172a;' +
  "font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";

const KICKER_STYLE =
  'margin-bottom:12px;font-size:12px;font-weight:600;letter-spacing:0.12em;' +
  'text-transform:uppercase;color:#b91c1c;';

const TITLE_STYLE = 'font-size:20px;font-weight:700;';

const MESSAGE_STYLE =
  'margin-top:16px;white-space:pre-wrap;word-break:break-word;border-radius:16px;' +
  'background:#fff1f2;padding:16px;font-size:13px;line-height:1.6;color:#7f1d1d;';

const HINT_STYLE = 'margin-top:12px;font-size:13px;line-height:1.5;color:#475569;';

const ACTION_ROW_STYLE = 'margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;';

const PRIMARY_BUTTON_STYLE =
  'cursor:pointer;border:1px solid rgba(15,23,42,0.12);background:#0f172a;color:#f8fafc;' +
  'font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:10px;';

const SECONDARY_BUTTON_STYLE =
  'cursor:pointer;border:1px solid rgba(15,23,42,0.18);background:#ffffff;color:#0f172a;' +
  'font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:10px;';

const STATUS_STYLE = 'font-size:12px;color:#475569;';

const DIAG_DETAILS_STYLE = 'margin-top:16px;';

const DIAG_SUMMARY_STYLE = 'cursor:pointer;font-size:12px;color:#64748b;user-select:none;';

const DIAG_PRE_STYLE =
  'margin-top:8px;white-space:pre-wrap;word-break:break-word;border-radius:12px;' +
  'background:#f1f5f9;padding:12px;font-size:11px;line-height:1.5;color:#334155;';

export function renderBootFailure(
  rootElement: HTMLElement,
  error: unknown,
  options: BootFailureOptions = {}
): void {
  const diag = collectBootDiagnostics(error, options);

  // Pre-React `app/boot_failed` beacon (spec §7.4): emit once, here at the single
  // entry point every shell funnels boot failures through, before the SDK exists.
  captureBootFailedBeacon(error, options);

  // Make sure the error reaches the devtools console even when no UI is visible.
  // Use %s formatting so devtools renders multi-line strings nicely.
  console.error('[Lody] Boot failed.\n\nError: %s\n\nDiagnostics:\n%s', diag.message, diag.details);

  // React may have committed a partial tree before crashing; wipe it so the
  // fallback UI is the only thing visible.
  rootElement.innerHTML = '';

  const hintHtml = diag.hint ? `<p style="${HINT_STYLE}">${escapeHtml(diag.hint)}</p>` : '';

  const cardHtml =
    `<div style="${KICKER_STYLE}">Boot failed</div>` +
    `<div style="${TITLE_STYLE}">Lody could not start</div>` +
    `<pre style="${MESSAGE_STYLE}">${escapeHtml(diag.message)}</pre>` +
    hintHtml +
    `<div style="${ACTION_ROW_STYLE}">` +
    `<button type="button" data-action="copy" style="${PRIMARY_BUTTON_STYLE}">Copy error</button>` +
    `<button type="button" data-action="reload" style="${SECONDARY_BUTTON_STYLE}">Reload app</button>` +
    `<span data-role="status" aria-live="polite" style="${STATUS_STYLE}"></span>` +
    `</div>` +
    `<details style="${DIAG_DETAILS_STYLE}">` +
    `<summary style="${DIAG_SUMMARY_STYLE}">Diagnostics</summary>` +
    `<pre style="${DIAG_PRE_STYLE}">${escapeHtml(diag.details)}</pre>` +
    `</details>`;

  const container = document.createElement('div');
  container.setAttribute('role', 'alert');
  container.setAttribute('style', CONTAINER_STYLE);

  const card = document.createElement('div');
  card.setAttribute('style', CARD_STYLE);
  card.innerHTML = cardHtml;
  container.appendChild(card);
  rootElement.appendChild(container);

  const copyButton = card.querySelector<HTMLButtonElement>('button[data-action="copy"]');
  const reloadButton = card.querySelector<HTMLButtonElement>('button[data-action="reload"]');
  const status = card.querySelector<HTMLSpanElement>('[data-role="status"]');

  const setStatus = (text: string, autoClear = true) => {
    if (!status) return;
    status.textContent = text;
    if (autoClear && text) {
      window.setTimeout(() => {
        if (status.textContent === text) status.textContent = '';
      }, 3000);
    }
  };

  const beaconPlatform = options.platform ?? 'web';

  if (copyButton) {
    copyButton.addEventListener('click', () => {
      postBootBeaconEvent('app/boot_failure_copy_clicked', { platform: beaconPlatform });
      copyButton.disabled = true;
      void copyToClipboard(diag.copyableText).then((ok) => {
        copyButton.disabled = false;
        if (ok) {
          setStatus('Copied — paste it to us so we can investigate.');
          options.onCopy?.(diag.copyableText);
        } else {
          setStatus('Copy failed — open the Diagnostics section and select text manually.', false);
        }
      });
    });
  }

  if (reloadButton) {
    reloadButton.addEventListener('click', () => {
      postBootBeaconEvent('app/boot_failure_reload_clicked', { platform: beaconPlatform });
      reloadButton.disabled = true;
      setStatus('Reloading…', false);
      const reenable = (): void => {
        reloadButton.disabled = false;
      };
      try {
        const result = options.onReload ? options.onReload() : undefined;
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>)
            .catch((reloadErr) => {
              console.error('[Lody] onReload threw, falling back to location.reload', reloadErr);
              if (typeof window !== 'undefined') window.location.reload();
            })
            .finally(reenable);
          return;
        }
        if (!options.onReload && typeof window !== 'undefined') {
          window.location.reload();
        }
      } catch (reloadErr) {
        console.error('[Lody] onReload threw, falling back to location.reload', reloadErr);
        if (typeof window !== 'undefined') window.location.reload();
      }
      // Re-enable on every sync path (success, no-op, threw-and-recovered).
      // Most callers navigate away, but if onReload returns sync without
      // navigating, the button must not stay stuck disabled.
      reenable();
    });
  }
}
