# pi-guardrails

A Pi extension package with separate permission-management and patch-editing extensions:

```text
extensions/
├── permissions/
│   └── index.ts
└── edit/
    ├── index.ts
    └── lib/codex-apply-patch.ts
test/
├── config.json
└── codex-apply-patch.test.mjs
```

The package manifest explicitly lists extension entrypoints, so helper modules under `lib/` are imported by their extension and are not loaded as separate plugins.

## Permissions extension

`extensions/permissions/index.ts` owns `/permissions manual|auto`, wraps `bash` and `read` with required `intent` summaries, and removes the native `write` tool from the model's active tool set. Read calls show the intent and path; read results are collapsed to a line count with a short expandable preview. Paths for `read`, `write`, and `edit` are resolved against the current working directory, including existing symlink targets. In-workspace paths pass without a prompt; out-of-workspace paths and paths whose scope cannot be verified go to manual confirmation or the auto reviewer. A small read-only Bash command allowlist passes directly; composed, mutating, unknown, or high-risk commands go through review. The allowlist is in `extensions/permissions/lib/bash-policy.ts`; these checks are policy gates, not a shell sandbox.

`manual` is the default mode and shows a concise confirmation with the intent, operation, target/command, and reason. `auto` asks the current model to judge the actual intent and operation in an isolated single-turn request at fixed `low` reasoning; it receives no session transcript or prior tool results. Being outside the workspace or not allowlisted is not itself an automatic denial—the operation is sent to review. Only the exact response `APPROVE` allows it. Missing models, timeouts, errors, and malformed decisions deny by default. The mode resets to `manual` on restart.

## Edit extension

`extensions/edit/index.ts` replaces the native `edit` tool under the same name. It requires `intent` and `patch`; the native `path` / `edits` / `oldText` / `newText` argument shape is explicitly unsupported. The patch must be a Codex-compatible `apply_patch` document. Supported operations include `Add File`, `Delete File`, `Update File`, `@@` context chunks, `*** End of File`, and `*** Move to`. The TUI shows a compact operation summary and actual changed lines; the result is capped and expandable instead of echoing the entire patch.

Prefer `edit` for focused changes to existing text files. When creating or rewriting large amounts of content, generating many files, or producing content programmatically, use `bash` instead. The tool renderer displays the intent and patch preview.

The parser/applier follows the public grammar and application behavior in [OpenAI Codex's apply-patch crate](https://github.com/openai/codex/tree/main/codex-rs/apply-patch).

## Test

Run parser and filesystem tests with:

```sh
node --experimental-strip-types --test test/*.test.mjs
```

`test/config.json` records the model for manual Pi integration testing (`openai/gpt-6-luna`).

## Load

Try this checkout:

```sh
pi -e .
```

Install globally for the current user:

```sh
pi install /home/lemonjuice/Projects/pi-extensions
```

Or install for one project with `pi install . --local`.
