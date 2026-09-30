# pi-guardrails

A Pi package for permission and safety extensions. New extensions belong under `extensions/`; implementation helpers live outside that resource directory so Pi does not load them as standalone extensions.

## Permissions and tools

The permissions extension replaces Pi's built-in `bash` and `edit` tools under the same names:

- `bash` requires an `intent` summary, which appears in the TUI call display.
- `edit` requires an `intent` summary and a Codex-compatible `apply_patch` document. It supports `Add File`, `Delete File`, `Update File`, `@@` context chunks, `*** End of File`, and `*** Move to`.
- `write` is removed from the model's active tool list; patch `Add File` operations cover normal file creation.
- `read` and `write` calls within the current working directory are allowed without a prompt. Out-of-workspace `read`, `write`, and `edit` paths require approval.

Prefer `edit` for focused changes to existing text files. When creating or rewriting a large amount of content, generating many files, or producing content programmatically, use `bash` instead.

Use `/permissions manual` (default) to ask the user before selected high-risk Bash commands and out-of-workspace file operations, or `/permissions auto` to ask the current model to review them. Each automatic review gets a fresh, isolated request containing only the current operation, intent/arguments, and reason for review—not the session transcript or prior tool results. It must answer exactly `APPROVE`; missing model, errors, or any other response block the operation. Mode resets to `manual` on restart.

High-risk Bash patterns include recursive/force `rm`, `sudo`, disk erase/format, broad `chmod`/`chown`, device writes, `find -delete`, destructive Git operations, and download-pipe-to-shell. This is not a sandbox: shell command checks are pattern-based, and model-provided intent is untrusted input. Other extensions can still perform their own filesystem operations.

The patch parser/applier in `lib/codex-apply-patch.ts` follows the public Codex apply-patch grammar and operations: <https://github.com/openai/codex/tree/main/codex-rs/apply-patch>.

## Load

Try this checkout for one invocation:

```sh
pi -e .
```

Install globally for the current user:

```sh
pi install /home/lemonjuice/Projects/pi-extensions
```

Or install as a project-local package with `pi install . --local`.
