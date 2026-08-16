import { HttpError } from "../http.js";

export function relativeObjectKey(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "object key must be valid URL encoding");
  }
  if (
    decoded === ""
    || decoded.startsWith("/")
    || decoded.includes("\\")
    || decoded.includes("\u0000")
  ) {
    throw new HttpError(400, "object key is invalid");
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new HttpError(400, "object key is invalid");
  }
  return decoded;
}

export function folderObjectPrefix(orgId: string, folderId: string): string {
  return `org/${orgId}/${folderId}/`;
}

export function folderObjectKey(
  orgId: string,
  folderId: string,
  relativeKey: string,
): string {
  return `${folderObjectPrefix(orgId, folderId)}${relativeKey}`;
}
