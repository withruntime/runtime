/** Explicit trial-only checks of changed adapter behavior on fresh sandboxes.
 * Never discovers, resumes or cleans up any pre-existing customer resource. */
import { Runtime } from "../src/client";
import { Sandbox as E2B } from "../src/e2b/code-interpreter";
import { Daytona } from "../src/daytona/index";
import { Sandbox as Vercel } from "../src/vercel/index";
import { SandboxInstance } from "../src/blaxel/index";

if (!process.argv.includes("--run")) {
  console.log(
    "Pass --run to create up to four isolated trial-funded sandboxes, each with a five-minute lease.",
  );
  process.exit(0);
}
if (!process.env.RUNTIME_API_KEY)
  throw new Error("A dedicated RUNTIME_API_KEY test key is required.");
const native = new Runtime();
const usage = await native.usage();
if ((usage.trial?.availableMs ?? 0) < 3_600_000)
  throw new Error("At least one trial hour is required; no paid fallback.");
const ids = new Set<string>();
const create = native.sandboxes.create.bind(native.sandboxes);
native.sandboxes.create = async (input = {}, options) => {
  const sandbox = await create(
    {
      ...input,
      funding: "trial",
      timeoutSeconds: 300,
      labels: { ...input.labels, "compat-run": crypto.randomUUID() },
    },
    options,
  );
  ids.add(sandbox.id);
  if (sandbox.info.funding !== "trial") throw new Error("Sandbox funding was not trial.");
  return sandbox;
};
const config = { client: native, create: { funding: "trial" as const, timeoutSeconds: 300 } };
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
let failed = false;
for (const [name, run] of [
  [
    "e2b",
    async () => {
      const sandbox = await E2B.create({ runtime: config });
      await sandbox.files.write(".env", "CHECK=1");
      assert((await sandbox.files.read(".env")) === "CHECK=1", "E2B dotfile round trip");
      const result = await sandbox.runCode("printf compatibility", { language: "bash" });
      assert(result.logs.stdout.join("") === "compatibility", "E2B Bash interpreter output");
      let change!: () => void;
      const changed = new Promise<void>((resolve) => {
        change = resolve;
      });
      let exit!: (error?: Error) => void;
      const exited = new Promise<void>((resolve, reject) => {
        exit = (error) => (error ? reject(error) : resolve());
      });
      const watch = await sandbox.files.watchDir(
        "/workspace",
        (event) => {
          if (event.name === "watched.txt") change();
        },
        { onExit: exit, timeoutMs: 10_000 },
      );
      try {
        await sandbox.files.write("watched.txt", "changed");
        await Promise.race([
          changed,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Watch received no file event")), 8000),
          ),
        ]);
      } finally {
        await watch.stop();
      }
      await exited;
      await sandbox.kill();
    },
  ],
  [
    "daytona",
    async () => {
      const sandbox = await new Daytona({ withruntime: config }).create();
      await sandbox.fs.uploadFile(Buffer.from("CHECK=1"), ".env");
      const result = await sandbox.process.executeCommand("cat /workspace/.env");
      assert(result.result === "CHECK=1", "Daytona dotfile round trip");
      await sandbox.delete();
    },
  ],
  [
    "vercel",
    async () => {
      const sandbox = await Vercel.create({ withruntime: config });
      await sandbox.fs.writeFile(".env", "CHECK=1");
      assert(
        (await sandbox.fs.readFile(".env", "utf8")) === "CHECK=1",
        "Vercel dotfile round trip",
      );
      await sandbox.fs.writeFile("append", "");
      await Promise.all(
        Array.from({ length: 4 }, (_, n) => sandbox.fs.appendFile("append", `${n}\n`)),
      );
      assert(
        (await sandbox.fs.readFile("append", "utf8")).trim().split("\n").sort().join(",") ===
          "0,1,2,3",
        "Concurrent append lost data",
      );
      const bytes = Buffer.alloc(2 * 1024 * 1024, 255);
      await sandbox.fs.appendFile("binary", bytes);
      assert((await sandbox.fs.readFile("binary")).equals(bytes), "Large binary append differs");
      await sandbox.delete();
    },
  ],
  [
    "blaxel",
    async () => {
      const sandbox = await SandboxInstance.create({ withruntime: config });
      const result = await sandbox.process.exec({
        command: "printf compatibility",
        waitForCompletion: true,
      });
      assert(result.stdout === "compatibility", "Blaxel command output");
      await sandbox.delete();
    },
  ],
] as Array<[string, () => Promise<void>]>) {
  const started = performance.now();
  try {
    await run();
    console.log(`${name}: PASS (${((performance.now() - started) / 1000).toFixed(2)}s)`);
  } catch (error) {
    failed = true;
    console.error(`${name}: FAIL ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const id of [...ids]) {
      try {
        const sandbox = await native.sandboxes.get(id);
        await sandbox.stop();
        ids.delete(id);
      } catch (error) {
        console.error(
          `Cleanup failed for test sandbox ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        failed = true;
      }
    }
  }
}
if (ids.size) {
  failed = true;
  console.error(`Test sandboxes still require cleanup: ${[...ids].join(", ")}`);
}
process.exitCode = failed ? 1 : 0;
