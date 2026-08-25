import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as acp from "@agentclientprotocol/sdk";
import { WebSocketServer, type WebSocket } from "ws";
import { ActorService, Subscriber } from "./actor.js";
import { allowedOrigins, FRAME_BYTES, originAllowed } from "./config.js";
import { socketStream } from "./socket-stream.js";
import { asJsonObject, isString, type JsonValue } from "./type-guards.js";
import { ActorAuthenticator, type ConnectionIdentity } from "./auth.js";

interface DrainTarget {
  membershipId?: string;
  userId?: string;
}

function requestedProvider<Value>(value: Value): "claude" | "codex" | undefined {
  const meta = asJsonObject(value);
  const provider = meta?.["blitz/provider"];
  return provider === "claude" || provider === "codex" ? provider : undefined;
}

function emptyRequest<Value>(value: Value): Record<string, never> {
  const request = asJsonObject(value);
  if (request === null || Object.keys(request).length > 0) {
    throw new Error("auth status request must be empty");
  }
  return {};
}

export class ActorServer {
  private readonly http: HttpServer;
  private readonly websocket: WebSocketServer;
  private readonly sockets = new Map<WebSocket, ConnectionIdentity>();

  public constructor(
    private readonly service: ActorService,
    private readonly host = "127.0.0.1",
    private readonly port = 7444,
    extraOrigins?: string,
    private readonly authenticator = new ActorAuthenticator(),
  ) {
    const origins = allowedOrigins(extraOrigins);
    this.http = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/admin/drain") {
        const identity = this.authenticator.verify(request.headers["x-blitz-webapp-token"]);
        delete request.headers["x-blitz-webapp-token"];
        // Drain disconnects everyone when the target is empty, so a valid
        // ticket is not enough — it is the control plane's switch. The
        // workspace token presents as the owner.
        if (identity === null || (identity.role !== "owner" && identity.role !== "admin")) {
          response.writeHead(403).end();
          return;
        }
        void readDrainTarget(request).then((target) => {
          this.drain(target);
          response.writeHead(204).end();
        }, () => response.writeHead(400).end());
        return;
      }
      response.writeHead(404).end();
    });
    this.websocket = new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES, perMessageDeflate: false });
    this.http.on("upgrade", (request, socket, head) => {
      const identity = this.authenticator.verify(request.headers["x-blitz-webapp-token"]);
      delete request.headers["x-blitz-webapp-token"];
      if (identity === null) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (!originAllowed(request.headers.origin, origins)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (websocket) => this.accept(websocket, identity));
    });
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
    for (const socket of this.sockets.keys()) socket.close(1001, "Server shutting down");
    await new Promise<void>((resolve, reject) => this.websocket.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => this.http.close((error) => (error ? reject(error) : resolve())));
  }

  private drain(target: DrainTarget): void {
    for (const [socket, identity] of this.sockets) {
      if (target.membershipId !== undefined && target.membershipId !== identity.membershipId) continue;
      if (target.userId !== undefined && target.userId !== identity.userId) continue;
      socket.close(1001, "Workspace access revoked");
    }
  }

  private accept(socket: WebSocket, identity: ConnectionIdentity): void {
    this.sockets.set(socket, identity);
    const subscriber = new Subscriber(crypto.randomUUID(), identity, () => socket.close());
    const app = acp
      .agent({ name: "blitz-box" })
      .onConnect((connection) => subscriber.connect(connection.client))
      .onRequest(acp.methods.agent.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion === acp.PROTOCOL_VERSION ? params.protocolVersion : acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        agentInfo: { name: "BlitzOS box", version: "0.1.0" },
      }))
      .onRequest(acp.methods.agent.session.new, async ({ params }) => {
        const sessionId = await this.service.newSession(
          params.cwd,
          subscriber,
          requestedProvider(params._meta),
        );
        return {
          sessionId,
          configOptions: this.service.configOptions(sessionId),
          _meta: { "blitz/provider": this.service.provider(sessionId) },
        };
      })
      .onRequest(acp.methods.agent.session.load, async ({ params }) => {
        await this.service.loadSession(params.sessionId, params.cwd, subscriber);
        return {
          configOptions: this.service.configOptions(params.sessionId),
          _meta: { "blitz/provider": this.service.provider(params.sessionId) },
        };
      })
      .onRequest(acp.methods.agent.session.list, () => ({
        sessions: this.service.listSessions().map((session) => ({
          sessionId: session.id,
          cwd: "/workspace",
          updatedAt: new Date(session.updatedAt).toISOString(),
          _meta: {
            id: session.id,
            provider: session.provider,
            createdBy: session.createdBy,
          },
        })),
      }))
      .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => ({
        configOptions: this.service.setConfigOption(
          params.sessionId,
          params.configId,
          isString(params.value) ? params.value : "",
          subscriber,
        ),
      }))
      .onRequest("blitz/auth_status", emptyRequest, async () => this.service.authStatus())
      .onRequest(acp.methods.agent.session.prompt, ({ params }) => this.service.prompt(params.sessionId, params.prompt, subscriber))
      .onNotification(acp.methods.agent.session.cancel, ({ params }) => this.service.cancel(params.sessionId, subscriber));
    const connection = app.connect(socketStream(socket));
    socket.once("close", () => {
      this.sockets.delete(socket);
      this.service.removeSubscriber(subscriber);
      connection.close();
    });
  }
}

async function readDrainTarget(request: IncomingMessage): Promise<DrainTarget> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4_096) throw new Error("drain target too large");
    chunks.push(bytes);
  }
  if (size === 0) return {};
  const value: JsonValue = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const record = asJsonObject(value);
  if (record === null) throw new Error("invalid drain target");
  const keys = Object.keys(record);
  if (keys.length !== 1) throw new Error("invalid drain target");
  if (isString(record.membershipId) && record.membershipId !== "") return { membershipId: record.membershipId };
  if (isString(record.userId) && record.userId !== "") return { userId: record.userId };
  throw new Error("invalid drain target");
}
