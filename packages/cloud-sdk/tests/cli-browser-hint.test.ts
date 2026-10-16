import { expect, test } from "bun:test";
import { run } from "../src/cli";

// `runtime sandbox browser start` prints the API's hint that heavy apps need
// 2 GiB (engines/machine/ENGINE.md, "A browser's memory"), and no hint line
// when the API sends none.
const ID = "11111111-2222-4333-8444-000000000002";
const HINT = "Heavy apps such as Google Sheets, YouTube and StackBlitz need a 2 GiB sandbox.";
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const SANDBOX = {
  id: ID,
  name: "web",
  kind: "sandbox",
  state: "running",
  funding: "paid",
  region: "us-east",
  vcpu: 1,
  memoryMiB: 1024,
  diskMiB: 4096,
  cpu: "shared",
  timeoutSeconds: 0,
  expiresAt: null,
  endsAt: null,
  labels: {},
};

async function start(extra: Record<string, unknown>) {
  const original = globalThis.fetch;
  const lines: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.endsWith("/browser:start"))
      return Response.json({
        running: true,
        headless: true,
        version: "Chrome/154.0.8037.97",
        cdpUrl: "wss://example.test/devtools/browser/x?token=t",
        httpUrl: "https://example.test",
        headers: {},
        expiresAt: null,
        ...extra,
      });
    return Response.json(SANDBOX);
  }) as typeof fetch;
  try {
    const out = { json: false, write: (s: string) => lines.push(s), error: () => {} };
    expect(await run(["sandbox", "browser", ID, "start"], env, out)).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
  return lines.join("\n");
}

test("browser start prints the hint under 2 GiB", async () => {
  const printed = await start({ memoryMiB: 1024, hint: HINT });
  expect(printed).toContain("CDP: wss://example.test/devtools/browser/x?token=t");
  expect(printed.trimEnd().endsWith(HINT)).toBe(true);
});

test("browser start prints no hint line at 2 GiB", async () => {
  const printed = await start({ memoryMiB: 2048 });
  expect(printed).not.toContain("Heavy apps");
  expect(printed.trimEnd().endsWith("(private; it expires never)")).toBe(true);
});
