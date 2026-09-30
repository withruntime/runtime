/** Explicit live acceptance: run only after reviewing the trial-only policy below.
 * No image builds, provider calls, paid persistence, snapshots, or public previews. */
import { Runtime } from "../../src/index.js";
import { Runloop } from "../../src/runloop/index.js";
import { CodeSandbox } from "../../src/codesandbox/index.js";
import { SpritesClient } from "../../src/sprites/index.js";
import { Freestyle } from "../../src/freestyle/index.js";
import { getSandbox } from "../../src/cloudflare/index.js";
import type { Sandbox } from "../../src/sandbox.js";

export async function liveAcceptance() {
  if (!process.argv.includes("--run"))
    throw new Error("Live execution requires --run after review.");
  if (!process.env.RUNTIME_API_KEY?.startsWith("rtcloud_"))
    throw new Error(
      "Set RUNTIME_API_KEY explicitly; no saved or vendor credentials accepted by this test.",
    );
  const runtime = new Runtime({
    apiKey: process.env.RUNTIME_API_KEY,
    baseUrl: process.env.RUNTIME_API_URL ?? "https://api.withruntime.com",
    waitForCapacityMs: 0,
  });
  const usage = await runtime.usage();
  if (!usage.trial || usage.trial.availableMs < 3_600_000)
    throw new Error("At least one trial hour must remain before this test.");
  const original = runtime.sandboxes.create.bind(runtime.sandboxes);
  const tracked = new Map<string, Sandbox>();
  let allocations = 0;
  runtime.sandboxes.create = async (input = {}, options = {}) => {
    if (++allocations > 6) throw new Error("Live acceptance allocation cap exceeded.");
    if (input.image || input.snapshot)
      throw new Error("Image and snapshot allocation excluded from this trial smoke test.");
    const s = await original(
      {
        ...input,
        name: `compat-acceptance-${Date.now()}-${allocations}`,
        funding: "trial",
        persistent: false,
        timeoutSeconds: 300,
        vcpu: 2,
        memoryMiB: 4096,
        diskMiB: 4096,
        idlePauseSeconds: 0,
        onLeaseEnd: "stop",
        labels: { ...input.labels, "compat.acceptance": "trial-only" },
      },
      options,
    );
    tracked.set(s.id, s);
    if (s.info.funding !== "trial") {
      await s.stop();
      throw new Error("Server did not allocate trial funding");
    }
    return s;
  };
  const check = (actual: unknown, expected: unknown) => {
    if (actual !== expected)
      throw new Error(`Acceptance mismatch: ${String(actual)} != ${String(expected)}`);
  };
  const failures: unknown[] = [];
  try {
    const runloop = new Runloop({ client: runtime });
    const devbox = await runloop.devboxes.create({
      environment_variables: { COMPAT_VALUE: "reconnect" },
    });
    check(
      (await runloop.devboxes.executeSync(devbox.id, { command: "printf '%s' \"$COMPAT_VALUE\"" }))
        .stdout,
      "reconnect",
    );
    await runloop.devboxes.writeFileContents(devbox.id, {
      file_path: "/workspace/result.txt",
      contents: "runloop",
    });
    check(
      await runloop.devboxes.readFileContents(devbox.id, { file_path: "/workspace/result.txt" }),
      "runloop",
    );
    await runloop.devboxes.shutdown(devbox.id);
    console.log("Runloop: create/env/exec/files/shutdown");

    const codesandbox = new CodeSandbox(undefined, { client: runtime });
    const sb = await codesandbox.sandboxes.create();
    const connection = await sb.connect();
    await connection.fs.writeTextFile(".env", "codesandbox");
    check(await connection.fs.readTextFile(".env"), "codesandbox");
    check(await connection.commands.run("printf codesandbox"), "codesandbox");
    await connection.disconnect();
    await codesandbox.sandboxes.delete(sb.id);
    console.log(
      "CodeSandbox: create/session/dotfile/command/delete; trial override excludes persistence",
    );

    const sprites = new SpritesClient(undefined, { client: runtime });
    const sprite = await sprites.createSprite(`sprite-${Date.now()}`, {
      environment: { COMPAT_VALUE: "sprites" },
    });
    check((await sprite.exec("printf '%s' \"$COMPAT_VALUE\"")).stdout, "sprites");
    await sprite.filesystem("/workspace").writeFile(".env", "sprites");
    check(await sprite.filesystem("/workspace").readFile(".env", "utf8"), "sprites");
    await sprite.delete();
    console.log("Sprites: create/env/exec/dotfile/delete; trial override excludes persistence");

    const freestyle = new Freestyle({ client: runtime });
    const { vm } = await freestyle.vms.create({ firewall: { rules: [] } });
    check((await vm.exec("printf freestyle")).stdout, "freestyle");
    await vm.fs.writeTextFile("/workspace/.env", "freestyle");
    check(await vm.fs.readTextFile("/workspace/.env"), "freestyle");
    await vm.delete();
    console.log("Freestyle: create/exec/files/delete; trial override excludes persistence");

    const cf = getSandbox(runtime, `cf-${Date.now()}`);
    check((await cf.exec("printf cloudflare")).stdout, "cloudflare");
    await cf.writeFile(".env", "cloudflare");
    const file = await cf.readFile(".env");
    check(file.content, "cloudflare");
    await cf.destroy();
    console.log("Cloudflare: create/exec/files/destroy; no Worker binding verification");
  } catch (error) {
    failures.push(error);
  } finally {
    for (const sandbox of tracked.values()) {
      try {
        await sandbox.refresh();
        if (sandbox.state !== "stopped") await sandbox.stop();
      } catch (error) {
        failures.push(error);
        try {
          await sandbox.stop();
        } catch (stopError) {
          failures.push(stopError);
        }
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "Live acceptance or cleanup failed");
}
if (import.meta.main) await liveAcceptance();
