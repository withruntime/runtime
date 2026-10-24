import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { ignores, rules } from "./base.js";

/**
 * Style warns, and never blocks (Marc, 22 October 2026: lint and formatting
 * aren't worth blocking anything). The recommended rules that tidy working
 * code rather than catch a bug are warnings, which a check shows in its
 * summary; the rest stay errors. Only rules `eslint-config-next/typescript`
 * already runs are named: a rule that needs type information, turned on here,
 * would fail every file instead.
 */
const styleWarns = {
  rules: {
    "@typescript-eslint/ban-ts-comment": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-namespace": "warn",
    "@typescript-eslint/no-empty-object-type": "warn",
    "@typescript-eslint/no-require-imports": "warn",
    "@typescript-eslint/no-this-alias": "warn",
    "@typescript-eslint/no-unnecessary-type-constraint": "warn",
    "@typescript-eslint/no-unsafe-function-type": "warn",
    "@typescript-eslint/no-wrapper-object-types": "warn",
    "@typescript-eslint/prefer-as-const": "warn",
    "@typescript-eslint/prefer-namespace-keyword": "warn",
    "@typescript-eslint/triple-slash-reference": "warn",
    "@typescript-eslint/no-extra-non-null-assertion": "warn",
    "@typescript-eslint/no-array-constructor": "warn",
    "@typescript-eslint/no-unused-expressions": "warn",
    "@typescript-eslint/no-unused-vars": "warn",
    "prefer-const": "warn",
    "no-var": "warn",
    "prefer-rest-params": "warn",
    "prefer-spread": "warn",
  },
};

export const next = defineConfig([...nextVitals, ...nextTs, ignores, styleWarns]);

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
