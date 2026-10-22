import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Everything the npm, PyPI, Go and Java packages ship is public: no internal
// host name, no person's name and no commit hash may be in a comment.
const root = resolve(import.meta.dir, "../../..");
const dirs = ["packages/cloud-sdk/src", "sdks/python/withruntime", "sdks/go", "sdks/java/src"];
const leaks: [string, RegExp][] = [
  ["internal host name", /\bvin-\d+\b/],
  ["person's name", /\bMarc\b/],
  ["commit hash", /\((?:[0-9a-f]{9,40})\)/],
  ["agent instruction file", /\b(?:AGENTS|ROOT)\.md\b/],
];
/** A customer's AGENTS.md named as data, in a string (`runtime agents init`
 * reads the repo's own, as Codex and others do), is no leak; anywhere else,
 * a comment included, it is. */
const DATA_ALLOWED = new Set(["agent instruction file"]);
const strings = /"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|py|go|java|sh)$/.test(name)) yield path;
  }
}

describe("published sources", () => {
  test("carry no internal names", () => {
    const found: string[] = [];
    for (const dir of dirs) {
      for (const file of files(join(root, dir))) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            for (const [what, re] of leaks) {
              const read = DATA_ALLOWED.has(what) ? line.replace(strings, '""') : line;
              if (re.test(read)) found.push(`${file.slice(root.length + 1)}:${i + 1} ${what}`);
            }
          });
      }
    }
    expect(found).toEqual([]);
  });
});
