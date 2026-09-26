import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { ignores, rules } from "./base.js";

export const next = defineConfig([...nextVitals, ...nextTs, ignores]);

/**
 * The same with the shared rules, for when `apps/web` turns them on.
 *
 * `eslint-config-next` brings its own copy of typescript-eslint and registers
 * the plugin under the same name, and ESLint refuses two plugins of one name
 * unless they are the same object. So its TypeScript half is dropped and ours
 * stands in its place: it is the same preset with more of it turned on.
 */
export const typedNext = defineConfig([
  ...nextVitals.filter((config) => config.name !== "next/typescript"),
  rules,
  ignores,
]);

export default next;
