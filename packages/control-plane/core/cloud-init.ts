import { buildBootstrapScript } from "./bootstrap.js";

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
  tunnelToken: string;
  surfaceToken: string;
}

/** Installs the workspace tunnel credentials as a standalone cloud-init
 * part so the pinned bootstrap script bytes stay untouched. The surface
 * token lands first: the box gateway arms itself fail-closed the moment a
 * tunnel token exists, and cloudflared waits for both files. */
function tunnelTokenScript(tokens: TunnelTokens): string {
  return `#!/bin/bash
set -euo pipefail
install -d -m 0755 /var/lib/blitz
umask 077
printf '%s\\n' ${JSON.stringify(tokens.surfaceToken)} >/var/lib/blitz/surface-token.tmp
chown 1000:1000 /var/lib/blitz/surface-token.tmp
mv /var/lib/blitz/surface-token.tmp /var/lib/blitz/surface-token
printf '%s\\n' ${JSON.stringify(tokens.tunnelToken)} >/var/lib/blitz/tunnel-token.tmp
chown 1000:1000 /var/lib/blitz/tunnel-token.tmp
mv /var/lib/blitz/tunnel-token.tmp /var/lib/blitz/tunnel-token
`;
}

export function buildUserData(
  sshPublicKey: string | undefined,
  phoneHomeUrl: string,
  boxImageRef: string,
  callerUserData?: string,
  boxImageTag = "",
  boxImageSha256 = "",
  tunnel?: TunnelTokens,
): string {
  const boundary = `blitz-${crypto.randomUUID()}`;
  const parts: string[] = [];
  if (callerUserData !== undefined && callerUserData.length > 0) {
    parts.push(mimePart(boundary, contentType(callerUserData), callerUserData));
  }
  parts.push(mimePart(boundary, "text/cloud-config", cloudConfig(sshPublicKey)));
  parts.push(
    mimePart(
      boundary,
      "text/x-shellscript",
      buildBootstrapScript({
        boxImageRef,
        boxImageSha256,
        boxImageTag,
        phoneHomeUrl,
        sshPublicKey,
      }),
    ),
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
