### 1. CPU accounting — VERIFIED

For a plain stateless Worker, CPU time **accumulates across the entire WebSocket connection/request**. Incoming `message` events do **not** receive a new CPU allowance.

Cloudflare defines the connection as one long-lived HTTP request, says WebSocket messages are not additional requests, and applies `limits.cpu_ms` per HTTP request/invocation. The per-message reset is explicitly documented only for Durable Objects. [WebSocket request accounting](https://developers.cloudflare.com/network/websockets/#requests-and-bandwidth-measurement), [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers), [Durable Object reset rule](https://developers.cloudflare.com/durable-objects/platform/limits/).

Thus, CPU spent forwarding every frame in JavaScript consumes the same connection-wide allowance; idle/network-wait time does not.

### 2. Limit breach and long-lived proxying — VERIFIED; close detail UNCLEAR

When the accumulated CPU limit is reached, Cloudflare terminates the execution and records `exceededCpu`; documentation says the client receives Error `1102`, `Worker exceeded resource limits`. A Cloudflare staff answer describes this as the request being “forcefully canceled.” [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#error-exceeded-cpu-time-limit), [Cloudflare staff explanation](https://github.com/cloudflare/workers-chat-demo/issues/29#issuecomment-1407066543).

For a WebSocket already upgraded with `101`, Cloudflare does **not** document whether a Close frame is sent, its close code, or whether the browser can surface `1102`. The connection cannot continue after its request is canceled, but the exact wire-level closure is **UNCLEAR**.

Long-lived HTTP/WebSocket requests otherwise have no hard wall-time limit. Cloudflare recommends heartbeats and warns that runtime/server updates can terminate WebSockets. For two-sided proxy close coordination, use `accept({ allowHalfOpen: true })`, including on the outbound `fetch(... Upgrade ...)` WebSocket. [Duration limits](https://developers.cloudflare.com/workers/platform/limits/#duration), [WebSocket operational guidance](https://developers.cloudflare.com/network/websockets/#technical-note), [half-open proxying](https://developers.cloudflare.com/workers/runtime-apis/websockets/#half-open-mode-for-proxying).

### 3. Concurrency and scaling — VERIFIED; exact topology UNCLEAR

Cloudflare automatically scales Workers across its global network; there is no replica count or Worker load balancer for you to configure. By default, execution occurs near where the request was received. Requests may reach the same or different Worker instances, and one instance can handle multiple concurrent requests on its single-threaded event loop. [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/#distributed-execution), [automatic scaling](https://developers.cloudflare.com/workers/platform/limits/#daily-requests), [default placement](https://developers.cloudflare.com/workers/configuration/placement/).

Cloudflare does not promise a fixed number of copies per colo or document the exact “available instance” selection algorithm, so that internal topology is **UNCLEAR**.

### 4. Connection ceilings and memory pressure — UNCLEAR for ceiling; VERIFIED behavior

Cloudflare publishes **no numeric per-isolate or per-colo concurrent-request/WebSocket ceiling** for stateless Workers. “No general requests-per-second limit” and “one isolate can handle many concurrent requests” are documented, but neither specifies how many long-lived sockets fit in one isolate. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Relevant documented constraints:

- Memory is **128 MB per isolate**, shared by all concurrent requests. On excess, Cloudflare lets in-flight requests complete and routes later requests to a new isolate; under extremely high load, it may cancel incoming requests.
- Isolates may be evicted because of machine or individual resource limits.
- The six-outgoing-connection limit now applies only while connections await response headers. Once the WebSocket upgrade headers arrive, the established outbound socket no longer occupies one of those six slots.
- Each incoming WebSocket frame may be up to 32 MiB and is fully buffered before its `message` event, making traffic patterns and buffering important for memory sizing.

Sources: [memory and eviction](https://developers.cloudflare.com/workers/platform/limits/#memory), [isolate lifecycle](https://developers.cloudflare.com/workers/reference/how-workers-works/#isolates), [outgoing connections](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections), [frame buffering](https://developers.cloudflare.com/workers/runtime-apis/websockets/#reading-binary-payloads).