# Permissions

Permission mode belongs to the **current session**, not the project or all sessions.
New sessions and forks default to `manual`. Ordinary operations certified by the
classifier do not prompt; triggered operations require a user choice in manual
mode or a model verdict in auto mode. Auto is not unrestricted access.

## Switching to auto

After choosing **Switch to auto**, a second ordinary `ctx.ui.select` asks:

- **This TUI run only**: keep auto in Pi-process memory for this session. Switching
  away and back, tree navigation and extension reload preserve it; quitting Pi
  discards it. No session configuration entry is written.
- **Persist for this session**: append a versioned `permissions.config.v1` custom
  entry to Pi's session log. Resuming this session after restarting restores it.
  It is not sent to the model and does not change project files or other sessions.

The current operation still receives model review. Cancelling the scope prompt,
changing session during confirmation, failing to save, or having no reviewer model
does not execute the operation. Both dialogs use the same generic UI proxy when
available, with no default human-decision timeout.

## Commands

```text
/permissions                 Show mode and scope
/permissions auto            Ask run-only vs persistent session scope
/permissions auto run        Explicit run-only setting
/permissions auto session    Explicit persistent session setting
/permissions manual          Save manual for this session (run-only if ephemeral)
/permissions manual run      Temporarily override a saved auto setting
/permissions manual session  Persistently revoke auto
```

Choosing run-only does not erase an older saved preference. For example, `manual
run` temporarily overrides saved auto; the next Pi process restores saved auto.
Use `manual session` to revoke that saved setting. Without UI, auto requires an
explicit `run` or `session` argument; it does not invent an answer.

Persistence is unavailable with `--no-session`. Pi only writes a new session file
once it contains a user/assistant message: early configuration entries stay in
memory until then. Invalid/future saved configuration restores manual with a
diagnostic. Preferences are session-wide, so navigating `/tree` cannot resurrect
an older auto setting; copied entries belonging to another session are ignored.

If writing fails, the current run falls back to manual and attempts a compensating
manual entry. The error asks the operator to verify saved state before resuming;
the extension does not claim an uncertain write was durable.
