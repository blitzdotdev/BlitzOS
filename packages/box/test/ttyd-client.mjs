import { WebSocket } from "/opt/blitz/actor/node_modules/ws/wrapper.mjs";

const url = process.env.TTYD_URL;
const input = process.env.TTYD_INPUT ?? "";
if (!url) throw new Error("TTYD_URL is required");

await new Promise((resolve, reject) => {
  const socket = new WebSocket(url, ["tty"], { origin: "http://127.0.0.1:7443" });
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error(`ttyd timeout: ${url}`));
  }, 5000);
  let sawOutput = false;

  socket.on("open", () => {
    socket.send(Buffer.from(JSON.stringify({ AuthToken: "", columns: 80, rows: 24 })));
    if (input) {
      setTimeout(() => socket.send(Buffer.concat([Buffer.from("0"), Buffer.from(input)])), 250);
    }
    setTimeout(() => socket.close(1000, "smoke complete"), 900);
  });
  socket.on("message", () => {
    sawOutput = true;
  });
  socket.on("error", reject);
  socket.on("close", () => {
    clearTimeout(timeout);
    if (!sawOutput) reject(new Error(`ttyd returned no output: ${url}`));
    else resolve();
  });
});
