import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/client";
import { networkProductCommand } from "../src/network-cli";
const directories: string[] = [];
afterEach(async () => {
  for (const p of directories.splice(0)) await rm(p, { recursive: true, force: true });
});
for (const action of ["add", "rotate"]) {
  test(`CLI ${action} preserves its private key even when an older API returns no config`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-pending-"));
    directories.push(dir);
    const file = join(dir, "runtime.conf");
    let sent: unknown;
    const peerId = "01234567-89ab-4cde-8fab-0123456789ab";
    const argument = action === "add" ? "office" : peerId;
    const runtime = new Runtime({
      apiKey: "rt_test",
      baseUrl: "https://api.test",
      maxRetries: 0,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(_input instanceof Request ? _input.url : String(_input));
        expect(url.pathname).toBe(
          action === "add" ? "/v1/tunnel/peers" : `/v1/tunnel/peers/${peerId}:rotate`,
        );
        if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
        sent = JSON.parse(init.body);
        return Response.json({
          tunnel: {
            endpoint: "edge.test:51820",
            subnet: "10.250.0.0/16",
            gatewayPublicKey: null,
            funded: false,
          },
          peer: { name: "office", address: "10.250.0.2" },
          config: null,
          hint: "The gateway is starting.",
        });
      }) as unknown as typeof fetch,
    });
    const logs: string[] = [];
    await networkProductCommand(
      "tunnel",
      ["peer", action, argument],
      { positional: ["peer", action, argument], flags: new Map([["out", [file]]]) },
      { json: false, write: (t) => logs.push(t), error: (t) => logs.push(t) },
      async () => runtime,
    );
    const text = await readFile(file, "utf8");
    const privateKey = text.match(/^PrivateKey = (.*)$/m)![1]!;
    expect(privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(JSON.stringify(sent)).not.toContain(privateKey);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(text).toContain("PublicKey = <gatewayPublicKey from runtime tunnel get>");
    expect(logs.join("\n")).toContain("Keep this file");
    expect(logs.join("\n")).not.toContain("Bring it up with");
  });
}
