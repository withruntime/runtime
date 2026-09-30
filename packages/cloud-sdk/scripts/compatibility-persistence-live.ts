/** Opt-in paid lifetime acceptance. Marc approved at most $1 on 29 September
 * 2026. Three sequential new resources, each capped at $0.10 for its life.
 * No host operations, images, snapshots, ports, or existing resource mutations. */
import { Runtime } from "../src/index.js";
import type { Sandbox } from "../src/sandbox.js";
import { CodeSandbox } from "../src/codesandbox/index.js";
import { SpritesClient } from "../src/sprites/index.js";
import { Freestyle } from "../src/freestyle/index.js";

if (!process.argv.includes("--run-approved-one-dollar"))
  throw new Error("Requires explicit approval of the paid test budget.");
if (!process.env.RUNTIME_API_KEY?.startsWith("rtcloud_"))
  throw new Error("Set a Runtime key explicitly; no saved credentials are read.");
const runtime = new Runtime({
  apiKey: process.env.RUNTIME_API_KEY,
  baseUrl: process.env.RUNTIME_API_URL,
  waitForCapacityMs: 0,
});
const tracked = new Map<string, Sandbox>();
const cleaned = new Set<string>();
const failures: unknown[] = [];
let allocations = 0;
const original = runtime.sandboxes.create.bind(runtime.sandboxes);
const run = crypto.randomUUID().slice(0, 8);
// ARCHITECTURE.md section 10: spending limits and ordinary admission remain
// authoritative. Never force placement or change a customer's resource.
runtime.sandboxes.create = async (input = {}, options = {}) => {
  if (++allocations > 3) throw new Error("Paid acceptance allocation cap exceeded.");
  if (input.image || input.snapshot || input.persistent !== true)
    throw new Error("This test covers fresh persistent stock sandboxes only.");
  const sandbox = await original(
    {
      ...input,
      name: input.name ?? `compat-paid-${run}-${allocations}`,
      funding: "paid",
      maxCostMicros: 100_000,
      maxTotalCostMicros: 100_000,
      timeoutSeconds: 300,
      vcpu: 2,
      memoryMiB: 4096,
      diskMiB: 4096,
      idlePauseSeconds: 0,
      onLeaseEnd: "stop",
      labels: { ...input.labels, "compat.acceptance": run },
    },
    options,
  );
  tracked.set(sandbox.id, sandbox);
  if (sandbox.info.funding !== "paid" || !sandbox.info.persistent)
    throw new Error("Allocation did not preserve the approved paid persistence policy.");
  return sandbox;
};
const equal = (actual: unknown, expected: unknown) => {
  if (actual !== expected)
    throw new Error(`Lifetime mismatch: ${String(actual)} != ${String(expected)}`);
};
async function deleted(id: string) {
  const s = tracked.get(id);
  if (!s) throw new Error("Test tried to inspect an unowned resource.");
  await s.refresh();
  equal(s.info.persistent, false);
  equal(s.state, "stopped");
  cleaned.add(id);
}
try {
  if (BigInt((await runtime.usage()).available) < 300_000n)
    throw new Error("The approved test requires $0.30 available; no credit is purchased.");

  const cs = new CodeSandbox(undefined, { client: runtime });
  const sandbox = await cs.sandboxes.create({ title: `compat-cs-${run}` });
  const first = await sandbox.connect();
  await first.fs.writeTextFile(".env", "codesandbox-persisted");
  await first.disconnect();
  await cs.sandboxes.shutdown(sandbox.id);
  const reconnected = await new CodeSandbox(undefined, { client: runtime }).sandboxes.resume(
    sandbox.id,
  );
  const second = await reconnected.connect();
  equal(await second.fs.readTextFile(".env"), "codesandbox-persisted");
  equal(await second.commands.run("printf resumed"), "resumed");
  await second.disconnect();
  await cs.sandboxes.hibernate(sandbox.id);
  await cs.sandboxes.delete(sandbox.id);
  await deleted(sandbox.id);
  console.log("PASS CodeSandbox: fresh client resumes stopped disk; delete releases persistence");

  const sprites = new SpritesClient(undefined, { client: runtime });
  const sprite = await sprites.createSprite(`compat-sprite-${run}`, {
    environment: { PERSISTED: "sprite-env" },
  });
  if (!sprite.id) throw new Error("Sprite create returned no id.");
  await sprite.filesystem("/workspace").writeFile(".env", "sprite-persisted");
  await sprite.restart();
  const spriteAgain = new SpritesClient(undefined, { client: runtime }).sprite(sprite.name);
  equal(await spriteAgain.filesystem("/workspace").readFile(".env", "utf8"), "sprite-persisted");
  equal((await spriteAgain.exec("printf '%s' \"$PERSISTED\"")).stdout, "sprite-env");
  await tracked.get(sprite.id)!.pause();
  await spriteAgain.delete();
  await deleted(sprite.id);
  console.log(
    "PASS Sprites: restart and fresh-client files/environment; delete releases persistence",
  );

  const freestyle = new Freestyle({ client: runtime });
  const { vm } = await freestyle.vms.create({
    slug: `compat-freestyle-${run}`,
    firewall: { rules: [] },
  });
  await vm.fs.writeTextFile("/workspace/.env", "freestyle-persisted");
  await vm.pause();
  const vmAgain = new Freestyle({ client: runtime }).vms.ref(vm.id);
  await vmAgain.start();
  equal(await vmAgain.fs.readTextFile("/workspace/.env"), "freestyle-persisted");
  equal((await vmAgain.exec("printf resumed")).stdout, "resumed");
  await vmAgain.pause();
  await vmAgain.delete();
  await deleted(vm.id);
  console.log("PASS Freestyle: pause/start and fresh-client files; delete releases persistence");
} catch (error) {
  failures.push(error);
} finally {
  for (const s of tracked.values()) {
    if (cleaned.has(s.id)) continue;
    try {
      // Stopping first releases paused memory without waking anything. IDs
      // come only from this run's create responses.
      await s.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await s.update({ persistent: false });
      await s.stop();
      await deleted(s.id);
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length)
  throw new AggregateError(
    failures,
    "Persistent acceptance failed; inspect cleanup errors before retrying.",
  );
console.log(
  `Cleanup verified for ${tracked.size} owned resources; lifetime spend caps total $0.30.`,
);
