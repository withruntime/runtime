import { expect, test } from "bun:test";
import { Sandboxes } from "../src/client";
import { Machine, Machines, type MachineInfo, type MachineProduct } from "../src/machine";
import { Sandbox } from "../src/sandbox";
import type { Call, Transport } from "../src/transport";

/* The machine engine's client (src/machine.ts) is written once for every
   product that runs code: a product names its path and adds what only it
   does. A second product built on it reaches only its own paths, so nothing
   in the shared code is a sandbox in disguise, and the sandbox product still
   reaches /v1/sandboxes through it. */

type ServerInfo = MachineInfo & { kind: "server" };
const SERVERS: MachineProduct = { plural: "servers", noun: "Server" };
class Server extends Machine<ServerInfo, { name?: string }, { id: string }> {
  constructor(t: Transport, info: ServerInfo) {
    super(SERVERS, t, info);
  }
}
class Servers extends Machines<
  Server,
  ServerInfo,
  { name?: string; getOrCreate?: boolean },
  { id: string }
> {
  constructor(t: Transport) {
    super(SERVERS, t, (transport, info) => new Server(transport, info));
  }
}

function recorder(state: MachineInfo["state"] = "running") {
  const calls: Call[] = [];
  const info = {
    id: "m1",
    kind: "server",
    state,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const transport = {
    waitForCapacityMs: 0,
    json: async (call: Call) => {
      calls.push(call);
      if (call.method === "GET" && call.path.endsWith("s"))
        return { data: [info], nextCursor: null };
      if (call.method === "DELETE") return { id: "m1" };
      if (call.path.endsWith(":snapshot")) return { id: "snap1", state: "ready" };
      return info;
    },
  } as unknown as Transport;
  return { calls, transport };
}

test("a second machine product reaches only its own paths through the shared verbs", async () => {
  const { calls, transport } = recorder();
  const servers = new Servers(transport);
  const server = await servers.create({ name: "web" });
  expect(server).toBeInstanceOf(Server);
  await servers.get("m1");
  await servers.getOrCreate("web");
  expect(
    (await (await servers.list({ labels: { app: "web" } })).toArray()).map((s) => s.id),
  ).toEqual(["m1"]);
  await server.refresh();
  await server.waitFor("running");
  await server.update({ name: "api" });
  await server.extend(60);
  await server.setRetention(7);
  await server.switchImage("ubuntu");
  await server.resize({ vcpu: 2 });
  await server.pause();
  await server.wake();
  await server.restart();
  await server.stop();
  await server.snapshot();
  await server.delete();
  await servers.delete("m1");
  expect(await servers.stopAll({ labels: { app: "web" } })).toEqual({
    stopped: ["m1"],
    failed: [],
  });
  const paths = calls.map((call) => `${call.method} ${call.path}`);
  for (const path of paths) expect(path).toMatch(/ \/v1\/(servers|snapshots)\b/);
  expect(paths).toContain("POST /v1/servers");
  expect(paths).toContain("POST /v1/servers/m1:resize");
  expect(paths).toContain("POST /v1/servers/m1:snapshot");
  expect(paths).toContain("DELETE /v1/servers/m1");
});

test("a machine product's refusals name it, not a sandbox", async () => {
  const { transport } = recorder("stopped");
  const servers = new Servers(transport);
  const error = await servers.create({}).catch((e: unknown) => e);
  expect(error).toMatchObject({
    code: "start_failed",
    message: "Server m1 is stopped, not running.",
    hint: "Read it with runtime.servers.get(id); stopReason says why.",
  });
  const none = await servers.stopAll({ labels: {} }).catch((e: unknown) => e);
  expect(none).toMatchObject({
    hint: "Stop one server with server.stop(), or label the ones to stop together.",
  });
});

test("the sandbox product is the engine with its own path and words", async () => {
  const { calls, transport } = recorder("stopped");
  const sandboxes = new Sandboxes(transport);
  const error = await sandboxes.create({}).catch((e: unknown) => e);
  expect(error).toMatchObject({
    message: "Sandbox m1 is stopped, not running.",
    hint: "Read it with runtime.sandboxes.get(id); stopReason says why.",
  });
  const sandbox = await sandboxes.get("m1");
  expect(sandbox).toBeInstanceOf(Sandbox);
  await sandbox.stop();
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "POST /v1/sandboxes",
    "GET /v1/sandboxes/m1",
    "GET /v1/sandboxes/m1",
    "POST /v1/sandboxes/m1:stop",
  ]);
});
