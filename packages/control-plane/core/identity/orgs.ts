import type { Db } from "../db.js";
import { first } from "../db.js";

export const DEFAULT_ORG_VM_LIMIT = 10;

function slugBase(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return normalized === "" ? "org" : normalized;
}

function shortSuffix(): string {
  return [...crypto.getRandomValues(new Uint8Array(3))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function slugExists(db: Db, slug: string): Promise<boolean> {
  return (await first<{ id: string }>(db, {
    q: "SELECT id FROM orgs WHERE slug = ?1 LIMIT 1",
    v: [slug],
  })) !== null;
}

export async function availableOrgSlug(db: Db, name: string): Promise<string> {
  const base = slugBase(name);
  if (!(await slugExists(db, base))) return base;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${base.slice(0, 41)}-${shortSuffix()}`;
    if (!(await slugExists(db, candidate))) return candidate;
  }
  throw new Error("could not allocate a unique organization slug");
}
