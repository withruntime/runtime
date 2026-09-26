import { expect, test } from "bun:test";
import { run } from "../src/cli";

/* A customer's report, 24 September 2026: `runtime login` said "Connected"
   without saying to which account, so a person with several could not tell
   where their sandboxes would go. It now names the organization. */
test("`runtime login` names the account it connected to", async () => {
  const env = {
    RUNTIME_API_KEY: "rk_cli",
    RUNTIME_API_URL: "http://localhost:4010",
    RUNTIME_AUTH_URL: "http://localhost:4011",
  };
  const original = globalThis.fetch;
  const seen: string[] = [];
  let meAnswers = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    seen.push(path);
    if (path === "/v1/me" && !meAnswers)
      return Response.json({ error: { code: "internal_error", message: "x" } }, { status: 500 });
    if (path === "/v1/me")
      return Response.json({ orgId: "org_1", principalId: "p1", orgName: "Acme" });
    return Response.json({ available: "0", trial: null, data: [] });
  }) as typeof fetch;
  try {
    const lines: string[] = [];
    const out = {
      json: false,
      write: (t: string) => lines.push(t),
      error: (t: string) => lines.push(t),
    };
    expect(await run(["login"], env, out)).toBe(0);
    expect(lines.join("\n")).toBe("Connected to Acme (org_1).");
    expect(seen).toContain("/v1/me");
    // The connection stands when the account cannot be read.
    lines.length = 0;
    meAnswers = false;
    expect(await run(["login"], env, out)).toBe(0);
    expect(lines.join("\n")).toBe("Connected.");
  } finally {
    globalThis.fetch = original;
  }
});
