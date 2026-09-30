# pi-guardrails

A Pi package for permission and safety extensions. Each extension lives in its own directory under `extensions/`, so more guardrails can be added without turning the package entrypoint into a monolith.

## Included: permissions

`extensions/permissions/` asks for confirmation before selected high-risk operations:

- Bash commands matching destructive patterns (`rm` recursive/force, `sudo`, disk erase/format, broad `chmod`/`chown`, and `dd` writes to devices).
- Non-bash tools explicitly marked with `destructiveHint: true`.

If confirmation is needed but no UI is available (for example, print/JSON mode), the operation is blocked. This is a lightweight guardrail, not a sandbox: it does not parse every shell syntax or guarantee detection of every dangerous operation. Review tool behavior and command substitutions carefully.

## Load

From this checkout, try it for one run:

```sh
pi -e .
```

Or install locally for the current project:

```sh
pi install . --local
```

Pi discovers the extension through the package manifest. To load only the permission extension, use a package resource filter in settings or load the file directly:

```sh
pi --extension ./extensions/permissions/index.ts
```

## Add another extension

Create a directory such as `extensions/my-feature/index.ts`; the manifest's `./extensions/**/*.ts` pattern includes it. Keep extension-specific documentation and tests alongside that extension when needed.
