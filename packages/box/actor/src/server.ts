import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as acp from "@agentclientprotocol/sdk";
import { WebSocketServer, type WebSocket } from "ws";
import { ActorService, Subscriber } from "./actor.js";
import { allowedOrigins, FRAME_BYTES, originAllowed } from "./config.js";
import { socketStream } from "./socket-stream.js";

export class ActorServer {
  private readonly http: HttpServer;
  private readonly websocket: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();

  public constructor(
    private readonly service: ActorService,
    private readonly host = "127.0.0.1",
    private readonly port = 7444,
    extraOrigins?: string,
  ) {
    const origins = allowedOrigins(extraOrigins);
    this.http = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.websocket = new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES, perMessageDeflate: false });
    this.http.on("upgrade", (request, socket, head) => {
      if (!originAllowed(request.headers.origin, origins)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (websocket) => this.websocket.emit("connection", websocket));
    });
    this.websocket.on("connection", (socket) => this.accept(socket));
  }

  public start(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
        this.http.listen(this.port, this.host, () => {
          this.http.off("error", reject);
          // SAFETY: This callback runs after the explicitly configured TCP host/port listener has bound, so address() is an AddressInfo.
          resolve(this.http.address() as AddressInfo);
      });
    });
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.close(1001, "Server shutting down");
    await new Promise<void>((resolve, reject) => this.websocket.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => this.http.close((error) => (error ? reject(error) : resolve())));
  }

  private accept(socket: WebSocket): void {
    this.sockets.add(socket);
    const subscriber = new Subscriber(crypto.randomUUID(), () => socket.close());
    const app = acp
      .agent({ name: "blitz-box" })
      .onConnect((connection) => subscriber.connect(connection.client))
      .onRequest(acp.methods.agent.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion === acp.PROTOCOL_VERSION ? params.protocolVersion : acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "BlitzOS box", version: "0.1.0" },
      }))
      .onRequest(acp.methods.agent.session.new, async ({ params }) => ({
        sessionId: await this.service.newSession(params.cwd, subscriber),
      }))
      .onRequest(acp.methods.agent.session.load, async ({ params }) => {
        await this.service.loadSession(params.sessionId, params.cwd, subscriber);
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, ({ params }) => this.service.prompt(params.sessionId, params.prompt))
      .onNotification(acp.methods.agent.session.cancel, ({ params }) => this.service.cancel(params.sessionId));
    const connection = app.connect(socketStream(socket));
    socket.once("close", () => {
      this.sockets.delete(socket);
      this.service.removeSubscriber(subscriber);
      connection.close();
    });
  }
}
