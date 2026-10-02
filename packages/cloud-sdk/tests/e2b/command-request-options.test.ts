/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { Commands, CommandHandle, pidOf, type SandboxContext } from "../../src/e2b/commands";
import { Sandbox, Process } from "../../src/sandbox";
import { Sandbox as E2BSandbox } from "../../src/e2b/sandbox";
import type { Runtime } from "../../src/client";
import { Transport } from "../../src/transport";
import type { ProcessInfo, SandboxInfo } from "../../src/types";

const info = {
  id: "request-process",
  state: "running",
  stdinOpen: true,
  stdinOffset: 0,
  outputBytes: 0,
  command: "cat",
  cwd: "/workspace",
  pty: false,
} as ProcessInfo;
function fixture(handler?: (request: Request) => Promise<Response>) {
  const calls: string[] = [];
  const transport = new Transport({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://fixture.invalid",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      if (handler) return handler(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/output"))
        return new Response('{"type":"exit","exitCode":0,"state":"exited","timedOut":false}\n');
      if (path.endsWith("/processes")) return Response.json({ data: [info] });
      if (path.endsWith(":write")) return Response.json({ offset: 1 });
      if (request.method === "POST") return Response.json({});
      return Response.json(info);
    }) as typeof fetch,
  });
  const ctx: SandboxContext = {
    runtime: new Sandbox(transport, { id: "sandbox" } as SandboxInfo),
    ensureHome: async () => {},
  };
  return { calls, commands: new Commands(ctx), transport };
}

test("pre-cancelled E2B requests never list, start, attach, signal or write", async () => {
  const { commands, calls } = fixture();
  const signal = AbortSignal.abort(new Error("cancelled"));
  for (const work of [
    () => commands.list({ signal }),
    () => commands.run("cat", { signal }),
    () => commands.connect(pidOf(info.id), { signal }),
    () => commands.kill(pidOf(info.id), { signal }),
    () => commands.sendStdin(pidOf(info.id), "x", { signal }),
    () => commands.closeStdin(pidOf(info.id), { signal }),
  ])
    await expect(work()).rejects.toThrow("cancelled");
  expect(calls).toEqual([]);
});

test("cancelling lookup aborts its HTTP request and prevents stdin mutation", async () => {
  const controller = new AbortController();
  let opened!: () => void;
  const started = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let stopped = false;
  const { commands, calls } = fixture(async (request) => {
    opened();
    return new Promise<Response>((_, reject) =>
      request.signal.addEventListener(
        "abort",
        () => {
          stopped = true;
          reject(request.signal.reason);
        },
        { once: true },
      ),
    );
  });
  const pending = commands.sendStdin(pidOf(info.id), "x", { signal: controller.signal });
  const outcome = pending.catch((error: unknown) => error);
  await started;
  controller.abort(new Error("cancelled"));
  expect(await outcome).toBeInstanceOf(Error);
  expect(stopped).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEndWith("/processes");
});

test("one deadline covers process lookup before kill; zero and invalid values are distinct", async () => {
  const { commands, calls } = fixture(
    async (request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      }),
  );
  await expect(commands.kill(pidOf(info.id), { requestTimeoutMs: 10 })).rejects.toBeInstanceOf(
    Error,
  );
  expect(calls).toHaveLength(1);
  const immediate = fixture();
  expect(await immediate.commands.list({ requestTimeoutMs: 0 })).toHaveLength(1);
  for (const requestTimeoutMs of [-1, NaN, 0.5])
    await expect(immediate.commands.list({ requestTimeoutMs })).rejects.toMatchObject({
      name: "InvalidArgumentError",
    });
  expect(immediate.calls).toHaveLength(1);
});

test("a process that exits between listing and kill reports false", async () => {
  const { commands } = fixture(async (request) =>
    new URL(request.url).pathname.endsWith("/processes")
      ? Response.json({ data: [info] })
      : Response.json({ error: { code: "not_found", message: "gone" } }, { status: 404 }),
  );
  expect(await commands.kill(pidOf(info.id))).toBe(false);
});

test("a synthetic pid collision refuses mutation instead of killing another command", async () => {
  // These distinct strings have the same FNV-1a hash used by the adapter.
  expect(pidOf("costarring")).toBe(pidOf("liquid"));
  const { commands, calls } = fixture(async () =>
    Response.json({
      data: [
        { ...info, id: "costarring" },
        { ...info, id: "liquid" },
      ],
    }),
  );
  await expect(commands.kill(pidOf("costarring"))).rejects.toThrow("More than one");
  expect(calls).toHaveLength(1);
});

test("handle stdin and EOF respect cancelled request options", async () => {
  const { transport, calls } = fixture();
  const handle = new CommandHandle(new Process(transport, "sandbox", info), {
    stdin: true,
    timeoutMs: 0,
  });
  const signal = AbortSignal.abort(new Error("cancelled"));
  await expect(handle.sendStdin("x", { signal })).rejects.toThrow("cancelled");
  await expect(handle.closeStdin({ signal })).rejects.toThrow("cancelled");
  await handle.wait();
  expect(calls.filter((call) => call.includes(":write"))).toEqual([]);
});

test("cancelled home preparation never starts a command and can be retried", async () => {
  let links = 0;
  let starts = 0;
  const transport = new Transport({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://fixture.invalid",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith(":exec")) {
        links++;
        if (links === 1)
          return new Promise<Response>((_, reject) =>
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            }),
          );
        return Response.json({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
      }
      if (path.endsWith("/output"))
        return new Response('{"type":"exit","exitCode":0,"state":"exited","timedOut":false}\n');
      starts++;
      return Response.json(info);
    }) as typeof fetch,
  });
  const sandbox = new E2BSandbox(
    new Sandbox(transport, { id: "sandbox" } as SandboxInfo),
    {} as Runtime,
  );
  await expect(
    sandbox.commands.run("cat", { cwd: "/home/user", requestTimeoutMs: 15, timeoutMs: 0 }),
  ).rejects.toBeInstanceOf(Error);
  expect(starts).toBe(0);
  expect(
    await sandbox.commands.run("cat", { cwd: "/home/user", requestTimeoutMs: 0, timeoutMs: 0 }),
  ).toMatchObject({ exitCode: 0 });
  expect(links).toBe(2);
  expect(starts).toBe(1);
});
