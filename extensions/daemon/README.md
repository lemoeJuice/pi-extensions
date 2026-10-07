# Pi Remote Daemon

The extension automatically starts a local daemon (if necessary), registers the
current Pi session, forwards lifecycle/tool/message events, and makes browser
messages available to the live Pi session.

## Usage

Load `extensions/daemon/index.ts` in Pi (it is included in this package). The
daemon listens on this machine's current Tailscale IPv4 address
(`100.64.209.124:4317` in this setup) by default. Open
<http://100.64.209.124:4317> from a device on the same tailnet to view sessions.

After upgrading from the plugin-specific approval protocol, reload/restart Pi's
extensions and refresh the browser page. There is no legacy `/approvals` fallback.

Override the endpoint with `PI_REMOTE_HOST` and `PI_REMOTE_PORT`. Access is
governed by your Tailscale ACLs. Do not bind to `0.0.0.0` unless you
intentionally accept the additional security implications. Alternatively, bind
to localhost and expose it through Tailscale Serve:

```sh
PI_REMOTE_HOST=127.0.0.1 tailscale serve http://127.0.0.1:4317
```

When a new Pi process connects, the extension compares the running daemon's
build fingerprint with the local daemon files. If they differ, it sends the
outdated local daemon `SIGTERM`, waits for it to release the configured address,
and starts the matching version. The daemon closes WebSocket clients cleanly
when it receives `SIGTERM`; connected Pi extensions reconnect automatically.
This replacement is limited to a daemon process on this machine listening on
the configured IPv4 address and port. You can also start the daemon manually
with `node extensions/daemon/daemon/main.js`. It remains alive after Pi exits. For sessions
registered while the daemon is running, the session page reads the active branch
from Pi's JSONL file (read-only) and loads older messages in pages. Offline
session discovery after a daemon restart is not implemented.

The registry is in memory and keeps only sessions with a connected Pi instance.
When the last instance disconnects, its registry entry and captured runtime
events are discarded. The daemon does not save session state or copy history;
Pi itself owns the JSONL session files, which the daemon only reads.

## HTTP and WebSocket API

- `GET /health`
- `GET /api/sessions`
- `GET /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/history?limit=60&before=<entryId>`
- `GET /api/sessions/:sessionId/context-telemetry` (numeric Rolling Context metrics from the active branch)
- `POST /api/sessions/:sessionId/messages` with `{ "text": "..." }`
- `POST /api/sessions/:sessionId/abort` to stop the current Pi generation
- `POST /api/sessions/:sessionId/commands` with `{ "name": "...", "args": "..." }`
- `POST /api/sessions/:sessionId/ui/responses` with `{ "version": 1, "uiEpoch": "...", "response": { "id": "...", "value": "..." } }` (or `confirmed: boolean` / `cancelled: true`)
- `WS /internal` for Pi extension clients
- `WS /ws/sessions/:sessionId` for session event streams

The daemon forwards input only to a writable live instance. The first instance
for a session gets write access; additional simultaneously registered
instances are marked non-writable to avoid duplicate input delivery.

The session page renders streamed thinking in a collapsed section, pages
read-only history from the registered session's active branch, and swaps the
Send button for Stop while Pi is generating. Type `/` to filter available
commands; selecting one opens a dialog to edit its arguments and apply it.
Supported extension `ctx.ui.select/confirm/input` calls are displayed both in the
original local TUI and on the session page. Options and full prompt text come from
that same UI call; the daemon has no plugin-specific approval logic. The first valid
response wins once. A remote answer aborts and waits for native dialog cleanup
before the original caller continues. Local answers never wait for a network reply.

The Pi-process broker owns pending prompts; the daemon stores display copies only.
Opening a session page replays its current snapshot. Browser disconnects, daemon
restarts and network failures do not settle local prompts; Pi re-advertises the same
epoch/request IDs on reconnect. There is no default decision timeout. Explicit
caller-provided timeouts retain the native UI behavior. HTTP 202 means queued;
`ui_response_ack` means Pi accepted the UI response, not that business execution
succeeded. Results come from the original tool/message/notification flow.

Design Intent proposals no longer open a web-only review workflow. Send the usual
`/design-intent review|accept|reject` command from either interface; accept/reject
uses the same local confirmation, and Reject's reason stays a command argument.
Design Intent reads the trusted workspace's fixed store without prompting; Rolling
Context checkpoint confirmations use ordinary UI.
Authorization, branch/hash checks and project writes remain in the plugins.

### Compatibility and limits

Pi does not currently expose a public global UI interceptor for its running TUI.
This implementation isolates a compatibility decorator over the mutable shared
UI context, tested against Pi **0.99.1** using its real extension runner and native
selector/input components. Load daemon before UI-producing extensions (the package
manifest does this). Disable with `--remote-ui-proxy false` if another UI decorator
conflicts. Installation failures restore the original methods and report a warning.
RPC/headless contexts are not decorated, and a daemon connection does not create UI.

`custom()` and `editor()` stay local-only and are marked as such on the session page.
The installed native editor has no safe cancellation handle, so offering a remote
answer would leave an orphaned local component. These calls retain local behavior,
including nested UI calls; core dialogs that bypass `ctx.ui` are not intercepted.
Full interactive CLI reload/session-switch and real-browser smoke testing remain
separate delivery checks; this is not a claim of universal TUI mirroring.

Generic `notify/setStatus` calls are mirrored. Notifications are transient, not a
durable business result log. The proxy does not infer plugin status or command
completion from notification text. Generic status values appear right-aligned above the session
composer input. Fast mode is shown only when the neutral shared statusline registry exposes its
visible `[fast mode]` segment; a missing segment remains unknown rather than being reported as off.

The session page retries a missing session while Pi reconnects to the daemon.
Provider and tool errors are shown in the conversation. Commands are dispatched back through Pi's
extension/prompt command expansion rather than executed by the daemon.

### Rolling Context Graph View

Click **Context Graph** in a session header, or open `/s/<sessionId>/context`.
The page plots raw/effective context size with hot→warm/checkpoint markers,
hot/warm/checkpoint/other composition, and working-state bytes over completed turns.
It includes a turn detail table and refreshes every five seconds. No chart dependency,
model call, or duplicate history store is introduced. Rolling Context runs independently
of the daemon.

Tokens are host estimates; missing usage stays unknown rather than zero. Observe-mode
candidate sizes are not applied effective sizes. With no samples the page shows an empty
state. The API shares history's session-root/header-ID checks and only exports typed
numeric/enum fields, not evidence text. An active leaf not yet available on disk returns
409 instead of guessing another branch.
