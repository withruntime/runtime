/** Opt-in paid acceptance of Runloop disk suspension on one owned resource.
 * Never discovers or changes existing customer sandboxes or host settings. */
import assert from "node:assert/strict";
import { Runtime } from "../src/client";
import { Runloop } from "../src/runloop/index";
import type { Sandbox } from "../src/sandbox";

if (!process.argv.includes("--run") || !process.argv.includes("--approved-budget-1-dollar")) {
  console.log(
    "Pass --run --approved-budget-1-dollar after approval. Creates one paid sandbox capped at $0.10, then removes its persistence.",
  );
  process.exit(0);
}
const key = process.env.RUNTIME_API_KEY;
if (!key?.startsWith("rtcloud_")) throw new Error("An explicit Runtime test key is required.");
const runtime = new Runtime({ apiKey: key, waitForCapacityMs: 0 });
if (BigInt((await runtime.usage()).available) < 100_000n)
  throw new Error("Needs $0.10 available; no credit is purchased.");
let owned: Sandbox | undefined;
const create = runtime.sandboxes.create.bind(runtime.sandboxes);
runtime.sandboxes.create = async (input = {}, options) => {
  if (owned) throw new Error("This runner may create only one sandbox.");
  // ARCHITECTURE.md section 10: normal paid admission and integer lifetime
  // spending limits apply; the test never forces placement or capacity.
  owned = await create(
    {
      ...input,
      name: `compat-runloop-${crypto.randomUUID().slice(0, 8)}`,
      funding: "paid",
      persistent: false,
      timeoutSeconds: 180,
      onLeaseEnd: "stop",
      idlePauseSeconds: 0,
      vcpu: 2,
      memoryMiB: 4096,
      diskMiB: 4096,
      maxCostMicros: 100_000,
      maxTotalCostMicros: 100_000,
    },
    options,
  );
  console.log(JSON.stringify({ created: owned.id }));
  return owned;
};
const failures: unknown[] = [];
try {
  const client = new Runloop({ client: runtime });
  const devbox = await client.devboxes.create();
  assert(owned && devbox.id === owned.id);
  assert.equal(owned.info.funding, "paid");
  await client.devboxes.writeFileContents(devbox.id, {
    file_path: "/workspace/retained.txt",
    contents: "retained across cold boot",
  });
  const process = await owned.spawn(["sleep", "120"]);
  const suspended = await client.devboxes.suspend(devbox.id);
  assert.equal(suspended.status, "suspended");
  await owned.refresh();
  assert.equal(owned.state, "stopped");
  assert.equal(owned.info.persistent, true);
  const resumed = await new Runloop({ client: runtime }).devboxes.resume(devbox.id);
  assert.equal(resumed.status, "running");
  await owned.refresh();
  assert.equal(owned.state, "running");
  assert.equal(
    await client.devboxes.readFileContents(devbox.id, { file_path: "/workspace/retained.txt" }),
    "retained across cold boot",
  );
  assert.equal(
    (await owned.processes.list()).some((entry) => entry.id === process.id),
    false,
  );
  console.log(
    "PASS Runloop: cold restart retains files, drops old process state, and reconnects through a fresh client.",
  );
  await client.devboxes.shutdown(devbox.id);
} catch (error) {
  failures.push(error);
} finally {
  if (owned) {
    try {
      await owned.refresh();
      if (owned.state !== "stopped") await owned.stop();
      assert.equal(owned.state, "stopped");
      if (owned.info.persistent) await owned.update({ persistent: false });
      await owned.refresh();
      assert.equal(owned.info.persistent, false);
      assert.equal(owned.info.heldMicros, 0);
      console.log(
        JSON.stringify({
          id: owned.id,
          state: owned.state,
          persistent: owned.info.persistent,
          chargedMicros: owned.info.chargedMicros,
          heldMicros: owned.info.heldMicros,
        }),
      );
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length)
  throw new AggregateError(failures, "Runloop acceptance failed; check cleanup before retrying.");
