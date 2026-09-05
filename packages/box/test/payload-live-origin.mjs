#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const [
  portSource,
  releaseRoot,
  configPath,
  featuresPath,
  resultsPath,
  statsPath,
  readyPath,
] = process.argv.slice(2);
const port = Number(portSource);
if (
  !Number.isSafeInteger(port)
  || port < 1
  || releaseRoot === undefined
  || configPath === undefined
  || featuresPath === undefined
  || resultsPath === undefined
  || statsPath === undefined
  || readyPath === undefined
) {
  throw new Error(
    "usage: payload-live-origin.mjs <port> <release-root> <config> <features> <results> <stats> <ready>",
  );
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function selectedRelease() {
  const source = (await readFile(configPath, "utf8")).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(source)) {
    throw new Error("payload origin config is not a version token");
  }
  return source;
}

async function lodySessionsEnabled() {
  const source = (await readFile(featuresPath, "utf8")).trim();
  if (source !== "0" && source !== "1") {
    throw new Error("payload origin feature config must be 0 or 1");
  }
  return source === "1";
}

const server = http.createServer((request, response) => {
  void (async () => {
    const version = await selectedRelease();
    const lodySessions = await lodySessionsEnabled();
    const release = path.join(releaseRoot, version);
    if (request.url === "/workspaces/self/box-config" && request.method === "GET") {
      if (request.headers.authorization !== "Bearer smoke-bearer") {
        response.writeHead(401).end();
        return;
      }
      sendJson(response, 200, {
        boxImageRef: "smoke",
        controlPlaneOrigin: `http://127.0.0.1:${port}`,
        updateRequested: false,
        features: { lodySessions },
        payload: {
          version,
          manifestUrl: `http://127.0.0.1:${port}/box-payload/${version}/manifest.json`,
        },
      });
      return;
    }
    if (request.url === "/workspaces/self/payload-result" && request.method === "POST") {
      if (request.headers.authorization !== "Bearer smoke-bearer") {
        response.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      await appendFile(resultsPath, `${Buffer.concat(chunks).toString("utf8")}\n`);
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/workspaces/self/machine-stats" && request.method === "POST") {
      if (request.headers.authorization !== "Bearer smoke-bearer") {
        response.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      await appendFile(statsPath, `${Buffer.concat(chunks).toString("utf8")}\n`);
      response.writeHead(204).end();
      return;
    }
    const prefix = `/box-payload/${version}/`;
    if (request.method === "GET" && request.url?.startsWith(prefix)) {
      const name = request.url.slice(prefix.length);
      if (name === "manifest.json" || name === "payload.tar.gz") {
        createReadStream(path.join(release, name))
          .once("error", () => response.writeHead(404).end())
          .pipe(response);
        return;
      }
    }
    response.writeHead(404).end();
  })().catch((error) => {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  });
});

server.listen(port, "127.0.0.1", async () => {
  await writeFile(readyPath, "ready\n");
});
