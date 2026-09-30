const SAFE_SIMPLE_COMMANDS = new Set([
  "pwd", "ls", "rg", "grep", "find", "sed", "awk", "head", "tail", "wc", "cat",
  "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath", "which", "type",
  "file", "stat", "du", "df", "date", "uname", "printf", "echo",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "remote", "tag", "describe", "ls-files",
]);

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\b[^\n]*(?:--recursive|(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*f|(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*r)/i, "recursive/force file deletion"],
  [/(?:^|[;&|()]\s*)\bsudo\b/i, "privileged command"],
  [/\b(?:mkfs(?:\.[\w]+)?|wipefs|shred)\b/i, "disk or secure erase command"],
  [/\b(?:chmod|chown)\b[^\n]*\b(?:777|-R|-r)\b/i, "broad permission or ownership change"],
  [/\bdd\b[^\n]*\bof=\/dev\//i, "direct write to a device"],
  [/\bfind\b[^\n]*\s-delete\b/i, "recursive file deletion"],
  [/\bfind\b[^\n]*\s-exec(?:dir)?\b/i, "find command execution"],
  [/\bgit\s+clean\b[^\n]*-[^\n]*[fd]/i, "deletion of untracked Git files"],
  [/\bgit\s+reset\s+--hard\b/i, "discarding Git changes"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:ba)?sh\b/i, "downloaded code execution"],
];

/** Return undefined only for configured read-only commands in simple, non-composed form. */
export function bashReviewReason(command: string): string | undefined {
  const text = command.trim();
  if (!text) return "empty Bash command";

  const highRisk = HIGH_RISK_PATTERNS.find(([pattern]) => pattern.test(text));
  if (highRisk) return highRisk[1];

  // Composition, redirection, substitutions, and control operators are never allowlisted.
  if (/[;&|><`$()\n]/.test(text)) return "composed or redirected Bash command";

  const match = text.match(/^([\w.-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return "command is not in the safe Bash allowlist";
  const [, executable, rest = ""] = match;
  const name = executable.split(/[\\/]/).at(-1)!.toLowerCase();

  if (name === "git") {
    const subcommand = rest.trim().match(/^(?:-[^\s]+\s+)*([a-z-]+)(?:\s|$)/i)?.[1]?.toLowerCase();
    return subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand)
      ? undefined
      : "Git command is not in the safe read-only allowlist";
  }

  return SAFE_SIMPLE_COMMANDS.has(name) ? undefined : "command is not in the safe Bash allowlist";
}
