import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/client";
import { networkProductCommand } from "../src/network-cli";
import { generateWireGuardKeyPair } from "../src/wireguard";

/* Custom domains, TCP ports, dedicated addresses and the tunnel: the SDK's
 * paths and bodies against a recording fetch, and the CLI's commands on top.
 * The handlers are tested on Postgres in packages/cloud
 * (network-products-postgres.test.ts). */

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function recorder(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const answer = answers[`${method} ${url.pathname}`] ?? {};
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "https://api.test",
    fetch: fetch as unknown as typeof globalThis.fetch,
    maxRetries: 0,
  });
  return { runtime, calls };
}

function output() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    out: {
      json: false,
      write: (text: string) => lines.push(text),
      error: (text: string) => errors.push(text),
    },
    lines,
    errors,
  };
}
const args = (positional: string[], flags: Record<string, string[]> = {}) => ({
  positional,
  flags: new Map(Object.entries(flags)),
});

test("the SDK's four products call their own paths, never a sandbox's", async () => {
  const { runtime, calls } = recorder({
    "GET /v1/domains": { data: [], nextCursor: null },
    "GET /v1/ports": { data: [], nextCursor: null },
    "GET /v1/addresses": { data: [], nextCursor: null },
  });
  const sandboxId = "11111111-2222-4333-8444-555555555555";
  await runtime.domains.add({ hostname: "app.example.com", sandboxId, port: 3000 });
  await runtime.domains.verify("app.example.com");
  await runtime.domains.list();
  await runtime.domains.remove("app.example.com");
  await runtime.ports.open({ sandboxId, port: 5432 });
  await runtime.ports.list({ sandboxId });
  await runtime.ports.close("p1");
  await runtime.addresses.reserve({ family: 6 });
  await runtime.addresses.list();
  await runtime.addresses.release("a1");
  await runtime.tunnel.create({ subnet: "10.9.0.0/16" });
  await runtime.tunnel.addPeer({ name: "office", publicKey: "k", routes: ["10.0.0.0/16"] });
  await runtime.tunnel.rotatePeer("peer1", { publicKey: "k2" });
  await runtime.tunnel.removePeer("peer1");
  await runtime.tunnel.get();
  await runtime.tunnel.delete();
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "POST /v1/domains",
    "POST /v1/domains/app.example.com:verify",
    "GET /v1/domains",
    "DELETE /v1/domains/app.example.com",
    "POST /v1/ports",
    `GET /v1/ports?sandboxId=${sandboxId}`,
    "DELETE /v1/ports/p1",
    "POST /v1/addresses",
    "GET /v1/addresses",
    "DELETE /v1/addresses/a1",
    "POST /v1/tunnel",
    "POST /v1/tunnel/peers",
    "POST /v1/tunnel/peers/peer1:rotate",
    "DELETE /v1/tunnel/peers/peer1",
    "GET /v1/tunnel",
    "DELETE /v1/tunnel",
  ]);
  expect(calls[0]!.body).toEqual({ hostname: "app.example.com", sandboxId, port: 3000 });
  expect(calls[7]!.body).toEqual({ family: 6 });
  expect(calls[11]!.body).toEqual({ name: "office", publicKey: "k", routes: ["10.0.0.0/16"] });
});

test("runtime tunnel peer add makes the key pair here, sends only the public half, and writes the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rc-cli-tunnel-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { runtime, calls } = recorder({
    "POST /v1/tunnel/peers": {
      tunnel: { endpoint: "203.0.113.10:51820", peers: [], sandboxes: [] },
      peer: { id: "peer1", name: "office", address: "10.250.0.2", routes: [] },
      config:
        "[Interface]\nPrivateKey = <the private key you generated for this peer>\nAddress = 10.250.0.2/32\n",
      hint: "Save config as runtime.conf and run: sudo wg-quick up ./runtime.conf.",
    },
  });
  const { out, errors } = output();
  const path = join(directory, "runtime.conf");
  expect(
    await networkProductCommand(
      "tunnel",
      ["peer", "add", "office"],
      args(["peer", "add", "office"], { route: ["10.0.0.0/16"], out: [path] }),
      out,
      async () => runtime,
    ),
  ).toBe(0);
  const sent = calls[0]!.body as { publicKey: string; name: string; routes: string[] };
  expect(sent).toMatchObject({ name: "office", routes: ["10.0.0.0/16"] });
  expect(sent.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(JSON.stringify(calls)).not.toContain("PrivateKey");
  const file = await readFile(path, "utf8");
  const privateKey = file.match(/^PrivateKey = (.*)$/m)![1]!;
  expect(privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(JSON.stringify(calls)).not.toContain(privateKey);
  expect((await stat(path)).mode & 0o077).toBe(0);
  expect(errors.join("\n")).toContain("wg-quick up");
});

test("a key pair is a real X25519 pair, as wg genkey and wg pubkey make", async () => {
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const pair = generateWireGuardKeyPair();
  const raw = Buffer.from(pair.privateKey, "base64");
  const derived = createPublicKey(
    createPrivateKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        d: raw.toString("base64url"),
        x: Buffer.alloc(32).toString("base64url"),
      },
      format: "jwk",
    }),
  ).export({ format: "jwk" }) as { x: string };
  expect(Buffer.from(derived.x, "base64url").toString("base64")).toBe(pair.publicKey);
});

test("runtime domain add prints the records to set, and runtime port open the address to use", async () => {
  const { runtime } = recorder({
    "POST /v1/domains": {
      hostname: "app.example.com",
      state: "pending",
      records: [
        { type: "TXT", name: "_runtime-challenge.app.example.com", value: "runtime-verify=abc" },
        { type: "CNAME", name: "app.example.com", value: "domains.runtimehost.com" },
      ],
      hint: "Add the TXT record, then verify again.",
    },
    "POST /v1/ports": { connect: "203.0.113.10:23456", hint: "Connect to 203.0.113.10:23456." },
  });
  const domain = output();
  await networkProductCommand(
    "domain",
    ["add"],
    args(["add", "app.example.com", "11111111-2222-4333-8444-555555555555", "3000"]),
    domain.out,
    async () => runtime,
  );
  expect(domain.lines[0]).toContain("_runtime-challenge.app.example.com");
  expect(domain.lines[0]).toContain("domains.runtimehost.com");
  const port = output();
  await networkProductCommand(
    "port",
    ["open"],
    args(["open", "11111111-2222-4333-8444-555555555555", "5432"]),
    port.out,
    async () => runtime,
  );
  expect(port.lines).toEqual(["203.0.113.10:23456"]);
  await expect(
    networkProductCommand(
      "port",
      ["open"],
      args(["open", "x", "99999"]),
      port.out,
      async () => runtime,
    ),
  ).rejects.toMatchObject({ code: "usage" });
});
