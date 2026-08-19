const IV_BYTES = 12;
const KEY_BYTES = 32;

let importedKey: Promise<CryptoKey> | undefined;

function decodeBase64(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error("CRED_MASTER_KEY must be valid base64");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== KEY_BYTES) {
    throw new Error("CRED_MASTER_KEY must decode to exactly 32 bytes");
  }
  return bytes;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function importCredentialMasterKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    decodeBase64(value),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function credentialMasterKeyFor(
  value: string,
): Promise<CryptoKey> {
  importedKey ??= importCredentialMasterKey(value);
  return importedKey;
}

export async function sealRoot(
  key: CryptoKey,
  ownerName: string,
  root: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(root);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(ownerName),
      },
      key,
      plaintext,
    ),
  );
  const sealed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(ciphertext, iv.byteLength);
  return encodeBase64(sealed);
}

export async function openRoot(
  key: CryptoKey,
  ownerName: string,
  sealedRoot: string,
): Promise<string> {
  const sealed = decodeSealedRoot(sealedRoot);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: sealed.subarray(0, IV_BYTES),
      additionalData: new TextEncoder().encode(ownerName),
    },
    key,
    sealed.subarray(IV_BYTES),
  );
  return new TextDecoder().decode(plaintext);
}

function decodeSealedRoot(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error("credential root ciphertext is invalid");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength <= IV_BYTES + 16) {
    throw new Error("credential root ciphertext is invalid");
  }
  return bytes;
}
