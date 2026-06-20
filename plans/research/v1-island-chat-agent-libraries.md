# BlitzOS V1 island chat/agent library research

Updated: 2026-06-20

## Recommendation

Build V1 chat as a native BlitzOS island UI. Do not adopt a full chat runtime or agent framework. Borrow the parts that reduce risk:

- Use `react-markdown` + `remark-gfm` for V1 markdown rendering in `IslandPanel`.
- Borrow the AI SDK UI message model vocabulary: message `parts`, `status`, `stop`, retry, error, and typed tool parts.
- Borrow AG-UI/CopilotKit/assistant-ui concepts for interaction states and component anatomy, not their runtime stack.
- Keep Blitz's existing `agent-runtime`, terminal/session plumbing, `/events`, and `/steer` as the source of truth.

This matches the V1 cut plan: no Blitz-owned web surfaces, no canvas widgets, chat-only onboarding, workflow progress in chat, and status-only supervisor tick. It also avoids pulling Tailwind/shadcn assumptions into the island.

## Recommendation matrix

| Library / pattern | Use case | Decision | Integration cost | V1 risk | Why |
|---|---|---:|---:|---:|---|
| `react-markdown` + `remark-gfm` | Render assistant/user markdown in `IslandPanel` | Adopt | Low | Low | CSS-agnostic, React-native, plugin-based, enough for tables/task lists/code blocks/links. Pair with memoized message blocks so long transcripts do not thrash. |
| Streamdown | Streaming markdown renderer | Spike later | Medium | Medium | Strong AI-streaming behavior, incomplete-block handling, code/math/mermaid plugins, link safety. But current docs assume Tailwind/shadcn-style variables and extra CSS, which conflicts with Blitz's plain CSS island unless proven otherwise. |
| Vercel AI SDK UI `useChat` | Chat states and message shape | Borrow | Medium if adopted, low if borrowed | Medium | Good model for `parts`, status states, stop/retry/error, tool-call parts, stream resume, and persistence. Do not replace Blitz's runtime or transport with `useChat`; map the concepts onto existing session data. |
| AI SDK tool-call parts | Tool-call UI states | Borrow | Low | Low | Gives a clean vocabulary for `input-streaming`, `input-available`, `output-available`, and `output-error`; maps well to Details rows and future permission prompts. |
| OpenAI Agents SDK tools | Tool category and approval mental model | Borrow | Low | Low | Useful taxonomy: hosted tools, built-in execution tools, function tools, MCP, agent-as-tool. Also validates that computer use and tool approvals are first-class agent UI concepts. |
| AG-UI | Agent/user event protocol vocabulary | Borrow | Low | Low | Good names for streaming chat, typed attachments, frontend tool calls, interrupts, steering, custom events, and tool output streaming. Too broad to adopt for V1. |
| assistant-ui | Thread/chat primitives | Reject for V1 runtime; borrow anatomy | High | High | Good reference for thread list, composer, message primitives, and performant streaming chat. But adopting it would impose another state layer around a custom Electron/agent runtime. |
| CopilotKit | Agent UX patterns | Reject for V1 runtime; borrow anatomy | High | High | Strong reference for chat, generative UI, shared state, and human-in-loop workflows. But it is designed around CopilotKit/AG-UI-compatible runtime wiring, which is not the V1 goal. |

## V1 chat UX spec

### Structure

- The island has one shipped app: Chat.
- The persistent top strip remains: new-session tab first, then one tab per agent/session.
- New-session view is a composer plus attachment affordance. Sending a prompt spawns a session with the selected attachments.
- Session view is the transcript, Details, live status, and steer composer.
- Peek mode stays separate from the transcript: show active session status/milestones without mixing narrator summaries into chat.

### Transcript

- Render user and assistant text through a `MarkdownMessage` component.
- Use `react-markdown` with `remark-gfm`; disable raw HTML unless there is a deliberate allowlist later.
- Render links safely: external links should open through Electron shell/app policy, not navigate inside the island.
- Code blocks should be readable and copyable eventually; V1 can start with styled pre/code blocks if copy buttons are too much.
- Memoize each message by stable id/text/role so streaming or status updates do not re-render the whole feed.

### Message state model

Borrow these AI SDK-style states and map them onto Blitz session state:

- `submitted`: user sent a message and the agent has not produced visible output yet.
- `streaming`: assistant output or status updates are arriving.
- `ready`: session can accept another steer message.
- `error`: agent or transport failed; show a compact error row and retry affordance where supported.
- `stopped`: user or runtime stopped the session.

The UI label can stay Blitz-native: `Working`, `Needs you`, `Done`, `Problem`, `Idle`.

### Controls

- Keep `ChatInput`'s current behavior: uncontrolled textarea, auto-grow, Enter sends, Shift+Enter newline, IME-safe.
- Add a stop control only when the underlying runtime has a clear stop API for the active session.
- Add retry only for failures where replaying the last user message is safe and the runtime can support it.
- Steer messages use the same composer pattern but copy should be action-oriented: `Message this agent...` or `Steer this agent...`.

