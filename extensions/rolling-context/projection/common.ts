import { createHash } from "node:crypto";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const hash = (value: unknown): string => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const tokens = (message: AgentMessage): number => estimateTokens(message);
export const text = (message: AgentMessage): string => typeof message.content === "string"
  ? message.content : Array.isArray(message.content)
    ? message.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
export const textOnly = (message: AgentMessage): boolean => typeof message.content === "string"
  || Array.isArray(message.content) && message.content.every((p: any) => p.type === "text");
export function replaceText(message: AgentMessage, replacement: string): AgentMessage {
  return { ...message, content: typeof message.content === "string" ? replacement : [{ type: "text", text: replacement }] } as AgentMessage;
}
