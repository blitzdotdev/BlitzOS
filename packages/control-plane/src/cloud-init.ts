function cloudConfig(
  sshPublicKey: string,
  phoneHomeUrl: string,
): string {
  return `#cloud-config
ssh_pwauth: false
disable_root: false
users:
  - default
  - name: blitz
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${JSON.stringify(sshPublicKey)}
phone_home:
  url: ${JSON.stringify(phoneHomeUrl)}
  post: [pub_key_ecdsa, pub_key_ed25519, pub_key_rsa]
  tries: 10
`;
}

export function buildUserData(
  sshPublicKey: string,
  phoneHomeUrl: string,
  callerUserData?: string,
): string {
  const generated = cloudConfig(sshPublicKey, phoneHomeUrl);
  if (callerUserData === undefined || callerUserData.length === 0) return generated;

  const boundary = `blitz-${crypto.randomUUID()}`;
  const callerContentType = callerUserData.startsWith("#cloud-config")
    ? "text/cloud-config"
    : callerUserData.startsWith("#!")
      ? "text/x-shellscript"
      : "text/plain";
  return `Content-Type: multipart/mixed; boundary="${boundary}"
MIME-Version: 1.0

--${boundary}
Content-Type: ${callerContentType}; charset="utf-8"

${callerUserData}
--${boundary}
Content-Type: text/cloud-config; charset="utf-8"

${generated}
--${boundary}--
`;
}
