import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DANGEROUS_BASH_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\b[^\n]*(?:--recursive|(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*f|(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*r)/i, "recursive/force file deletion"],
  [/(?:^|[;&|()]\s*)\bsudo\b/i, "privileged command"],
  [/\b(?:mkfs(?:\.[\w]+)?|wipefs|shred)\b/i, "disk or secure erase command"],
  [/\b(?:chmod|chown)\b[^\n]*\b(?:777|-R|-r)\b/i, "broad permission or ownership change"],
  [/\b(?:dd)\b[^\n]*\bof=\/dev\//i, "direct write to a device"],
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    let risk: string | undefined;

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      risk = DANGEROUS_BASH_PATTERNS.find(([pattern]) => pattern.test(command))?.[1];
    } else if (tool?.annotations?.destructiveHint === true) {
      risk = "tool marked as destructive";
    }

    if (!risk) return undefined;

    const summary = event.toolName === "bash"
      ? String(event.input.command ?? "")
      : JSON.stringify(event.input);
    const prompt = `Potentially dangerous operation (${risk})\n\n${event.toolName}: ${summary}\n\nAllow this operation?`;

    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked ${event.toolName}: ${risk} (confirmation unavailable)` };
    }

    const allowed = await ctx.ui.confirm("Permission check", prompt);
    if (!allowed) return { block: true, reason: "Blocked by permission guard" };
    return undefined;
  });
}
