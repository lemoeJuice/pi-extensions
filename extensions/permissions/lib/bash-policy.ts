const SAFE_SIMPLE_COMMANDS = new Set([
  "pwd", "ls", "rg", "grep", "find", "head", "tail", "wc", "cat",
  "file", "stat", "du", "df", "date", "uname", "printf", "echo",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "describe", "ls-files",
]);

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\b[^\n]*(?:--recursive|(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*f|(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*r)/i, "recursive/force file deletion"],
  [/(?:^|[;&|()]\s*)\bsudo\b/i, "privileged command"],
  [/\b(?:mkfs(?:\.[\w]+)?|wipefs|shred)\b/i, "disk or secure erase command"],
  [/\b(?:chmod|chown)\b[^\n]*\b(?:777|-R|-r)\b/i, "broad permission or ownership change"],
  [/\bdd\b[^\n]*\bof=\/dev\//i, "direct write to a device"],
  [/\bfind\b[^\n]*\s-(?:delete|exec(?:dir)?|ok(?:dir)?|fprint|fprintf|fls)\b/i, "find command can modify files or execute commands"],
  [/\bgit\s+clean\b[^\n]*-[^\n]*[fd]/i, "deletion of untracked Git files"],
  [/\bgit\s+reset\s+--hard\b/i, "discarding Git changes"],
  [/\bgit\b[^\n]*\bpush\b[^\n]*(?:--force(?:-with-lease)?\b|(?:^|\s)-f(?:\s|$)|--delete\b|--mirror\b)/i, "force, deletion, or mirror Git push"],
  [/\bgit\s+(?:diff|log|show)\b[^\n]*--(?:output|ext-diff|textconv)\b/i, "Git output file or external diff execution"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:ba)?sh\b/i, "downloaded code execution"],
];

export interface BashCommandPolicy {
  /** Undefined means the command itself is allowlisted; file operands still require path validation. */
  reviewReason?: string;
  filePaths: string[];
}

function tokenize(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quote) return undefined;
  if (current) tokens.push(current);
  if (!tokens.length) return undefined;
  return tokens;
}

