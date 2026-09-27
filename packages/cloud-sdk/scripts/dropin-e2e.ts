/* End to end, against the real API: programs written for Daytona's, Vercel
   Sandbox's and Blaxel's SDKs, copied unmodified, with their one import changed
   to "withruntime/daytona", "withruntime/vercel" or "withruntime/blaxel".

     bun scripts/dropin-e2e.ts                 # run them all
     bun scripts/dropin-e2e.ts --only blaxel   # one of vercel, daytona, blaxel
     bun scripts/dropin-e2e.ts --dry           # set up and show the changes only

   The programs: tests/fixtures/daytona-quickstart.mjs (Daytona's quickstart
   and guides), the judge panel's Vercel Sandbox eval
   (packages/judge-panel/fixtures/vercel-sandbox: six cases, four at a time,
   each in a fresh 2 vCPU sandbox that is stopped when its case ends), and
   tests/fixtures/blaxel-quickstart.mjs and blaxel-previews.mjs (Blaxel's
   guides). The Blaxel run then times a new sandbox's first command through
   the adapter and through withruntime itself, five times each. They use the
   key in RUNTIME_API_KEY or the one `npx withruntime login` saved, on the
   account's default funding, so this refuses to start unless the free trial
   has an hour left: then every sandbox runs on the trial. BL_API_KEY is set to
   a Blaxel-shaped key, which the adapter must never send. Afterwards it checks
   that every sandbox made since it started has ended and ran on the trial
   (another client of the same account can make that check fail). Not part of
   `bun test`. */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "../src/index";

const here = fileURLToPath(new URL("..", import.meta.url));
const repo = join(here, "..", "..");
const dry = process.argv.includes("--dry");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
const wanted = (name: string) => only === undefined || only === name;

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
    files: ["index.ts", "daytona/index.ts", "vercel/index.ts", "blaxel/index.ts"].map((file) =>
      join(here, "src", file),
    ),
  }),
);
run(process.execPath, [join(here, "node_modules/typescript/bin/tsc"), "-p", pkg], here);
cpSync(join(here, "package.json"), join(pkg, "package.json"));
symlinkSync(join(here, "node_modules"), join(pkg, "node_modules"), "dir");
const programs: Array<[string, string, string, string[]]> = [];
if (wanted("vercel")) {
  const vercel = prepare(
    [
      [join(repo, "packages/judge-panel/fixtures/vercel-sandbox/package.json"), "package.json"],
      [join(repo, "packages/judge-panel/fixtures/vercel-sandbox/evals"), "evals"],
    ],
    "evals/run.mjs",
    'from "@vercel/sandbox";',
    'from "withruntime/vercel";',
  );
  programs.push(["Vercel Sandbox eval", vercel, "evals/run.mjs", []]);
}
if (wanted("daytona")) {
  const daytona = prepare(
    [[join(here, "tests/fixtures/daytona-quickstart.mjs"), "quickstart.mjs"]],
    "quickstart.mjs",
    'from "@daytona/sdk";',
    'from "withruntime/daytona";',
  );
  programs.push([
    "Daytona quickstart",
    daytona,
    "quickstart.mjs",
    ["Hello from TypeScript", "0 Hello, World!", "[STDOUT]: step one", "step two"],
  ]);
}
if (wanted("blaxel")) {
  for (const [name, fixture, expected] of [
    [
      "Blaxel quickstart",
      "blaxel-quickstart.mjs",
      [
        "Sandbox created:  my-sandbox",
        "exit code 0",
        "Hello, World!",
        'LOG: "Starting process"',
        "Stdout: Output 5",
        "build failed",
        "long-task completed",
        "read {}",
        "ls docs,src,uploads config.json,package.json",
        "binary 4",
        "after rm config.backup.json,package.json",
      ],
    ],
    [
      "Blaxel previews and forks",
      "blaxel-previews.mjs",
      [
        "second server running",
        '"path":"/"',
        "path: '/api/health'",
        '8080 {"path":"/eight","port":"8080"',
        "snapshots my-snapshot 1",
        "fork my-sandbox-copy",
        "fork from snapshot my-sandbox-copy true",
        "fork envs: staging 1 3000",
      ],
    ],
  ] as const) {
    const work = prepare(
      [[join(here, "tests/fixtures", fixture), fixture]],
      fixture,
      'from "@blaxel/core";',
      'from "withruntime/blaxel";',
    );
    programs.push([name, work, fixture, [...expected]]);
  }
}
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
for (const [name, cwd, script, expected] of programs) {
  console.log(`\n== ${name}`);
  const result = spawnSync("node", [script], {
    cwd,
    env: {
      ...process.env,
      VERCEL_TOKEN: "",
      DAYTONA_API_KEY: "",
      BL_API_KEY: "bl_never_sent_0000",
      BL_WORKSPACE: "never-used",
    },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) failed = true;
  for (const line of expected)
    if (!result.stdout.includes(line)) {
      console.error(`Missing from the output: ${line}`);
      failed = true;
    }
}

// A new sandbox's first command, through the Blaxel adapter and through
// withruntime itself: five of each, alternating, on the same key and default
// sizes (Blaxel's 4096 MB is Runtime's default too).
if (wanted("blaxel")) {
  const work = mkdtempSync(join(tmpdir(), "runtime-blaxel-speed-"));
  mkdirSync(join(work, "node_modules"), { recursive: true });
  symlinkSync(pkg, join(work, "node_modules", "withruntime"), "dir");
  writeFileSync(
    join(work, "speed.mjs"),
    `import { SandboxInstance } from "withruntime/blaxel";
import { Runtime } from "withruntime";
const runtime = new Runtime();
const adapter = [], plain = [];
for (let i = 0; i < 5; i++) {
  let start = performance.now();
  const sandbox = await SandboxInstance.create();
  const done = await sandbox.process.exec({ command: "echo ok", waitForCompletion: true });
  adapter.push(performance.now() - start);
  if (done.stdout !== "ok\\n") throw new Error("adapter: " + JSON.stringify(done));
  await sandbox.delete();
  start = performance.now();
  const sbx = await runtime.sandboxes.create();
  const result = await sbx.exec("echo ok");
  plain.push(performance.now() - start);
  if (result.stdout !== "ok\\n") throw new Error("plain: " + JSON.stringify(result));
  await sbx.stop({ wait: false });
}
const median = (xs) => [...xs].sort((a, b) => a - b)[2].toFixed(0);
console.log("create to first command, ms (adapter):", adapter.map((x) => x.toFixed(0)).join(" "), "median", median(adapter));
console.log("create to first command, ms (withruntime):", plain.map((x) => x.toFixed(0)).join(" "), "median", median(plain));
`,
  );
  console.log("\n== Blaxel adapter speed");
  const result = spawnSync("node", ["speed.mjs"], {
    cwd: work,
    env: { ...process.env, BL_API_KEY: "bl_never_sent_0000" },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) failed = true;
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
