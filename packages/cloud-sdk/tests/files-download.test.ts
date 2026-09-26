import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, RuntimeError } from "../src/index";
import { Sandbox as E2BSandbox } from "../src/e2b/index";

/* 25 September 2026: `runtime sandbox cp` of a 50 MB file wrote 29 MB and
   printed "Copied", exit 0; files.read returned short with no error. A stream
   the controller broke part way reached the client as a clean end. The API
   now says every body's length first (x-content-length), and a small one's
   SHA-256, and the SDK refuses a body that disagrees. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const whole = new Uint8Array(3 * 1_048_576 + 7).map((_, i) => (i * 31) & 0xff);

/** `short` bodies cut to that many bytes, in order, then whole ones. */
function world(short: number[] = [], options: { sha?: string; noLength?: boolean } = {}) {
  let reads = 0;
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/files/stat"))
        return Response.json({ exists: true, type: "file", path: url.searchParams.get("path") });
      if (url.pathname.endsWith("/files/content")) {
        const cut = short[reads++];
        const body = cut === undefined ? whole : whole.subarray(0, cut);
        return new Response(
          new ReadableStream({
            start(controller) {
              // In pieces, as a network delivers it.
              for (let at = 0; at < body.length; at += 65_536)
                controller.enqueue(body.slice(at, at + 65_536));
              controller.close();
            },
          }),
          {
            headers: {
              "content-type": "application/octet-stream",
              ...(options.noLength ? {} : { "x-content-length": String(whole.length) }),
              ...(options.sha ? { "x-content-sha256": options.sha } : {}),
            },
          },
        );
      }
      return Response.json({
        id: ID,
        kind: "sandbox",
        state: "running",
        status: "active",
        metadata: {},
      });
    }) as typeof fetch,
  });
  return { runtime, reads: () => reads };
}

test("a short read is read again, and returns whole", async () => {
  const w = world([2_966_523, 1_441_474]);
  const sbx = await w.runtime.sandboxes.get(ID);
  const got = await sbx.files.read("/workspace/big.bin");
  expect(got.length).toBe(whole.length);
  expect(w.reads()).toBe(3);
});

test("a read that keeps arriving short throws download_incomplete, never returns short", async () => {
  const w = world([10, 20, 30, 40]);
  const sbx = await w.runtime.sandboxes.get(ID);
  const error = await sbx.files.read("/workspace/big.bin").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RuntimeError);
  expect((error as RuntimeError).code).toBe("download_incomplete");
  expect((error as RuntimeError).details).toEqual({ received: 30, expected: whole.length });
  expect(w.reads()).toBe(3);
});

test("a small file whose bytes do not match its digest is refused", async () => {
  const w = world([], { sha: "0".repeat(64) });
  const sbx = await w.runtime.sandboxes.get(ID);
  await expect(sbx.files.read("/workspace/x")).rejects.toMatchObject({
    code: "download_incomplete",
  });
  const right = createHash("sha256").update(whole).digest("hex");
  const ok = world([], { sha: right });
  expect((await (await ok.runtime.sandboxes.get(ID)).files.read("/workspace/x")).length).toBe(
    whole.length,
  );
});

test("an older API that sends no length is read as before", async () => {
  const w = world([100], { noLength: true });
  const sbx = await w.runtime.sandboxes.get(ID);
  expect((await sbx.files.read("/workspace/x")).length).toBe(100);
});

test("readStream delivers a file in pieces and errors when it ends short", async () => {
  const w = world([2_000_000]);
  const sbx = await w.runtime.sandboxes.get(ID);
  const short = await sbx.files.readStream("/workspace/big.bin");
  await expect(new Response(short).arrayBuffer()).rejects.toMatchObject({
    code: "download_incomplete",
  });
  const full = await sbx.files.readStream("/workspace/big.bin");
  expect((await new Response(full).arrayBuffer()).byteLength).toBe(whole.length);
});

test("download (what `runtime sandbox cp` runs) retries a short copy and never leaves a short file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-dl-"));
  try {
    const retried = world([1_000_000]);
    const target = join(dir, "o.bin");
    await (await retried.runtime.sandboxes.get(ID)).files.download("/workspace/big.bin", target);
    expect((await readFile(target)).equals(Buffer.from(whole))).toBe(true);

    const broken = world([1, 2, 3, 4]);
    const lost = join(dir, "lost.bin");
    await expect(
      (await broken.runtime.sandboxes.get(ID)).files.download("/workspace/big.bin", lost),
    ).rejects.toMatchObject({ code: "download_incomplete" });
    expect(await readdir(dir)).toEqual(["o.bin"]); // no short file, no partial left behind
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2B's read with format stream is a real, checked stream", async () => {
  const w = world([500]);
  const sbx = await E2BSandbox.connect(ID, { runtime: { client: w.runtime } });
  const stream = await sbx.files.read("/workspace/big.bin", { format: "stream" });
  await expect(new Response(stream).arrayBuffer()).rejects.toMatchObject({
    code: "download_incomplete",
  });
});
