import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Shared ignores for every workspace package.
 * Mirrors the defaults of eslint-config-next, which are dropped when a
 * package supplies its own globalIgnores.
 */
export const ignores = globalIgnores([
  ".next/**",
  "out/**",
  "build/**",
  "dist/**",
  ".turbo/**",
  "next-env.d.ts",
  /* Files that arrived whole and are served as they came: Aside's own page,
     kept as a local reference, and the two demo chromes built into public by
     `demo:build`, which are bundles rather than source. */
  "**/public/aside/**",
  "**/public/browser-demo/**",
  "**/public/browser-demo-classic/**",
  "**/public/browser-chrome/**",
]);

/**
 * The rules, apart from the ignores, so that a package whose source sits where
 * the shared ignores hide it can take the rules and draw its own boundary.
 *
 * Most of these need the type checker, which is the whole point: the syntactic
 * set cannot see that a promise was dropped. `projectService` hands each file
 * the tsconfig an editor would hand it, found upwards from the file, so a
 * package needs no wiring past turning this on.
 *
 * A rule is here because it catches something that would go wrong at run time.
 * A rule that only rearranges working code is not worth the diff, and one that
 * is wrong more often than it is right is worse than no rule, because the way
 * to keep it green is to stop reading it. What was tried and dropped is
 * written down below rather than forgotten, so nobody tries it twice.
 */
export const rules = defineConfig([
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      /* A promise nobody waits for runs beside the code that made it. That is
         how `gn gen` came to start three seconds before the file it reads
         existed, and reading a timestamp in a log is how it was found. */
      "@typescript-eslint/no-floating-promises": "error",
      /* The same mistake where the dropping is invisible: an async function
         handed to something that expects a synchronous one. */
      "@typescript-eslint/no-misused-promises": "error",
      /* `await` on a value that is not a promise is either a leftover or a
         misreading of what the function gives back. */
      "@typescript-eslint/await-thenable": "error",
      /* Rejecting with something that is not an Error throws away the message
         and the stack, and every handler above is written for an Error. */
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      /* `import type` keeps a type-only import from becoming a runtime import.
         Under `isolatedModules` each file is transpiled alone, so the emitter
         cannot work out on its own which imports to drop. */
      "@typescript-eslint/consistent-type-imports": "error",
      /* An unused argument that names what the caller passes is documentation,
         so a leading underscore is how one is kept. */
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      /* Off, and here is what it cost to find that out.

         `require-await` reported 187 times across these packages and found
         nothing. Every one was a synchronous body under an async signature
         that something else owns — a fixture, a fake, an in-memory store, a
         route loader — where `async` is how the contract is met and having
         nothing to await is the point. The rule cannot see the contract, so
         it is wrong every time it fires here. */
      "@typescript-eslint/require-await": "off",
      /* `no-unnecessary-condition` reported 180 times and paid for itself
         once: most of those were `noUncheckedIndexedAccess` missing from the
         type floor, so every guard on a row a query might not return read as
         dead. With that fixed it still reported 65, and none of those were
         defects either. They are three kinds and none of them is fixable: a
         flag set inside a closure, which TypeScript's narrowing does not
         follow; a check standing behind an `as`, which decides its own
         answer; and a guard against a library whose types are more confident
         than the library is, where `step.toolResults ?? []` is the line
         between working and a crash. Turning it on means deleting those or
         suppressing them one at a time, and both are worse than not asking. */
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  {
    /* Where React is. Two halves of one rule: hooks are called in the same
       order every render, and a hook is told everything it reads, or it goes
       on using the render it first saw. */
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    /* Tests, where two of the rules above answer Bun's type declarations
       rather than the tests.

       `expect(...).rejects.toThrow()` gives back a promise and has to be
       awaited, and `bun-types` declares it `void`, so `await-thenable` calls
       every one of those a mistake — 106 of them, all correct. `expect.any`
       and the other matchers are declared `any`, which is what the unsafe
       family is for. Both hold in source, where together they report nothing,
       which is the other half of why they are worth keeping. */
    files: ["**/*.test.ts", "**/*.test.tsx", "**/tests/**"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    /* Config files and scripts that no tsconfig covers. */
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);

/**
 * Ignores and no rules. What a package uses while something else is being
 * drawn in it; swapping this one line for `typed` turns the rules on.
 */
export const base = defineConfig([ignores]);

/** Ignores and the rules. */
export const typed = defineConfig([ignores, rules]);

export default base;
