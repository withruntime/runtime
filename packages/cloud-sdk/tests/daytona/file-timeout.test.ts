/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "../../src/daytona/filesystem";
import { Files } from "../../src/sandbox";
import { Transport } from "../../src/transport";
import type { SandboxContext } from "../../src/daytona/context";

function fixture(block: "headers" | "body" | "none" = "headers") {
  let closed = false;
  const calls: Request[] = [];
  const transport = new Transport({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://fixture.invalid",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (new URL(request.url).pathname.endsWith("/stat"))
        return Response.json({
          exists: true,
          type: "file",
          path: "/workspace/data",
          size: 2,
        });
      if (block === "none")
        return new Response(Uint8Array.of(0, 255), { headers: { "content-length": "2" } });
      if (block === "headers")
        return new Promise<Response>((_, reject) =>
          request.signal.addEventListener(
            "abort",
            () => {
              closed = true;
              reject(request.signal.reason);
            },
            { once: true },
          ),
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.of(0));
            request.signal.addEventListener(
              "abort",
              () => {
                closed = true;
                controller.error(request.signal.reason);
              },
              { once: true },
            );
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            closed = true;
          },
        }),
        { headers: { "content-length": "2" } },
      );
    }) as typeof fetch,
  });
  const fs = new FileSystem({
    ensureHome: async () => {},
    live: async () => ({ files: new Files(transport, "sandbox") }),
  } as unknown as SandboxContext);
  return { fs, calls, closed: () => closed };
}

test("Daytona buffer download applies seconds timeout and cancels its native HTTP request", async () => {
  const { fs, closed, calls } = fixture();
  await expect(fs.downloadFile("data", 0.01)).rejects.toBeInstanceOf(Error);
  expect(closed()).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.signal.aborted).toBe(true);
});

test("a timed-out local download preserves the destination and removes its partial file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "daytona-timeout-"));
  const target = join(directory, "data");
  await writeFile(target, "original");
  const { fs } = fixture("body");
  try {
    await expect(fs.downloadFile("data", target, 0.03)).rejects.toBeInstanceOf(Error);
    expect(await readFile(target, "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual(["data"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Daytona stream carries cancellation through a stalled body", async () => {
  const { fs, closed } = fixture("body");
  const controller = new AbortController();
  const stream = await fs.downloadFileStream("data", { timeout: 0, signal: controller.signal });
  const read = (async () => {
    for await (const _chunk of stream) {
      /* consume */
    }
  })();
  const outcome = read.catch((error: unknown) => error);
  controller.abort(new Error("cancelled"));
  expect(await outcome).toBeInstanceOf(Error);
  expect(closed()).toBe(true);
});

test("batch deadline fails the transfer and makes no later file request", async () => {
  const { fs, calls } = fixture();
  await expect(
    fs.downloadFiles([{ source: "one" }, { source: "two" }], 0.01),
  ).rejects.toBeInstanceOf(Error);
  expect(calls).toHaveLength(1);
});

test("binary bytes survive the timeout overload and malformed deadlines fail before requests", async () => {
  const { fs, calls } = fixture("none");
  expect([...(await fs.downloadFile("data", 1))]).toEqual([0, 255]);
  for (const timeout of [-1, NaN, Infinity])
    await expect(fs.downloadFile("data", timeout)).rejects.toBeInstanceOf(Error);
  expect(calls).toHaveLength(1);
});
