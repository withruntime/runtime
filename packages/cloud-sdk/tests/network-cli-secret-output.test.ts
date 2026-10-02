import { afterEach, expect, test } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../src/client";
import { networkProductCommand } from "../src/network-cli";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup(
  action: "add" | "rotate",
  effect?: () => Promise<void>,
  config = "[Interface]\nPrivateKey = <local>\nAddress = 10.250.0.2/32\n",
) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-cli-secret-"));
  directories.push(directory);
  const path = join(directory, "runtime.conf");
  const messages: string[] = [];
  const sent: unknown[] = [];
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "https://api.test",
    maxRetries: 0,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(init?.body as string));
      await effect?.();
      return Response.json({
        peer: { id: "peer", address: "10.250.0.2" },
        tunnel: {
          endpoint: "edge.test:51820",
          subnet: "10.250.0.0/16",
          gatewayPublicKey: "gateway",
          funded: true,
        },
        config,
        configReady: true,
        hint: "Ready.",
      });
    }) as typeof fetch,
  });
  const run = (output = path) =>
    networkProductCommand(
      "tunnel",
      ["peer", action, "office"],
      { positional: ["peer", action, "office"], flags: new Map([["out", [output]]]) },
      { json: false, write: (text) => messages.push(text), error: (text) => messages.push(text) },
      async () => runtime,
    );
  return { directory, path, messages, sent, run };
}

for (const action of ["add", "rotate"] as const) {
  test(`peer ${action} refuses symlink output before changing the peer`, async () => {
    const kit = await setup(action);
    const victim = join(kit.directory, "victim");
    await writeFile(victim, "existing file", { mode: 0o644 });
    await symlink(victim, kit.path);
    await expect(kit.run()).rejects.toThrow("not a directory or symbolic link");
    expect(kit.sent).toEqual([]);
    expect(await readFile(victim, "utf8")).toBe("existing file");
    expect((await stat(victim)).mode & 0o777).toBe(0o644);
    expect((await lstat(kit.path)).isSymbolicLink()).toBe(true);
  });

  test(`peer ${action} validates an output directory before changing the peer`, async () => {
    const kit = await setup(action);
    await mkdir(kit.path);
    await expect(kit.run()).rejects.toThrow("not a directory or symbolic link");
    await expect(kit.run(join(kit.directory, "missing", "runtime.conf"))).rejects.toThrow();
    expect(kit.sent).toEqual([]);
    expect(await readdir(kit.directory)).toEqual(["runtime.conf"]);
  });

  test(`peer ${action} replaces a shared file privately without touching its hard link`, async () => {
    const kit = await setup(action);
    await writeFile(kit.path, "previous config", { mode: 0o644 });
    const alias = join(kit.directory, "old-link");
    await link(kit.path, alias);
    expect(await kit.run()).toBe(0);
    expect(kit.sent).toHaveLength(1);
    const config = await readFile(kit.path, "utf8");
    const privateKey = config.match(/^PrivateKey = (.*)$/m)![1]!;
    expect(privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect((await stat(kit.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(alias, "utf8")).toBe("previous config");
    expect((await stat(alias)).mode & 0o777).toBe(0o644);
    expect(JSON.stringify(kit.sent)).not.toContain(privateKey);
    expect(kit.messages.join("\n")).not.toContain(privateKey);
    expect((await readdir(kit.directory)).sort()).toEqual(["old-link", "runtime.conf"]);
  });
}

test("a failed peer request preserves the private key without logging it", async () => {
  const kit = await setup("rotate", async () => {
    throw new Error("lost response");
  });
  await expect(kit.run()).rejects.toThrow();
  expect(kit.sent).toHaveLength(1);
  const [recovery] = await readdir(kit.directory);
  expect(recovery).toBeDefined();
  const path = join(kit.directory, recovery!);
  const draft = await readFile(path, "utf8");
  const privateKey = draft.match(/^PrivateKey = (.*)$/m)![1]!;
  expect(privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(kit.messages.join("\n")).toContain(path);
  expect(kit.messages.join("\n")).not.toContain(privateKey);
});

test("a publication failure after rotation preserves a recoverable private draft", async () => {
  let output = "";
  const kit = await setup("rotate", async () => {
    await mkdir(output);
  });
  output = kit.path;
  await expect(kit.run()).rejects.toThrow();
  expect(kit.sent).toHaveLength(1);
  const files = await readdir(kit.directory);
  const recovery = files.find((file) => file.endsWith(".tmp"));
  expect(files).toHaveLength(2);
  expect(recovery).toBeDefined();
  const path = join(kit.directory, recovery!);
  expect(await readFile(path, "utf8")).toMatch(/^PrivateKey = [A-Za-z0-9+/]{43}=$/m);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(kit.messages.join("\n")).toContain(path);
});

for (const config of [
  "[Interface]\nAddress = 10.250.0.2/32\n",
  "[Interface]\nPrivateKey = first\nPrivateKey = second\n",
]) {
  test("an invalid key-row response preserves the generated private recovery draft", async () => {
    const kit = await setup("rotate", undefined, config);
    await expect(kit.run()).rejects.toMatchObject({ code: "invalid_response" });
    expect(kit.sent).toHaveLength(1);
    const files = await readdir(kit.directory);
    expect(files).toHaveLength(1);
    const recovery = files[0]!;
    expect(recovery.endsWith(".tmp")).toBe(true);
    const path = join(kit.directory, recovery);
    const draft = await readFile(path, "utf8");
    const privateKey = draft.match(/^PrivateKey = (.*)$/m)![1]!;
    expect(privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(kit.messages.join("\n")).toContain(path);
    expect(kit.messages.join("\n")).not.toContain(privateKey);
  });
}

test("valid key-row spacing is replaced with the locally generated private key", async () => {
  const kit = await setup(
    "add",
    undefined,
    "[Interface]\n  PrivateKey= <local>\nAddress = 10.250.0.2/32\n",
  );
  expect(await kit.run()).toBe(0);
  const config = await readFile(kit.path, "utf8");
  expect(config).toMatch(/^PrivateKey = [A-Za-z0-9+/]{43}=$/m);
  expect(config).not.toContain("<local>");
  expect(await readdir(kit.directory)).toEqual(["runtime.conf"]);
});
