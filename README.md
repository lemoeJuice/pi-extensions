# pi-guardrails

A Pi extension package with permission guardrails, Codex-style patch editing, a browser-based remote session daemon, rolling task context, and project-level design intent.

## Included extensions

The `pi` manifest loads these entrypoints:

```text
extensions/permissions/index.ts
extensions/edit/index.ts
extensions/daemon/index.ts
extensions/rolling-context/index.ts
extensions/design-intent/index.ts
```

Helper modules under each extension's `lib/` (or daemon runtime directory) are implementation details, not separate extensions.

### Rolling Context and Design Intent

`/rolling-context status` inspects task memory. Automatic rolling edits are opt-in with `--rolling-context-mode on`; observe mode is the default. The extension preserves source history and uses conservative tool-result capsules/checkpoints, with native compaction retained as fallback. See [`extensions/rolling-context/README.md`](extensions/rolling-context/README.md).

Design Intent stores approved project requirements and decisions in `.pi/design-intent.json`. The fixed file is read by default in a trusted current workspace without prompting (`--design-intent-read false` disables reading). Proposals immediately ask **Accept / Reject / Later** when UI is available: Accept requires exact-diff confirmation before writing; Reject stops the agent workflow and asks for the reason in the next ordinary user message, without writing a reasonless rejection; Later keeps the proposal pending. The file is created only by an explicitly approved commit, not by loading, reading, or proposing. `/design-intent accept|reject` remains available for deferred review. See [`extensions/design-intent/README.md`](extensions/design-intent/README.md).

### Permissions

`/permissions` reports the current mode; `/permissions manual` and `/permissions auto` select the mode for the current Pi session. Mode resets to `manual` on restart.

The extension wraps `bash` and `read` to require a short `intent`, removes the native `write` tool from the active tool set, and reviews operations involving out-of-workspace paths, destructive tools, or Bash commands that cannot be certified by its read-only allowlist. File paths are resolved against the session working directory (including existing symlink targets). Bash policy parsing is a review gate, **not a shell sandbox**.

In manual mode, review prompts let you allow once, switch to auto, or deny. Switching to auto sends the pending operation to the reviewer. Auto review sees only the operation and its intent in an isolated request, not the session transcript. Only the exact verdict `APPROVE` allows the operation; missing models, errors, timeouts, and invalid decisions fail closed. Being outside the workspace or requiring review is not by itself a reason for the reviewer to deny.

### Patch-based `edit`

The extension replaces the native `edit` tool with a tool that accepts exactly `intent` and `patch`. The patch must use Codex `apply_patch` syntax, from `*** Begin Patch` through `*** End Patch`; native `path` / `edits` / `oldText` / `newText` arguments are unsupported. Supported operations include add, delete, update, context hunks, end-of-file markers, and moves. File mutations are queued per working directory. The TUI displays a patch summary; **Ctrl+O** expands the result to show changed lines.

Use `edit` for focused changes to existing text files. Prefer `bash` for large rewrites, many generated files, or programmatic content generation. The parser/applier follows the public grammar and behavior of [OpenAI Codex's apply-patch crate](https://github.com/openai/codex/tree/main/codex-rs/apply-patch).

### Remote daemon

The daemon extension starts the local daemon if it is unavailable, registers the current Pi session, and forwards session events and browser input. The daemon is detached and can remain running after Pi exits. Remote connectivity is optional: connection failures are retried with backoff and do not stop Pi.

Defaults are `PI_REMOTE_HOST=100.64.209.124` and `PI_REMOTE_PORT=4317` (the host is currently configured for this environment). Override either variable in Pi's environment as needed. The extension and daemon must use the same values. The daemon listens on that address; access should be restricted by your network/Tailscale ACLs. Do not bind to a public interface without deliberately adding appropriate access controls. A localhost bind can be exposed through Tailscale Serve, for example:

```sh
PI_REMOTE_HOST=127.0.0.1 pi -e .
tailscale serve http://127.0.0.1:4317
```

The browser UI lists registered sessions, streams live events, shows streamed thinking collapsed, reads history from the active session branch (read-only, paginated), sends messages, aborts generation, and dispatches available Pi commands. Type `/` in the session input to find commands. Only one instance per session is writable; additional live instances are marked non-writable. The daemon does not modify session files or expose a remote shell. Offline session discovery after daemon restart is not implemented.

HTTP API:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `GET` | `/api/sessions` | List registered sessions |
| `GET` | `/api/sessions/:sessionId` | Session details |
| `GET` | `/api/sessions/:sessionId/history?limit=60&before=<entryId>` | Read paginated history |
| `GET` | `/api/sessions/:sessionId/commands` | Get commands from live Pi |
| `POST` | `/api/sessions/:sessionId/messages` | Send `{ "text": "..." }` |
| `POST` | `/api/sessions/:sessionId/abort` | Abort current generation |
| `POST` | `/api/sessions/:sessionId/commands` | Dispatch `{ "name": "...", "args": "..." }` |
| WebSocket | `/ws/sessions` | Session list updates |
| WebSocket | `/ws/sessions/:sessionId` | Session event stream |

Remote command dispatch includes built-in `abort`, `compact`, `thinking`, and `name` controls, as well as commands available in that Pi session. Commands are expanded/dispatched by Pi, not executed by the daemon.

For daemon internals and the wire protocol see [`extensions/daemon/README.md`](extensions/daemon/README.md); the design notes are in [`extensions/daemon/docs/pi-remote-daemon-design.md`](extensions/daemon/docs/pi-remote-daemon-design.md).

## Install and run

Run this checkout:

```sh
pi -e .
```

Install for the current user:

```sh
pi install .
```

Or install in the current project only:

```sh
pi install . --local
```

## Tests

Run the complete policy, patch, Rolling Context, and Design Intent test suite with Node's type stripping:

```sh
node --experimental-strip-types --test test/*.test.mjs
```

`test/config.json` records the model used for manual Pi integration testing; it is not needed to run the automated tests.
