export interface TtydSize {
  columns: number;
  rows: number;
}

export function ttydPageUrl(url: string): string {
  const page = new URL(url);
  if (page.protocol === "ws:") page.protocol = "http:";
  if (page.protocol === "wss:") page.protocol = "https:";
  if (page.pathname.endsWith("/ws")) page.pathname = `${page.pathname.slice(0, -2)}`;
  if (!page.pathname.endsWith("/")) page.pathname = `${page.pathname}/`;
  return page.toString();
}

export function ttydWebSocketUrl(url: string): string {
  const socket = new URL(ttydPageUrl(url));
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  socket.pathname = `${socket.pathname}ws`;
  return socket.toString();
}

export function ttydNeedsOwnOrigin(url: string, pageOrigin: string): boolean {
  return new URL(ttydPageUrl(url)).origin !== new URL(pageOrigin).origin;
}

export function createTtydSocket(
  url: string,
  size: TtydSize,
  WebSocketConstructor: typeof WebSocket = WebSocket,
): WebSocket {
  const socket = new WebSocketConstructor(ttydWebSocketUrl(url), ["tty"]);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    socket.send(new TextEncoder().encode(JSON.stringify({ AuthToken: "", ...size })));
  });
  return socket;
}