## Tools and attachments UX spec

### Pre-spawn attachments

- Attachment choices are part of the new-session composition, not global skills.
- Browser-use means the user's real browser/tabs through the connector extension, not a Blitz web surface.
- Computer-use means native apps through the helper.
- Remove the Deep toggle and skill bar from V1 chat. Workflows are agent-decided and report progress in chat.

### Attachment presentation

- Attachment panel should show two primary capability cards: Browser and Computer.
- Each capability card has three states: unavailable, available, selected.
- Browser can expand into available tabs/apps when connector data exists.
- Computer can show permission/setup status from the helper.
- File/app/tab drag affordances are secondary; avoid implying canvas placement.

### Tool-call states in chat

Represent tool activity as compact rows in the transcript or Details area:

- `Preparing`: tool call is being formed or input is streaming.
- `Needs approval`: user must allow or deny.
- `Running`: tool is executing.
- `Result`: tool produced output; show a short summary with Details expansion.
- `Denied`: user declined.
- `Problem`: tool failed; show retry only if safe.

For V1, keep most noisy tool detail behind Details. The transcript should read like a conversation with occasional durable status rows, not a terminal log.

### Concurrency/tool guard

- Show a warning when two sessions want the same scarce external target, such as the same browser profile/app.
- Default copy: `Another session is using Chrome. Continue here, wait, or switch that session off?`
- V1 can research/codify the UX now; hard enforcement can land with the tool-attachment owner if plumbing is not ready.

## Blitz-specific mapping

| Blitz surface | Borrowed pattern | Concrete direction |
|---|---|---|
| `IslandPanel` feed | Markdown renderer + message parts | Introduce `MarkdownMessage` and render assistant/user text through it. Later split message parts into text/tool/status rows. |
| `IslandPanel` status line | AI SDK `status`, AG-UI steering | Keep existing status labels, but make them reflect submitted/streaming/ready/error/stopped states more explicitly. |
| `Details` | Tool-call parts | Convert raw detail rows into typed tool rows when runtime data is available. |
| `ChatInput` | Existing local best practice | Keep custom component. It already handles auto-grow, native undo/paste, Enter behavior, and IME correctly. |
| `AttachPanel` | Typed attachments | Replace mock skills/deep strip with Browser and Computer capability cards. |
| Agent sessions | assistant-ui thread primitives | Borrow tab/thread anatomy, not state management. Sessions remain Blitz agent ids. |
| Workflow progress | AG-UI tool output streaming | Report progress in chat/status rows. Defer live graph/widgets. |

## Tiny spike recommendation

Start with a `react-markdown` proof in `IslandPanel`.

Spike scope:

- Add dependencies: `react-markdown` and `remark-gfm`.
- Add a tiny `MarkdownMessage` component used only by island chat messages.
- Style markdown under `.isl-msg` for paragraphs, lists, task lists, tables, code, pre, blockquote, and links.
- Run a fixture through the island feed with GFM table, task list, fenced code, long paragraph, link, and incomplete code fence.
- Verify the island still fits: feed scrolls, composer remains visible, Details/status do not overlap, no canvas words appear.

Do not spike Streamdown first. Revisit it only if the `react-markdown` proof looks bad while text is actively streaming.

## Source notes

- Vercel AI SDK UI documents `useChat` as handling message streaming, managed input/messages/status/error state, and design-flexible integration. It also recommends rendering UI messages via `parts`, which supports text, tool invocation, and tool result parts.
- Vercel AI SDK tool usage defines useful tool categories for chat UI: server-side tools, client-side tools, and tools requiring user interaction. It exposes tool calls/results as typed message parts.
- `react-markdown` supports `remarkPlugins`, `rehypePlugins`, and custom React components; with `remark-gfm` it covers the V1 markdown needs without taking over state.
- Streamdown is purpose-built for AI streaming markdown and includes strong features, but its docs call out Tailwind/shadcn-style CSS variables and package CSS setup.
- assistant-ui and CopilotKit are useful references for production chat primitives, thread state, headless UI, tool rendering, shared state, and human-in-loop flows. They should not own Blitz V1 runtime.
- AG-UI is a useful protocol vocabulary for streaming chat, typed attachments, frontend tool calls, interrupts, agent steering, custom events, and tool output streaming. Adopt the vocabulary, not the protocol, for V1.

## References

- https://ai-sdk.dev/docs/ai-sdk-ui/chatbot
- https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage
- https://github.com/remarkjs/react-markdown
- https://streamdown.ai/
- https://www.assistant-ui.com/docs
- https://docs.copilotkit.ai/
- https://openai.github.io/openai-agents-js/guides/tools/
- https://docs.ag-ui.com/introduction
