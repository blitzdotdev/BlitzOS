import { z } from 'zod';
import { requireCloudAuthBaseUrl } from './cloud-http-port';

const BugReportCreateResponseSchema = z.object({
  bugReportId: z.string().min(1),
});

const BugReportRequestTokenResponseSchema = z.object({
  requestToken: z.string().min(1),
});

export type MintBugReportRequestTokenResult =
  | { ok: true; requestToken: string }
  | { ok: false; error: string };

/**
 * Mint the signed requester proof that must accompany a machine-backed bug
 * report. The backend derives the reporter identity from this token, so the
 * machine never has to trust a caller-supplied user id.
 */
export async function mintBugReportRequestToken({
  workspaceId,
  machineId,
  sessionToken,
  authBaseUrl,
}: {
  workspaceId: string;
  machineId: string;
  sessionToken: string;
  authBaseUrl?: string;
}): Promise<MintBugReportRequestTokenResult> {
  authBaseUrl = requireCloudAuthBaseUrl('bugReport', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: 'not_authenticated' };
  }
  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(
      `${authBaseUrl.replace(/\/+$/, '')}/api/bug-reports/request-token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmedToken}`,
        },
        body: JSON.stringify({ workspaceId, machineId }),
      }
    );
    if (!response.ok) {
      return { ok: false, error: `Bug report request failed with status ${response.status}.` };
    }
    const parsed = BugReportRequestTokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: 'Bug report request returned an invalid response.' };
    }
    return { ok: true, requestToken: parsed.data.requestToken };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type SubmitWebBugReportResult =
  | { ok: true; bugReportId: string }
  | { ok: false; error: string };

/**
 * Description-only bug report filed directly from the Web client (no machine
 * selected, so there are no logs to attach). Machine-backed reports go through
 * the machine RPC instead so the CLI can bundle its local logs.
 */
export async function submitWebBugReport({
  workspaceId,
  description,
  sessionToken,
  authBaseUrl,
}: {
  workspaceId: string;
  description: string;
  sessionToken: string;
  authBaseUrl?: string;
}): Promise<SubmitWebBugReportResult> {
  authBaseUrl = requireCloudAuthBaseUrl('bugReport', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: 'not_authenticated' };
  }
  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(`${authBaseUrl.replace(/\/+$/, '')}/api/bug-reports/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: JSON.stringify({ workspaceId, description }),
    });
    if (!response.ok) {
      return { ok: false, error: `Bug report upload failed with status ${response.status}.` };
    }
    const parsed = BugReportCreateResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: 'Bug report upload returned an invalid response.' };
    }
    return { ok: true, bugReportId: parsed.data.bugReportId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
