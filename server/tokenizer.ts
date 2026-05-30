import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

const enc = new Tiktoken(cl100k_base);

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return enc.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export function countJSONTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return countTokens(value);
  return countTokens(JSON.stringify(value));
}
