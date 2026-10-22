import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* exec's traceFiles: the SDK sends it only when asked, and gives `files` on
   the result however the command ran: a short exec, a streamed one, one whose
   stream the server ended and the SDK followed, and a spawned process. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const info = { id: ID, kind: "sandbox", state: "running", status: "active", labels: {} };
const files = {
  read: ["/workspace/src/", "/workspace/src/a.test.ts", "/workspace/src/a.ts"],
  written: ["/workspace/out.txt"],
  truncated: false,
};
const ndjson = (lines: unknown[]) =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
const exit = { type: "exit", exitCode: 0, state: "exited", timedOut: false };
const proc = { id: "p1", command: "bun test", state: "exited", exitCode: 0, startedAt: "x" };

function runtime(
  sent: { method: string; path: string; body: Record<string, unknown> }[],
  resumed = false,
) {
  const answer = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    sent.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith(":exec")) {
      if (!body.stream)
        return Response.json({
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          ...(body.traceFiles ? { files } : {}),
        });
      return ndjson([
        { type: "start", processId: "p1" },
        resumed
          ? { type: "continue", processId: "p1", cursor: 0 }
          : { ...exit, ...(body.traceFiles ? { files } : {}) },
      ]);
    }
    if (url.pathname.endsWith("/processes/p1/output")) return ndjson([exit]);
    if (url.pathname.endsWith("/processes/p1/files")) return Response.json(files);
    if (url.pathname.endsWith("/processes")) return Response.json({ ...proc, state: "running" });
    return Response.json(info);
  };
  return new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: (async (input: string, init: RequestInit = {}) =>
      answer(input, init)) as unknown as typeof fetch,
  });
}

test("traceFiles is sent only when asked, and files come back on the result", async () => {
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const sbx = await runtime(sent).sandboxes.get(ID);
  expect((await sbx.exec("bun test", { traceFiles: true })).files).toEqual(files);
  expect(sent.at(-1)!.body.traceFiles).toBe(true);
  const plain = await sbx.exec("bun test");
  expect(plain.files).toBeUndefined();
  expect(sent.at(-1)!.body.traceFiles).toBeUndefined();
  expect((await sbx.exec("bun test", { traceFiles: true, onStdout: () => {} })).files).toEqual(
    files,
  );
});

test("a stream the server ended is followed, and its files read from the process", async () => {
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const sbx = await runtime(sent, true).sandboxes.get(ID);
  const result = await sbx.exec("bun test", { traceFiles: true, onStdout: () => {} });
  expect(result.files).toEqual(files);
  expect(sent.map((r) => r.path).at(-1)).toBe(`/v1/sandboxes/${ID}/processes/p1/files`);
});

test("a spawned process traces its files and reads them once it ends", async () => {
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const sbx = await runtime(sent).sandboxes.get(ID);
  const process = await sbx.spawn("bun test", { traceFiles: true });
  expect(sent.at(-1)!.body.traceFiles).toBe(true);
  expect(await process.files()).toEqual(files);
});

test("the CLI writes what the command read and wrote to --trace-files", async () => {
  const { run } = await import("../src/cli");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const target = `${await mkdtemp(`${tmpdir()}/trace-`)}/files.json`;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(new Request(input, init).url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    sent.push({ method: init.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith(":exec"))
      return ndjson([
        { type: "start", processId: "p1" },
        { ...exit, files },
      ]);
    return Response.json(info);
  }) as unknown as typeof fetch;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    const code = await run(
      ["sandbox", "exec", ID, "--trace-files", target, "--", "bun", "test"],
      { RUNTIME_API_KEY: "rk", RUNTIME_API_URL: "https://api.example.test" },
      { json: false, write: () => {}, error: () => {} },
    );
    expect(code).toBe(0);
  } finally {
    process.stdout.write = write;
    globalThis.fetch = original;
  }
  expect(sent.find((r) => r.path.endsWith(":exec"))!.body.traceFiles).toBe(true);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(files);
});
