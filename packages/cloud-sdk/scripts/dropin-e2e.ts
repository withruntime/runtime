/* End to end, against the real API: programs written for Daytona's and
   Vercel Sandbox's SDKs, copied unmodified, with their one import changed to
   "withruntime/daytona" or "withruntime/vercel".

     bun scripts/dropin-e2e.ts          # run both
     bun scripts/dropin-e2e.ts --dry    # set up and show the changes only

   The programs: tests/fixtures/daytona-quickstart.mjs (Daytona's quickstart
   and guides) and the judge panel's Vercel Sandbox eval
   (packages/judge-panel/fixtures/vercel-sandbox: six cases, four at a time,
   each in a fresh 2 vCPU sandbox that is stopped when its case ends). They
   use the key in RUNTIME_API_KEY or the one `npx withruntime login` saved, on
   the account's default funding, so this refuses to start unless the free
   trial has an hour left: then every sandbox runs on the trial. Afterwards it
   checks that every sandbox made since it started has ended and ran on the
   trial (another client of the same account can make that check fail). Not
   part of `bun test`. */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "../src/index";

const here = fileURLToPath(new URL("..", import.meta.url));
const repo = join(here, "..", "..");
const dry = process.argv.includes("--dry");

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

/** Copies a program, changes its one import, and links the built package. */
function prepare(files: Array<[string, string]>, script: string, from: string, to: string) {
  const work = mkdtempSync(join(tmpdir(), "runtime-dropin-e2e-"));
  for (const [source, target] of files) cpSync(source, join(work, target), { recursive: true });
  const path = join(work, script);
  const before = readFileSync(path, "utf8");
  const after = before.replace(from, to);
  const changed = before
    .split("\n")
    .map((line, i) => [line, after.split("\n")[i]] as const)
    .filter(([a, b]) => a !== b);
  if (changed.length !== 1)
    throw new Error(`Expected one changed line in ${script}, found ${changed.length}.`);
  writeFileSync(path, after);
  console.log(`\n${script} in ${work}; the only change:`);
  for (const [a, b] of changed) console.log(`- ${a}\n+ ${b}`);
  mkdirSync(join(work, "node_modules"), { recursive: true });
  symlinkSync(pkg, join(work, "node_modules", "withruntime"), "dir");
  return work;
}

// What a customer installs: the compiled package, not its sources. Only the
// entry points these programs load are compiled, so work in progress elsewhere
// in src cannot stop the run.
const pkg = mkdtempSync(join(tmpdir(), "runtime-dropin-pkg-"));
writeFileSync(
  join(pkg, "tsconfig.json"),
  JSON.stringify({
    extends: join(here, "tsconfig.build.json"),
    compilerOptions: { outDir: join(pkg, "dist"), rootDir: join(here, "src") },
    include: [],
    files: ["index.ts", "daytona/index.ts", "vercel/index.ts"].map((file) =>
      join(here, "src", file),
    ),
  }),
);
run(process.execPath, [join(here, "node_modules/typescript/bin/tsc"), "-p", pkg], here);
cpSync(join(here, "package.json"), join(pkg, "package.json"));
symlinkSync(join(here, "node_modules"), join(pkg, "node_modules"), "dir");
const vercel = prepare(
  [
    [join(repo, "packages/judge-panel/fixtures/vercel-sandbox/package.json"), "package.json"],
    [join(repo, "packages/judge-panel/fixtures/vercel-sandbox/evals"), "evals"],
  ],
  "evals/run.mjs",
  'from "@vercel/sandbox";',
  'from "withruntime/vercel";',
);
const daytona = prepare(
  [[join(here, "tests/fixtures/daytona-quickstart.mjs"), "quickstart.mjs"]],
  "quickstart.mjs",
  'from "@daytona/sdk";',
  'from "withruntime/daytona";',
);
if (dry) {
  console.log("\nDry run: not creating sandboxes.");
  process.exit(0);
}

const runtime = new Runtime();
const usage = await runtime.usage();
if (!usage.trial || usage.trial.availableMs < 3_600_000) {
  console.error(
    "The trial has less than an hour left, so sandboxes could fall to paid credit. Not running.",
  );
  process.exit(2);
}
const started = new Date().toISOString();
let failed = false;
for (const [name, cwd, script] of [
  ["Vercel Sandbox eval", vercel, "evals/run.mjs"],
  ["Daytona quickstart", daytona, "quickstart.mjs"],
] as const) {
  console.log(`\n== ${name}`);
  const result = spawnSync("node", [script], {
    cwd,
    env: { ...process.env, VERCEL_TOKEN: "", DAYTONA_API_KEY: "" },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) failed = true;
  if (name === "Daytona quickstart")
    for (const expected of [
      "Hello from TypeScript",
      "0 Hello, World!",
      "[STDOUT]: step one",
      "step two",
    ])
      if (!result.stdout.includes(expected)) {
        console.error(`Missing from the output: ${expected}`);
        failed = true;
      }
}

// Every sandbox made since the start has ended, and all ran on the trial.
const made = (await (await runtime.sandboxes.list({ includeStopped: true })).toArray()).filter(
  (one) => one.info.createdAt >= started,
);
const running = made.filter((one) => one.state !== "stopped" && one.state !== "stopping");
console.log(
  `\n${made.length} sandboxes made, funding ${[...new Set(made.map((one) => one.info.funding))].join(", ")}; ` +
    `${running.length} still live.`,
);
// The account may be shared with other clients, so nothing here stops a
// sandbox: a live one is named for a person to look at.
for (const one of running) console.log(`Still live (this run's, or another client's): ${one.id}`);
if (running.length || made.some((one) => one.info.funding !== "trial")) failed = true;
process.exit(failed ? 1 : 0);