function hasShellControlOperators(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (const char of command) {
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (["$", "`", "\\"].includes(char)) return true;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (/[;&|><`$()\\\n]/.test(char)) return true;
  }
  return false;
}

function pathArguments(name: string, args: string[]): string[] | undefined {
  if (["pwd", "date", "uname", "printf", "echo"].includes(name)) return [];
  if (name === "find") {
    if (args[0]?.startsWith("-")) return undefined;
    const paths: string[] = [];
    for (const arg of args) {
      if (arg === "--") break;
      if (arg.startsWith("-") || arg.startsWith("!")) break;
      paths.push(arg);
    }
    return paths.length ? paths : ["."];
  }
  if (name === "rg" || name === "grep") {
    const paths: string[] = [];
    const valueOptions = name === "rg"
      ? new Set(["-e", "--regexp", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-m", "--max-count", "--max-depth", "-A", "-B", "-C", "--context"])
      : new Set(["-e", "--regexp", "-f", "--file", "--include", "--exclude", "--exclude-dir"]);
    let foundPattern = false;
    let positionalOnly = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (positionalOnly) {
        if (foundPattern && arg !== "-") paths.push(arg);
        else if (!foundPattern) foundPattern = true;
        continue;
      }
      if (arg === "--") {
        positionalOnly = true;
        continue;
      }
      if (valueOptions.has(arg)) {
        const value = args[++i];
        if (value === undefined) return undefined;
        if ((arg === "-f" || arg === "--file") && name === "grep") {
          paths.push(value);
          foundPattern = true;
        } else if (arg === "-e" || arg === "--regexp") {
          foundPattern = true;
        }
        continue;
      }
      if (arg.startsWith("--regexp=") || (name === "rg" && arg.startsWith("-e") && arg.length > 2)) {
        foundPattern = true;
        continue;
      }
      if (name === "grep" && (arg.startsWith("-f") && arg.length > 2)) {
        paths.push(arg.slice(2));
        continue;
      }
      if (arg.startsWith("-") && arg !== "-") {
        const safeFlags = name === "rg"
          ? new Set(["-i", "-n", "-S", "-s", "-v", "-w", "-x", "-F", "-P", "-L", "-l", "-c", "-o", "-H", "-h", "--hidden", "--no-ignore", "--follow"])
          : new Set(["-i", "-n", "-H", "-h", "-r", "-R", "-v", "-w", "-x", "-c", "-l", "-L", "-q", "-s", "-F", "-E", "-P", "-a", "-I"]);
        const combinedFlagChars = name === "rg" ? "inSsvwxFPLlcoHh" : "inHhrRvwx cLlqsFEPaI".replace(/\s/g, "");
        if (arg.startsWith("--")) {
          if (arg.includes("=") && ["--glob", "--type", "--type-not", "--max-count", "--max-depth", "--context", "--include", "--exclude", "--exclude-dir"].some((opt) => arg.startsWith(`${opt}=`))) continue;
          return undefined;
        }
        if (safeFlags.has(arg)) continue;
        if ([...arg.slice(1)].every((flag) => combinedFlagChars.includes(flag))) continue;
        return undefined;
      }
      if (!foundPattern) foundPattern = true;
      else if (arg !== "-") paths.push(arg);
    }
    return paths;
  }
  if (name === "head" || name === "tail") {
    const paths: string[] = [];
    const valueOptions = new Set(["-n", "--lines", "-c", "--bytes"]);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (valueOptions.has(arg)) { i++; continue; }
      if (!arg.startsWith("-") && arg !== "-") paths.push(arg);
    }
    return paths;
  }
  if (["ls", "wc", "cat", "file", "stat", "du", "df"].includes(name)) {
    return args.filter((arg) => !arg.startsWith("-") && arg !== "-");
  }
  return undefined;
}

/** Allow only simple read-only commands; return their file operands for workspace validation. */
export function analyzeBashCommand(command: string): BashCommandPolicy {
  const text = command.trim();
  if (!text) return { reviewReason: "empty Bash command", filePaths: [] };
  const highRisk = HIGH_RISK_PATTERNS.find(([pattern]) => pattern.test(text));
  if (highRisk) return { reviewReason: highRisk[1], filePaths: [] };

  // Reject command composition, redirection, substitutions, escapes, and control operators.
  if (hasShellControlOperators(text)) return { reviewReason: "composed or redirected Bash command", filePaths: [] };
  const tokens = tokenize(text);
  if (!tokens) return { reviewReason: "command syntax is not a simple allowlisted form", filePaths: [] };

  const executable = tokens[0];
  if (executable.includes("/") || executable.includes("\\")) {
    return { reviewReason: "explicit executable path is not in the safe Bash allowlist", filePaths: [] };
  }
  const name = executable.split(/[\\/]/).at(-1)!.toLowerCase();
  const args = tokens.slice(1);
  if (name === "git") {
    const subcommandIndex = args.findIndex((arg) => !arg.startsWith("-"));
    const subcommand = subcommandIndex >= 0 ? args[subcommandIndex].toLowerCase() : "";
    if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      return { reviewReason: "Git command is not in the safe read-only allowlist", filePaths: [] };
    }
    const filePaths = args.slice(subcommandIndex + 1).filter((arg) => !arg.startsWith("-") && arg !== "-");
    return { filePaths };
  }

  if (!SAFE_SIMPLE_COMMANDS.has(name)) return { reviewReason: "command is not in the safe Bash allowlist", filePaths: [] };
  const filePaths = pathArguments(name, args);
  if (!filePaths) return { reviewReason: "command arguments cannot be safely classified", filePaths: [] };
  return { filePaths };
}
