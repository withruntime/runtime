import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Files } from "../src/sandbox";
import { RuntimeError } from "../src/errors";
import { Transport, type Call } from "../src/transport";

test("download retries short local writes until every chunk byte reaches disk", async () => {
  // Isolate the filesystem instrument from every other test in the runner.
  const source = new URL("../src/sandbox.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { mock } from "bun:test";
    import * as actual from "node:fs/promises";
    import { join } from "node:path";
    import { tmpdir } from "node:os";
    const originalOpen=actual.open;
    mock.module("node:fs/promises",()=>({...actual,open:async(...args)=>{
      const file=await originalOpen(...args);
      return {write:async(bytes)=>file.write(bytes.subarray(0,2)),close:()=>file.close()};
    }}));
    const { Files }=await import(process.argv[1]);
    const directory=await actual.mkdtemp(join(tmpdir(),"runtime-short-sink-"));
    try {
      const target=join(directory,"target");
      const files=new Files({json:async()=>({exists:true,type:"file"}),fileStream:async()=>new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("abcdef"));controller.close();}})},"sandbox");
      await files.download("/file",target);
      console.log(JSON.stringify({received:await actual.readFile(target,"utf8")}));
    } finally {await actual.rm(directory,{recursive:true,force:true});}
  `,
      source,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ received: "abcdef" });
});

test("download keeps one signal through stat and incomplete-stream retries", async () => {
  const calls: Call[] = [];
  let reads = 0;
  const files = new Files(
    {
      json: async (call: Call) => {
        calls.push(call);
        return { exists: true, type: "file" };
      },
      fileStream: async (call: Call) => {
        calls.push(call);
        if (++reads === 1)
          throw new RuntimeError({ code: "download_incomplete", message: "short", status: 0 });
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        });
      },
    } as unknown as Transport,
    "sandbox",
  );
  const directory = await mkdtemp(join(tmpdir(), "runtime-dl-options-"));
  try {
    const target = join(directory, "target");
    await files.download("/file", target, { timeoutMs: 5000 });
    expect(new Set(calls.map((call) => call.signal)).size).toBe(1);
    expect(calls.every((call) => call.timeoutMs === 0)).toBe(true);
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download cancellation preserves an existing destination and removes its partial", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const files = new Files(
    new Transport({
      apiKey: "fixture",
      baseUrl: "http://localhost",
      maxRetries: 0,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url.includes("/files/stat"))
          return Response.json({ exists: true, type: "file" });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              queueMicrotask(() => abort.abort());
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "x-content-length": "10" } },
        );
      }) as unknown as typeof fetch,
    }),
    "sandbox",
  );
  const directory = await mkdtemp(join(tmpdir(), "runtime-dl-cancel-"));
  try {
    const target = join(directory, "target");
    await writeFile(target, "keep");
    await expect(files.download("/file", target, { signal: abort.signal })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(await readFile(target, "utf8")).toBe("keep");
    expect(await readdir(directory)).toEqual(["target"]);
    expect(cancelled).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
