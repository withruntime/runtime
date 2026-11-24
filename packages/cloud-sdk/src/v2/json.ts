/** Parsed JSON, read without trusting its shape: each read narrows, and a value of another shape reads as empty. */
export type Json = { [k: string]: unknown };

export const obj = (v: unknown): Json =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
export const strs = (v: unknown): string[] =>
  arr(v).filter((x): x is string => typeof x === "string");
