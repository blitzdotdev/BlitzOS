import {
  buildBootstrapScript,
  type BootstrapOptions,
  type RecipeBootstrap,
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

export interface TunnelTokens {
  workspaceId: string;
  tunnelToken: string;
  webAppToken: string;
}

/** Installs the workspace tunnel credentials as a standalone cloud-init
 * part so the pinned bootstrap script bytes stay untouched. The webApp
 * token lands first: the box gateway arms itself fail-closed the moment a
 * tunnel token exists, and cloudflared waits for both files. */
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
`;
}

/** Boot shaping beyond the pinned base script: a recipe launch's invocation,
 * the org's usage-capture switch, the template's repo list, and the resolved
 * VM provider's own setup lines. Absent (or all-absent fields) emits the exact
 * pre-recipe bytes. */
export interface BootShaping {
  recipe?: RecipeBootstrap;
  usageCapture?: boolean;
  /** Template repos ("owner/name") for the bootstrap's detached clone loop. */
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
  if (shaping?.recipe !== undefined) bootstrapOptions.recipe = shaping.recipe;
  if (shaping?.usageCapture !== undefined) {
    bootstrapOptions.usageCapture = shaping.usageCapture;
  }
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
