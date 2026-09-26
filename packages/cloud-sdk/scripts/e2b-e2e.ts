/* End to end, against the real API: the judge panel's E2B project (an agent
   eval that runs each case in a fresh E2B sandbox), copied unmodified, with
   its one import changed from "e2b" to "withruntime/e2b".

     RUNTIME_API_KEY=... bun scripts/e2b-e2e.ts       # run it
     bun scripts/e2b-e2e.ts --dry                     # set up and show the change only

   It creates real sandboxes (six cases, four at a time, 2 vCPU / 512 MiB,
   at most five minutes each, each stopped when its case ends) on whatever
   funding the key's account defaults to: the free trial while it lasts.
   RUNTIME_API_URL points it elsewhere. Not part of `bun test`. */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const repo = join(here, "..", "..");
const fixture = join(repo, "packages", "judge-panel", "fixtures", "e2b");
const dry = process.argv.includes("--dry");

if (!dry && !process.env.RUNTIME_API_KEY) {
  console.error("Set RUNTIME_API_KEY to a Runtime key (a test key), or pass --dry.");
  process.exit(2);
}

function run(command: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

// What a customer installs: the built package, not its sources.
run("bun", ["run", "build"], here);

const work = mkdtempSync(join(tmpdir(), "runtime-e2b-e2e-"));
cpSync(join(fixture, "package.json"), join(work, "package.json"));
cpSync(join(fixture, "evals"), join(work, "evals"), { recursive: true });

const script = join(work, "evals", "run.mjs");
const before = readFileSync(script, "utf8");
const after = before.replace('from "e2b";', 'from "withruntime/e2b";');
const changed = before
  .split("\n")
  .map((line, i) => [line, after.split("\n")[i]] as const)
  .filter(([a, b]) => a !== b);
if (changed.length !== 1) throw new Error(`Expected one changed line, found ${changed.length}.`);
writeFileSync(script, after);
console.log(`Copied ${fixture} to ${work}; the only change:`);
for (const [a, b] of changed) console.log(`- ${a}\n+ ${b}`);

mkdirSync(join(work, "node_modules"), { recursive: true });
symlinkSync(here, join(work, "node_modules", "withruntime"), "dir");

if (dry) {
  console.log("Dry run: not creating sandboxes.");
  process.exit(0);
}
const target = process.env.RUNTIME_API_URL ?? "https://api.withruntime.com";
console.log(`Running the eval against ${target}...`);
const result = spawnSync("node", ["evals/run.mjs"], {
  cwd: work,
  env: { ...process.env, E2B_API_KEY: "" },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
