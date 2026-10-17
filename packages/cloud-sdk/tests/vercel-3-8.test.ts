import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { Runtime } from "../src/client.js";
import { APIError, CommandFinished, Sandbox } from "../src/vercel/index.js";

/* @vercel/sandbox 3.7.0 adds stdin (runCommand's `stdin`, Command.writeStdin
 * and closeStdin); 3.8.0 adds runCommand's `onStart`. The real Runtime
 * transport runs here; only HTTP replies are simulated. No vendor code or
 * live host runs. */

const ID = "11111111-2222-4333-8444-555555555555";
const PROC = `/v1/sandboxes/${ID}/processes`;
const exit = { type: "exit", exitCode: 0, state: "exited", timedOut: false, durationMs: 12 };

function processInfo(stdinOffset = 0) {
  return {
    id: "proc",
    kind: "process",
    state: "running",
    exitCode: null,
    command: "cat",
    cwd: "/workspace",
    pty: false,
    stdinOpen: true,
    stdinOffset,
    startedAt: "2026-10-15T00:00:00Z",
    endedAt: null,
    timeoutMs: null,
    outputBytes: 0,
    firstOffset: 0,
  };
}

function ndjson(events: unknown[]) {
  return new Response(events.map((event) => JSON.stringify(event) + "\n").join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
}

type Write = { base64: string; offset: number; eof?: boolean };

/** A fake process: `cat`. Its output answers once stdin is closed, echoing
 * every byte written. `failWrite` answers a write with an error instead. */
async function fixture(options: { failWrite?: (index: number) => Response | undefined } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const writes: Write[] = [];
  let input = "";
  let closed!: () => void;
  const eof = new Promise<void>((resolve) => (closed = resolve));
  const client = new Runtime({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://vercel-3-8.invalid",
    maxRetries: 0,
    fetch: (async (input_, init) => {
      const request = new Request(input_, init);
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      if (request.method === "GET" && url.pathname === `/v1/sandboxes/${ID}`)
        return Response.json({
          id: ID,
          name: "stdin",
          state: "running",
          onLeaseEnd: "pause",
          labels: {},
          createdAt: "2026-10-15T00:00:00Z",
          expiresAt: "2026-10-15T01:00:00Z",
          timeoutSeconds: 3600,
        });
      calls.push({ method: request.method, path: url.pathname, body });
      if (request.method === "POST" && url.pathname === PROC) return Response.json(processInfo());
      if (request.method === "POST" && url.pathname === `${PROC}/proc:write`) {
        const write = body as Write;
        const failed = options.failWrite?.(writes.length);
        writes.push(write);
        if (failed) return failed;
        input += Buffer.from(write.base64, "base64").toString();
        if (write.eof) closed();
        return Response.json({ offset: Buffer.byteLength(input), process: processInfo() });
      }
      if (request.method === "POST" && url.pathname === `${PROC}/proc:signal`) {
        closed();
        return Response.json({});
      }
      if (request.method === "GET" && url.pathname === `${PROC}/proc/output`) {
        // Bounded, so a regression fails its assertions instead of hanging.
        await Promise.race([eof, Bun.sleep(1000)]);
        return ndjson([{ type: "stdout", data: input, offset: 0 }, exit]);
      }
      throw new Error(`unexpected ${request.method} ${url.pathname}`);
    }) as typeof fetch,
  });
  const box = await Sandbox.get({ name: ID, withruntime: { client } });
  return { box, calls, writes, input: () => input };
}

const spawnBody = (calls: { method: string; path: string; body?: unknown }[]) =>
  calls.find((call) => call.method === "POST" && call.path === PROC)?.body as Record<
    string,
    unknown
  >;

test("3.7 stdin: true keeps a detached command's stdin open for writeStdin and closeStdin, in call order", async () => {
  const f = await fixture();
  const cmd = await f.box.runCommand({ cmd: "cat", stdin: true, detached: true });
  expect(spawnBody(f.calls).stdinMode).toBe("pipe");
  await Promise.all([
    cmd.writeStdin("hello "),
    cmd.writeStdin(new TextEncoder().encode("wörld\n")),
    cmd.writeStdin(""),
    cmd.closeStdin(),
  ]);
  expect(f.writes.map((write) => [write.offset, write.eof ?? false])).toEqual([
    [0, false],
    [6, false],
    [13, true],
  ]);
  const done = await cmd.wait();
  expect(await done.stdout()).toBe("hello wörld\n");
});

test("3.7 stdin: true without detached throws TypeError before anything runs", async () => {
  const f = await fixture();
  const refused = f.box.runCommand({ cmd: "cat", stdin: true });
  await expect(refused).rejects.toBeInstanceOf(TypeError);
  await expect(refused).rejects.toThrow("`stdin: true` requires `detached: true`");
  expect(f.calls).toHaveLength(0);
});

test("3.7 without stdin a command still reads an empty stdin", async () => {
  const f = await fixture();
  await f.box.runCommand({ cmd: "cat", detached: true });
  await f.box.runCommand({ cmd: "cat", stdin: false, detached: true });
  for (const call of f.calls)
    expect((call.body as Record<string, unknown>).stdinMode).toBeUndefined();
});

test("3.7 a finished command refuses writeStdin and closeStdin", async () => {
  const f = await fixture();
  const cmd = await f.box.runCommand({ cmd: "cat", stdin: true, detached: true });
  await cmd.closeStdin();
  const done = await cmd.wait();
  expect(done).toBeInstanceOf(CommandFinished);
  await expect(done.writeStdin("late")).rejects.toThrow(
    "Cannot write to stdin: the command has already finished.",
  );
  await expect(done.closeStdin()).rejects.toThrow(
    "Cannot close stdin: the command has already finished.",
  );
});

test("3.7 a failed write refuses later writes, so nothing lands after a partial one; closeStdin still works", async () => {
  const f = await fixture({
    failWrite: (index) =>
      index === 0
        ? Response.json(
            { error: { code: "internal", message: "lost", status: 500 } },
            { status: 500 },
          )
        : undefined,
  });
  const cmd = await f.box.runCommand({ cmd: "cat", stdin: true, detached: true });
  await expect(cmd.writeStdin("first")).rejects.toBeInstanceOf(APIError);
  await expect(cmd.writeStdin("second")).rejects.toThrow("unknown state");
  expect(f.writes).toHaveLength(1);
  await cmd.closeStdin();
  expect(f.writes.at(-1)?.eof).toBe(true);
});

test("3.7 a write the API rejected whole leaves stdin usable", async () => {
  const f = await fixture({
    failWrite: (index) =>
      index === 0
        ? Response.json(
            { error: { code: "invalid_request", message: "bad input", status: 400 } },
            { status: 400 },
          )
        : undefined,
  });
  const cmd = await f.box.runCommand({ cmd: "cat", stdin: true, detached: true });
  await expect(cmd.writeStdin("first")).rejects.toBeInstanceOf(APIError);
  await cmd.writeStdin("second");
  await cmd.closeStdin();
  expect(await (await cmd.wait()).stdout()).toBe("second");
});

test("3.7 a Readable is piped to an attached command's stdin and closed when it ends", async () => {
  const f = await fixture();
  // autoDestroy off: what is checked is that the pipe itself never destroys it.
  const input = new PassThrough({ autoDestroy: false });
  const seen: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      seen.push(chunk.toString());
      callback();
    },
  });
  const running = f.box.runCommand({ cmd: "cat", stdin: input, stdout });
  input.write("one ");
  input.write("two\n");
  input.end();
  const done = await running;
  expect(spawnBody(f.calls).stdinMode).toBe("pipe");
  expect(done).toBeInstanceOf(CommandFinished);
  expect(done.exitCode).toBe(0);
  expect(await done.stdout()).toBe("one two\n");
  expect(seen.join("")).toBe("one two\n");
  expect(f.writes.at(-1)?.eof).toBe(true);
  expect(input.destroyed).toBe(false);
});

