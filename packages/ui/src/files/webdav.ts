export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export interface WebDavEntry {
  path: string;
  name: string;
  directory: boolean;
  size: number | null;
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class WebDavClient {
  private readonly base: URL;

  public constructor(baseUrl: string, private readonly fetcher: Fetcher = fetch) {
    this.base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  }

  public async list(path: string): Promise<WebDavEntry[]> {
    const response = await this.request(this.url(path), {
      method: "PROPFIND",
      headers: { Depth: "1" },
      credentials: "include",
    });
    if (!response.ok) throw new Error(`Directory listing failed (${response.status}).`);
    return parseDirectory(await response.text(), this.base, normalizePath(path));
  }

  public async read(path: string): Promise<string> {
    const response = await this.request(this.url(path), { credentials: "include" });
    if (!response.ok) throw new Error(`File load failed (${response.status}).`);
    return response.text();
  }

  public async put(path: string, body: BodyInit): Promise<boolean> {
    const response = await this.request(this.url(path), { method: "PUT", body, credentials: "include" });
    return response.ok;
  }

  public async remove(path: string): Promise<void> {
    const response = await this.request(this.url(path), { method: "DELETE", credentials: "include" });
    if (!response.ok) throw new Error(`Delete failed (${response.status}).`);
  }

  public async mkdir(path: string): Promise<void> {
    const response = await this.request(this.url(path), { method: "MKCOL", credentials: "include" });
    if (!response.ok) throw new Error(`Create folder failed (${response.status}).`);
  }

  public async move(from: string, to: string): Promise<void> {
    const response = await this.request(this.url(from), {
      method: "MOVE",
      headers: { Destination: this.url(to).toString() },
      credentials: "include",
    });
    if (!response.ok) throw new Error(`Rename failed (${response.status}).`);
  }

  private url(path: string): URL {
    const encoded = normalizePath(path)
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    return new URL(encoded, this.base);
  }

  private request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const fetcher = this.fetcher;
    return fetcher(input, init);
  }
}

export function joinPath(directory: string, name: string): string {
  const safeName = name.trim();
  if (safeName.length === 0 || safeName === "." || safeName === ".." || safeName.includes("/")) {
    throw new Error("Names cannot be empty or contain slashes.");
  }
  return `${directory === "/" ? "" : directory}/${safeName}`;
}

export function parentPath(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function parseDirectory(xml: string, base: URL, requestedPath: string): WebDavEntry[] {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror") !== null) throw new Error("Directory listing was malformed.");
  const rootPath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const entries: WebDavEntry[] = [];
  for (const item of document.getElementsByTagNameNS("*", "response")) {
    const href = item.getElementsByTagNameNS("*", "href").item(0)?.textContent;
    if (href === undefined || href === null) continue;
    const pathname = new URL(href, base).pathname;
    if (!pathname.startsWith(rootPath)) continue;
    let relative: string;
    try {
      relative = decodeURIComponent(pathname.slice(rootPath.length)).replace(/\/$/, "");
    } catch {
      continue;
    }
    const path = relative.length === 0 ? "/" : `/${relative}`;
    if (path === requestedPath) continue;
    const name = item.getElementsByTagNameNS("*", "displayname").item(0)?.textContent
      ?? relative.split("/").at(-1)
      ?? relative;
    const sizeText = item.getElementsByTagNameNS("*", "getcontentlength").item(0)?.textContent;
    entries.push({
      path,
      name,
      directory: item.getElementsByTagNameNS("*", "collection").length > 0,
      size: sizeText !== undefined && sizeText !== null && /^\d+$/.test(sizeText) ? Number(sizeText) : null,
    });
  }
  return entries.sort((left, right) =>
    Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name)
  );
}

function normalizePath(path: string): string {
  const normalized = `/${path.split("/").filter(Boolean).join("/")}`;
  return normalized === "/" ? "/" : normalized.replace(/\/$/, "");
}
