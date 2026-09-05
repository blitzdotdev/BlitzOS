import {
  buildBootstrapScript,
  type BootstrapOptions,
} from "./bootstrap.js";

function cloudConfig(sshPublicKey: string | undefined): string {
  const trimmedSshPublicKey = sshPublicKey?.trim();
  const includedSshPublicKey = trimmedSshPublicKey === "" ? undefined : trimmedSshPublicKey;
  const sshAuthorizedKeys = includedSshPublicKey === undefined
    ? ""
    : `    ssh_authorized_keys:
      - ${JSON.stringify(includedSshPublicKey)}
`;
  return `#cloud-config
ssh_pwauth: false
disable_root: false
users:
  - default
  - name: blitz
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
${sshAuthorizedKeys}`;
}

function contentType(userData: string): string {
  return userData.startsWith("#cloud-config")
    ? "text/cloud-config"
    : userData.startsWith("#!")
      ? "text/x-shellscript"
      : "text/plain";
}

function mimePart(boundary: string, type: string, content: string): string {
  return `--${boundary}
Content-Type: ${type}; charset="utf-8"

${content}`;
}

/** The file that says the three surface tokens beside it were written by the
 * running instance's cloud-init, rather than left on the volume by the VM this
 * one replaced. Named here because three runtimes agree on it: this producer,
 * the bootstrap script that clears it, and the guest service that waits. */
export const TOKENS_READY_MARKER = "/var/lib/blitz/tokens-ready";

export interface TunnelTokens {
  workspaceId: string;
  tunnelToken: string;
  webAppToken: string;
}

/** Installs the workspace tunnel credentials as a standalone cloud-init
 * part so the pinned bootstrap script bytes stay untouched. The webApp
 * token lands first: the box gateway arms itself fail-closed the moment a
 * tunnel token exists, and cloudflared waits for both files.
 *
 * THE READY MARKER, AND WHY EXISTENCE IS NOT ENOUGH. `/var/lib/blitz` is the
 * member's persistent volume, so on a re-provision (a machine-type change, a
 * recreate, a stop/start) these three files are already there. The tunnel can
 * be new or kept. This part is a separate cloud-init script, so it can run
 * after the bootstrap script has started the box container: measured on a
 * canary re-provision, cloudflared came up seven seconds before this script
 * rewrote the token, and cloudflared reads `--token-file` once.
 *
 * So the marker says "written by THIS instance", not "present". The bootstrap
 * script removes it after mounting the volume and before starting the
 * container (`core/bootstrap.ts`), and the guest waits on it
 * (`box/rootfs/etc/s6-overlay/s6-rc.d/cloudflared/run`). A plain reboot re-runs
 * neither script, so the marker survives beside the tokens it describes and
 * cloudflared starts without waiting. */
function tunnelTokenScript(tokens: TunnelTokens): string {
  return `#!/bin/bash
set -euo pipefail
install -d -m 0755 /var/lib/blitz
umask 077
printf '%s\\n' ${JSON.stringify(tokens.webAppToken)} >/var/lib/blitz/webapp-token.tmp
chown 1000:1000 /var/lib/blitz/webapp-token.tmp
mv /var/lib/blitz/webapp-token.tmp /var/lib/blitz/webapp-token
printf '%s\\n' ${JSON.stringify(tokens.workspaceId)} >/var/lib/blitz/workspace-id.tmp
chown 1000:1000 /var/lib/blitz/workspace-id.tmp
mv /var/lib/blitz/workspace-id.tmp /var/lib/blitz/workspace-id
printf '%s\\n' ${JSON.stringify(tokens.tunnelToken)} >/var/lib/blitz/tunnel-token.tmp
chown 1000:1000 /var/lib/blitz/tunnel-token.tmp
mv /var/lib/blitz/tunnel-token.tmp /var/lib/blitz/tunnel-token
: >/var/lib/blitz/tokens-ready.tmp
chown 1000:1000 /var/lib/blitz/tokens-ready.tmp
mv /var/lib/blitz/tokens-ready.tmp ${TOKENS_READY_MARKER}
`;
}

/** Boot shaping beyond the pinned base script: repository clones and the
 * resolved VM provider's own setup lines. */
export interface BootShaping {
  /** Workspace repos ("owner/name") for the bootstrap's detached clone loop. */
  repos?: string[];
  /** What `VmProvider.bootstrapAptSetup` returned for the provider that owns
   * this create. The caller resolves the provider; this only carries the
   * lines. */
  providerAptSetup?: string;
  /** The box container's `--hostname`, already built by `boxHostname`. The
   * caller owns the workspace name and id. This field carries only the
   * label. */
  boxHostname?: string;
}

export function buildUserData(
  sshPublicKey: string | undefined,
  phoneHomeUrl: string,
  boxImageRef: string,
  callerUserData?: string,
  boxImageTag = "",
  boxImageSha256 = "",
  tunnel?: TunnelTokens,
  shaping?: BootShaping,
): string {
  const boundary = `blitz-${crypto.randomUUID()}`;
  const parts: string[] = [];
  if (callerUserData !== undefined && callerUserData.length > 0) {
    parts.push(mimePart(boundary, contentType(callerUserData), callerUserData));
  }
  parts.push(mimePart(boundary, "text/cloud-config", cloudConfig(sshPublicKey)));
  const bootstrapOptions: BootstrapOptions = {
    boxImageRef,
    boxImageSha256,
    boxImageTag,
    phoneHomeUrl,
    sshPublicKey,
  };
  if (shaping?.repos !== undefined) bootstrapOptions.repos = shaping.repos;
  if (shaping?.providerAptSetup !== undefined) {
    bootstrapOptions.providerAptSetup = shaping.providerAptSetup;
  }
  if (shaping?.boxHostname !== undefined) {
    bootstrapOptions.boxHostname = shaping.boxHostname;
  }
  parts.push(
    mimePart(boundary, "text/x-shellscript", buildBootstrapScript(bootstrapOptions)),
  );
  if (tunnel !== undefined) {
    parts.push(
      mimePart(boundary, "text/x-shellscript", tunnelTokenScript(tunnel)),
    );
  }

  return `Content-Type: multipart/mixed; boundary="${boundary}"
MIME-Version: 1.0

${parts.join("\n")}
--${boundary}--
`;
}
