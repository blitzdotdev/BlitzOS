import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface ProbeModule {
  probeGateway(config: { gatewayHealthUrl: string }, timeoutMs: number): Promise<boolean>;
}

const updater = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-payload", import.meta.url),
);
// SAFETY: blitz-payload's checked-in CommonJS export names probeGateway; each
// test below exercises its boolean promise contract before relying on it.
const { probeGateway } = createRequire(import.meta.url)(updater) as ProbeModule;
const servers: Server[] = [];

function listen(status: number): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status);
    response.end();
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    // SAFETY: this callback runs only after a TCP bind, so the address is an
    // AddressInfo rather than null or a unix socket path.
    const address = server.address() as AddressInfo;
    resolve(`http://127.0.0.1:${address.port}/healthz`);
  }));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("blitz-payload gateway health", () => {
  it("counts the gateway's unauthenticated 403 as alive", async () => {
    const gatewayHealthUrl = await listen(403);
    await expect(probeGateway({ gatewayHealthUrl }, 250)).resolves.toBe(true);
  });

  it("does not count a 503 or absent listener as healthy", async () => {
    const gatewayHealthUrl = await listen(503);
    await expect(probeGateway({ gatewayHealthUrl }, 250)).resolves.toBe(false);
    await expect(probeGateway({ gatewayHealthUrl: "http://127.0.0.1:1/healthz" }, 50))
      .resolves.toBe(false);
  });
});
