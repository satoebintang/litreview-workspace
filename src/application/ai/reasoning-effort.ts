import { DomainError } from "@/domain/errors";

export const AI_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

const AI_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(AI_REASONING_EFFORTS);

function isAiReasoningEffort(value: string): value is AiReasoningEffort {
  return AI_REASONING_EFFORT_SET.has(value);
}

export function parseAiReasoningEffort(value: unknown): AiReasoningEffort {
  if (value === undefined || value === null || value === "") return "low";
  if (typeof value === "string" && isAiReasoningEffort(value)) return value;
  throw new DomainError("VALIDATION_ERROR", "Reasoning effort must be one of: none, minimal, low, medium, high, xhigh");
}