test("3.7 a failing stdin stream kills an attached command and rejects runCommand", async () => {
  const f = await fixture();
  const input = new PassThrough();
  const running = f.box.runCommand({ cmd: "cat", stdin: input });
  input.write("partial");
  await Bun.sleep(20);
  input.destroy(new Error("source broke"));
  await expect(running).rejects.toThrow("source broke");
  await Bun.sleep(20);
  expect(f.calls.some((call) => call.path === `${PROC}/proc:signal`)).toBe(true);
  expect(f.writes.at(-1)?.eof).toBe(true);
});

test("3.7 a detached command's wait() rejects when its stdin stream fails", async () => {
  const f = await fixture();
  const input = new PassThrough();
  const cmd = await f.box.runCommand({ cmd: "cat", stdin: input, detached: true });
  expect(cmd.stdinPipe).not.toBeNull();
  input.destroy(new Error("source broke"));
  await expect(cmd.wait()).rejects.toThrow("source broke");
  expect(cmd.stdinPipe).toBeNull();
});

test("3.7 piping stops quietly when the command no longer accepts input", async () => {
  const f = await fixture({
    failWrite: (index) =>
      index === 0
        ? Response.json(
            { error: { code: "stdin_closed", message: "ended", status: 409 } },
            { status: 409 },
          )
        : undefined,
  });
  const input = new PassThrough();
  const cmd = await f.box.runCommand({ cmd: "cat", stdin: input, detached: true });
  input.write("ignored");
  await cmd.stdinPipe!.done;
  await cmd.closeStdin();
  expect(await (await cmd.wait()).stdout()).toBe("");
});

test("3.8 onStart is called with the running Command and awaited before runCommand resolves", async () => {
  const f = await fixture();
  const order: string[] = [];
  const done = await f.box.runCommand({
    cmd: "cat",
    onStart: async (command) => {
      order.push(`start ${command.cmdId} ${command.exitCode}`);
      await Bun.sleep(10);
      await command.kill();
      order.push("started");
    },
  });
  order.push("resolved");
  expect(order).toEqual(["start proc null", "started", "resolved"]);
  expect(done).toBeInstanceOf(CommandFinished);
  expect(spawnBody(f.calls).stdinMode).toBeUndefined();
});

test("3.7 and 3.8 SandboxUser.runCommand passes stdin and onStart through", async () => {
  const f = await fixture();
  const user = f.box.asUser("agent");
  const cmd = await user.runCommand({ cmd: "cat", stdin: true, detached: true });
  expect(spawnBody(f.calls).stdinMode).toBe("pipe");
  expect(spawnBody(f.calls).argv).toContain("agent");
  await cmd.writeStdin("as user");
  await cmd.closeStdin();
  expect(await (await cmd.wait()).stdout()).toBe("as user");
  let started = "";
  await user.runCommand({
    cmd: "cat",
    stdin: new PassThrough().end(""),
    onStart: (command) => {
      started = command.cmdId;
    },
  });
  expect(started).toBe("proc");
});
