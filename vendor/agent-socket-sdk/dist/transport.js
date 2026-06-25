// WebSocket transport. Uses globalThis.WebSocket where available (browsers,
// Workers, Node 22+), falls back to dynamic import of `ws` for older Node.
//
// Returned object exposes a minimal cross-runtime surface — send/close/
// addEventListener — to insulate the rest of the SDK from runtime differences.
const READY_OPEN = 1;
export async function openWs(url, opts) {
    // Browser / Workers / Node 22+: native WebSocket.
    // The native API uses addEventListener and dispatches Event objects.
    if (typeof globalThis.WebSocket !== "undefined" && !(opts?.headers && Object.keys(opts.headers).length)) {
        const Native = globalThis.WebSocket;
        const ws = new Native(url);
        return wrapNative(ws);
    }
    // Node fallback (or when custom headers are needed — native doesn't support them).
    let WSCtor;
    try {
        const mod = await import("ws");
        WSCtor = mod.WebSocket ?? mod.default;
    }
    catch {
        throw new Error("No WebSocket implementation available. Install the `ws` package for Node, or run in a browser/Workers environment.");
    }
    const ws = new WSCtor(url, { headers: opts?.headers ?? {} });
    return wrapNode(ws);
}
function wrapNative(ws) {
    // Map our addListener/removeListener naming to addEventListener/removeEventListener
    // and adapt event objects to the listener signatures the SDK expects.
    const adapters = new WeakMap();
    return {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        get readyState() { return ws.readyState; },
        addListener: (event, fn) => {
            let adapter;
            switch (event) {
                case "message":
                    adapter = (ev) => fn(ev.data);
                    break;
                case "close":
                    adapter = (ev) => {
                        const ce = ev;
                        fn(ce.code, ce.reason);
                    };
                    break;
                case "error":
                    adapter = (ev) => fn(ev);
                    break;
                case "open":
                default:
                    adapter = () => fn();
                    break;
            }
            adapters.set(fn, adapter);
            ws.addEventListener(event, adapter);
        },
        removeListener: (event, fn) => {
            const adapter = adapters.get(fn);
            if (adapter)
                ws.removeEventListener(event, adapter);
        },
    };
}
function wrapNode(ws) {
    return {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        get readyState() { return ws.readyState; },
        addListener: (event, fn) => ws.on(event, fn),
        removeListener: (event, fn) => ws.off(event, fn),
    };
}
export const READY_STATE_OPEN = READY_OPEN;
