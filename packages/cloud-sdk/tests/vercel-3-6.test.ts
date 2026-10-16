import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Runtime } from "../src/client.js";
import { Drive, NotSupportedError, Sandbox } from "../src/vercel/index.js";

const ID = "11111111-2222-4333-8444-555555555555";
const exit = { type: "exit", exitCode: 0, state: "exited", timedOut: false, durationMs: 12 };
const out = (data: string, offset: number) => ({ type: "stdout", data, offset });
const err = (data: string, offset: number) => ({ type: "stderr", data, offset });

/** Actual Runtime transport; only HTTP replies are simulated. No vendor code
 * or live host runs here. One-byte chunks exercise split UTF-8 and JSON. */
function stream(events: unknown[], ending: "end" | "cut" | "partial" = "end") {
  const bytes = new TextEncoder().encode(
    events.map((event) => JSON.stringify(event) + "\n").join("") +
      (ending === "partial" ? '{"type":"stdout","data":"unfinished' : ""),
  );
  let cursor = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cursor < bytes.length) controller.enqueue(bytes.slice(cursor, ++cursor));
        else if (ending === "cut") controller.error(new TypeError("connection interrupted"));
        else controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

async function fixture(reply: (request: Request, index: number) => Response) {
  const calls: Request[] = [];
  const client = new Runtime({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://vercel-3-6.invalid",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(url.hostname).toBe("vercel-3-6.invalid");
      if (request.method === "GET" && url.pathname === `/v1/sandboxes/${ID}`)
        return Response.json({
          id: ID,
          name: "recovery",
          state: "running",
          onLeaseEnd: "pause",
          labels: {},
          createdAt: "2026-10-08T00:00:00Z",
          expiresAt: "2026-10-08T01:00:00Z",
          timeoutSeconds: 3600,
        });
      calls.push(request);
      return reply(request, calls.length - 1);
    }) as typeof fetch,
  });
  const box = await Sandbox.get({ name: ID, withruntime: { client } });
  return { box, calls };
}

for (const ending of ["end", "cut", "partial"] as const) {
  test(`3.6 command recovery: ${ending}, split UTF-8, no command replay or duplicate output`, async () => {
    const f = await fixture((request, index) => {
      const url = new URL(request.url);
      if (index === 0) {
        expect(request.method).toBe("POST");
        expect(url.pathname).toBe(`/v1/sandboxes/${ID}:exec`);
        return stream([{ type: "start", processId: "proc" }, out("é", 0), err("€", 2)], ending);
      }
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe(`/v1/sandboxes/${ID}/processes/proc/output`);
      expect(url.searchParams.get("cursor")).toBe("5");
      return stream([out("😀", 5), exit]);
    });
    const written: string[] = [];
    const writer = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });
    const result = await f.box.runCommand({ cmd: "work-once", stdout: writer, stderr: writer });
    expect(result.cmdId).toBe("proc");
    expect(result.exitCode).toBe(0);
    expect(await result.stdout()).toBe("é😀");
    expect(await result.stderr()).toBe("€");
    expect(await result.output()).toBe("é€😀");
    expect(written.join("")).toBe("é€😀");
    expect(f.calls).toHaveLength(2);
  });
}

for (const lost of ["reported", "offset gap"] as const) {
  test(`3.6 recovery refuses missing attached output (${lost}) instead of returning success`, async () => {
    const f = await fixture((_request, index) =>
      index === 0
        ? stream([{ type: "start", processId: "proc" }, out("first", 0)])
        : stream([
            ...(lost === "reported" ? [{ type: "truncated", droppedBytes: 5, resumeAt: 10 }] : []),
            out("tail", 10),
            exit,
          ]),
    );
    await expect(f.box.runCommand({ cmd: "work-once" })).rejects.toMatchObject({
      name: "StreamError",
      code: "output_truncated",
      sessionId: "proc",
    });
    expect(f.calls).toHaveLength(2);
    expect(f.calls.filter((request) => request.method === "POST")).toHaveLength(1);
  });
}

test("3.6 Drive.get is refused before credentials, fetch or allocation, naming Runtime volumes", () => {
  let fetched = false;
  try {
    Drive.get!({
      name: "existing-drive",
      token: "vercel-token-must-not-be-used",
      fetch: () => {
        fetched = true;
      },
    });
    throw new Error("Drive.get should refuse");
  } catch (error) {
    expect(error).toBeInstanceOf(NotSupportedError);
    expect(error).toMatchObject({ code: "not_supported" });
    expect((error as NotSupportedError).alternative).toContain("runtime.volumes");
  }
  expect(fetched).toBe(false);
});

for (const method of ["logs", "wait"] as const) {
  test(`3.6 detached ${method} resumes at the byte cursor after a broken response`, async () => {
    const f = await fixture((request, index) => {
      expect(request.method).toBe("GET");
      const url = new URL(request.url);
      if (index === 0)
        return Response.json({
          id: "proc",
          command: "work-once",
          cwd: "/workspace",
          state: "running",
          startedAt: "2026-10-08T00:00:00Z",
          exitCode: null,
        });
      expect(url.pathname).toBe(`/v1/sandboxes/${ID}/processes/proc/output`);
      expect(url.searchParams.get("cursor")).toBe(index === 1 ? "0" : "2");
      return index === 1 ? stream([out("é", 0)], "cut") : stream([err("€", 2), exit]);
    });
    const command = await f.box.getCommand("proc");
    if (method === "logs")
      expect(await Array.fromAsync(command.logs())).toEqual([
        { stream: "stdout", data: "é" },
        { stream: "stderr", data: "€" },
      ]);
    else {
      const finished = await command.wait();
      expect(finished.exitCode).toBe(0);
      expect(await finished.output()).toBe("é€");
    }
    expect(f.calls).toHaveLength(3);
  });
}

test("3.6 recovery gives up on repeated empty streams without replaying the command", async () => {
  const f = await fixture((_request, index) =>
    stream(index === 0 ? [{ type: "start", processId: "proc" }] : []),
  );
  await expect(f.box.runCommand({ cmd: "work-once" })).rejects.toMatchObject({
    code: "connection_error",
  });
  expect(f.calls).toHaveLength(5);
  expect(f.calls.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("3.6 recovery propagates permanent server errors without reconnecting or replaying", async () => {
  const f = await fixture(() =>
    stream([
      { type: "start", processId: "proc" },
      { type: "error", error: { status: 403, code: "forbidden", message: "not yours" } },
    ]),
  );
  await expect(f.box.runCommand({ cmd: "work-once" })).rejects.toMatchObject({
    name: "APIError",
    code: "forbidden",
  });
  expect(f.calls).toHaveLength(1);
});
