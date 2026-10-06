import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Custom JSON Schema annotation used only for package-internal capability checks. */
export const CONTRACT_FIELD = "x-pi-guardrails-contract";

export const EDIT_PATCH_CONTRACT = "pi-guardrails.edit-patch.v1";
export const PERMISSION_READ_CONTRACT = "pi-guardrails.read-intent.v1";
export const DESIGN_INTENT_PROJECTION_CONTRACT = "design-intent.projection.v1";
export const DESIGN_INTENT_READ_CONTRACT = "design-intent.read-projection.v1";

type ContractSchema = Record<string, unknown>;
type ContractLocation = "parameters" | "outputSchema";

interface RegisteredTool {
  name: string;
  parameters?: unknown;
  outputSchema?: unknown;
}

interface ToolRegistry {
  getAllTools(): RegisteredTool[];
}

export function markContract<T extends ContractSchema>(schema: T, contract: string): T {
  Object.defineProperty(schema, CONTRACT_FIELD, {
    value: contract,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return schema;
}

export function contractOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const contract = (value as ContractSchema)[CONTRACT_FIELD];
  return typeof contract === "string" ? contract : undefined;
}

/** Validate after runtime binding (e.g. session_start), never in an extension factory. */
export function requireToolContract(
  pi: ExtensionAPI | ToolRegistry,
  consumer: string,
  toolName: string,
  expected: string,
  location: ContractLocation = "parameters",
): void {
  const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`[PI_GUARDRAILS_DEPENDENCY_MISSING] ${consumer} requires tool ${toolName} (${expected})`);
  }
  const actual = contractOf(tool[location]);
  if (actual !== expected) {
    throw new Error(`[PI_GUARDRAILS_DEPENDENCY_INCOMPATIBLE] ${consumer} requires ${toolName} ${expected}; found ${actual ?? "no contract marker"}`);
  }
}

/** Runtime-only: absence is allowed, but a discovered incompatible provider is an error. */
export function checkOptionalToolContract(
  pi: ExtensionAPI | ToolRegistry,
  consumer: string,
  toolName: string,
  expected: string,
  location: ContractLocation = "parameters",
): boolean {
  const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
  if (!tool) return false;
  const actual = contractOf(tool[location]);
  if (actual !== expected) {
    throw new Error(`[PI_GUARDRAILS_DEPENDENCY_INCOMPATIBLE] ${consumer} discovered ${toolName} with ${actual ?? "no contract marker"}; expected ${expected}`);
  }
  return true;
}
