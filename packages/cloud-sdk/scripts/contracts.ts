/* The compatibility contracts: the drop-ins checked against the official
   packages they stand in for, pinned and installed from the public registries.
   Run from the repository's root:

     bun packages/cloud-sdk/scripts/contracts.ts

   CI runs it as a part of its own when a pull request touches what the
   contracts hold (CONTRACT_PATHS; agents/ci.ts). It was GitHub Actions'
   `contracts` job until those minutes ran out (Marc, 15 October 2026). It
   installs only frozen public packages: no service credentials are read and
   no live sandbox runner is invoked. Steps run in order, and the first that
   fails ends the run. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The steps, each a name and its commands, given the scratch folder. */
export function steps(temp: string): [string, string[][]][] {
  const upstreams = join(temp, "upstreams");
  const reference = join(temp, "reference");
  const python = join(temp, "python-reference");
  return [
    [
      "Local compatibility regressions",
      [["bun", "run", "--cwd", "packages/cloud-sdk", "test:compat"]],
    ],
    [
      "Built package exports and declarations",
      [
        ["bun", "run", "--cwd", "packages/cloud-sdk", "build"],
        ["bun", "test", "packages/cloud-sdk/tests/cjs-require.test.ts"],
      ],
    ],
    [
      "Python local contracts and native transport",
      [["bun", "packages/cloud-sdk/scripts/test-python.ts"]],
    ],
    ["Established provider package comparisons", [["bun", "packages/cloud-sdk/oracle/check.mjs"]]],
    [
      "Verify pinned sources and prepare dependency trees",
      [
        ["bun", "packages/cloud-sdk/scripts/prepare-compatibility.ts", upstreams],
        ["bun", "packages/cloud-sdk/tests/compat/prepare-runtime.ts", upstreams, reference],
      ],
    ],
    [
      "New provider package comparisons",
      [
        ["bun", "packages/cloud-sdk/tests/compat/compare-upstream.ts", upstreams, reference],
        ["bun", "packages/cloud-sdk/tests/compat/codesandbox-official.ts", reference],
        ["bun", "packages/cloud-sdk/tests/compat/runloop-snapshots-official.ts", reference],
      ],
    ],
    [
      "Unchanged typed consumers",
      [
        ["bun", "packages/cloud-sdk/tests/compat/check-consumers.ts"],
        ["bun", "packages/cloud-sdk/tests/compat/check-consumers.ts", upstreams],
      ],
    ],
    [
      "Worker execution contract",
      [
        [
          "bun",
          "packages/cloud-sdk/tests/compat/worker-local.ts",
          join(reference, "node_modules/miniflare"),
          reference,
        ],
      ],
    ],
    [
      "Python package comparisons",
      [
        ["python3", "sdks/python/tests/prepare_compatibility.py", python],
        [
          "env",
          "RUNTIME_COMPAT_OFFICIAL=1",
          "PYTHONPATH=sdks/python",
          join(python, "bin/python"),
          "-m",
          "unittest",
          "discover",
          "-s",
          "sdks/python/tests",
          "-p",
          "test_compat_python_official.py",
        ],
      ],
    ],
  ];
}

if (import.meta.main) {
  const temp = mkdtempSync(join(tmpdir(), "runtime-contracts-"));
  let failed: string | undefined;
  try {
    for (const [name, commands] of steps(temp)) {
      const started = Date.now();
      console.log(`\n── ${name}`);
      for (const [command, ...args] of commands) {
        const run = spawnSync(command!, args, { stdio: "inherit" });
        if (run.status !== 0) {
          failed = `${name}: ${[command, ...args].join(" ")} exited ${run.status ?? run.signal}`;
          break;
        }
      }
      if (failed) break;
      console.log(`── ${name}: passed in ${Math.round((Date.now() - started) / 1000)} s`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (failed) {
    console.error(`\nContracts failed at ${failed}`);
    process.exit(1);
  }
  console.log("\nContracts passed.");
}
