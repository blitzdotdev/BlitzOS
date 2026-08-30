import { createServer } from "node:http";
// The box actor was deleted with the native-chat surface, and with it
// /opt/blitz/actor/node_modules. `ws` is now a global install beside lody,
// which is the copy blitz-lody-bridge uses (packages/box/Dockerfile).
import { WebSocketServer } from "/opt/blitz/npm/lib/node_modules/ws/wrapper.mjs";

const port = Number(process.env.PREVIEW_FIXTURE_PORT ?? "31234");
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/plain");
  response.end(`preview-http:${request.method}:${request.url}`);
});
const sockets = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    sockets.emit("connection", webSocket, request);
  });
});
sockets.on("connection", (socket, request) => {
  socket.on("message", (message) => socket.send(`preview-ws:${request.url}:${message.toString()}`));
});
server.listen(port, "127.0.0.1");
