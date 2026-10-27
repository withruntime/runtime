import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { onFakeClock } from "./fixtures/fake-clock";

onFakeClock();

/* `runtime browsers` and `runtime desktops` against a stub API: what each
   command sends, and that a screenshot lands in the file named. */

const BROWSER = "44444444-4444-4444-8444-444444444444";
const DESKTOP = "55555555-5555-4555-8555-555555555555";
type Sent = { method: string; path: string; body: unknown };

async function withStub(
  routes: (sent: Sent) => unknown,
  work: (lines: string[], sent: Sent[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const call = {
      method: request.method,
      path: url.pathname,
      body: text ? JSON.parse(text) : undefined,
    };
    sent.push(call);
    const answer = await routes(call);
    if (answer instanceof Response) return answer;
    if (answer === undefined)
      return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    return Response.json(answer);
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    await work(lines, sent);
  } finally {
    globalThis.fetch = original;
  }
}
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const out = (lines: string[]) => ({
  json: false,
  write: (t: string) => lines.push(t),
  error: (t: string) => lines.push(`ERR ${t}`),
});

test("the help lists browsers and desktops, and each has its own", async () => {
  const lines: string[] = [];
  expect(await run(["help"], env, out(lines))).toBe(0);
  expect(lines.join("\n")).toMatch(/^ {2}browsers /m);
  expect(lines.join("\n")).toMatch(/^ {2}desktops /m);
  for (const product of ["browsers", "desktops"]) {
    const own: string[] = [];
    expect(await run([product, "help"], env, out(own))).toBe(0);
    expect(own[0]).toStartWith(`runtime ${product} <command>`);
  }
});

test("browsers create sends its settings and prints the id and the CDP address", async () => {
  await withStub(
    ({ method, path }) =>
      method === "POST" && path === "/v1/browsers"
        ? { id: BROWSER, state: "running", cdpUrl: "wss://cdp.example.test/x" }
        : undefined,
    async (lines, sent) => {
      expect(
        await run(["browsers", "create", "--memory", "4096", "--visible"], env, out(lines)),
      ).toBe(0);
      expect(sent[0]!.body).toEqual({ memoryMiB: 4096, headless: false });
      expect(lines.join("\n")).toBe(`${BROWSER}\nwss://cdp.example.test/x`);
    },
  );
});

test("browsers screenshot opens the URL and writes the image to --out", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "shot-")), "home.png");
  await withStub(
    ({ path }) =>
      path === `/v1/browsers/${BROWSER}:screenshot`
        ? {
            url: "https://withruntime.com/",
            title: "Runtime",
            status: 200,
            mimeType: "image/png",
            bytes: 3,
            width: 1280,
            height: 800,
            base64: Buffer.from("png").toString("base64"),
          }
        : undefined,
    async (lines, sent) => {
      expect(
        await run(
          ["browsers", "screenshot", BROWSER, "https://withruntime.com", "--out", file, "--full"],
          env,
          out(lines),
        ),
      ).toBe(0);
      expect(sent[0]!.body).toEqual({ url: "https://withruntime.com", fullPage: true });
      expect(readFileSync(file, "utf8")).toBe("png");
      expect(lines).toContain(`Saved ${file} (3 bytes).`);
    },
  );
});

test("browsers run starts a run, prints each step as it comes, saves its pages and ends with the answer", async () => {
  const RUN = "66666666-6666-4666-8666-666666666666";
  const dir = join(mkdtempSync(join(tmpdir(), "run-")), "frames");
  let stepsRead = 0;
  const route = (state: string, extra: Record<string, unknown>) => (sent: Sent) => {
    if (sent.method === "POST" && sent.path === "/v1/browsers/runs")
      return { id: RUN, state: "queued", steps: 0 };
    if (sent.path === `/v1/browsers/runs/${RUN}/steps`)
      return stepsRead++ === 0
        ? {
            data: [
              { n: 0, seq: 2, url: "https://example.com/", goal: "Open it", frame: "anBn" },
              { n: 1, seq: 3, url: "https://example.com/", goal: "Read the title", frame: null },
            ],
            after: 3,
            ended: false,
          }
        : { data: [], after: 3, ended: true };
    if (sent.path === `/v1/browsers/runs/${RUN}`) return { id: RUN, state, ...extra };
    return undefined;
  };
  await withStub(route("done", { output: "Example Domain" }), async (lines, sent) => {
    expect(
      await run(
        [
          "browsers",
          "run",
          "Find the title",
          "--url",
          "https://example.com",
          "--max-steps",
          "5",
          "--domain",
          "example.com",
          "--frames",
          dir,
        ],
        env,
        out(lines),
      ),
    ).toBe(0);
    expect(sent[0]!.body).toEqual({
      task: "Find the title",
      startUrl: "https://example.com",
      maxSteps: 5,
      allowedDomains: ["example.com"],
    });
    expect(lines).toContain("ERR Step 0: Open it (https://example.com/)");
    expect(lines).toContain("ERR Step 1: Read the title (https://example.com/)");
    expect(lines.at(-1)).toBe("Example Domain");
    expect(readFileSync(join(dir, "step-000.jpg"), "utf8")).toBe("jpg");
  });
  stepsRead = 0;
  await withStub(
    route("failed", { error: "Store your key as the egress secret ANTHROPIC_API_KEY." }),
    async (lines) => {
      expect(await run(["browsers", "run", "Find", "the", "title"], env, out(lines))).toBe(1);
      expect(lines.at(-1)).toBe(
        `ERR The run failed: Store your key as the egress secret ANTHROPIC_API_KEY. (${RUN})`,
      );
    },
  );
});

test("desktops open and screenshot go to the desktop's own routes", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "shot-")), "screen.png");
  await withStub(
    ({ method, path }) => {
      if (method === "POST" && path === `/v1/desktops/${DESKTOP}:act`) return { ok: true };
      if (path === `/v1/desktops/${DESKTOP}:screenshot`) return new Response("screen");
      return undefined;
    },
    async (lines, sent) => {
      expect(
        await run(["desktops", "open", DESKTOP, "https://withruntime.com"], env, out(lines)),
      ).toBe(0);
      expect(sent[0]!.body).toEqual({ action: "open", url: "https://withruntime.com" });
      expect(await run(["desktops", "screenshot", DESKTOP, "--out", file], env, out(lines))).toBe(
        0,
      );
      expect(readFileSync(file, "utf8")).toBe("screen");
    },
  );
});
