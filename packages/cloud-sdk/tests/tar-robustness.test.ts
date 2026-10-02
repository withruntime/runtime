import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { tarHeader, unpackArchive, unpackStream } from "../src/tar";

async function scene(run: (target: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-tar-hostile-"));
  try {
    await run(join(directory, "target"), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("malformed tar size fields fail before publishing files", async () => {
  for (const size of ["-1", "NaN", "12junk", "9", "1.5"]) {
    await scene(async (target, directory) => {
      const header = tarHeader("bad", 0, 0o644, "0");
      header.fill(0, 124, 136);
      header.set(new TextEncoder().encode(size), 124);
      const archive = gzipSync(Buffer.concat([header, new Uint8Array(1024)]));
      await expect(unpackArchive(archive, target)).rejects.toThrow("invalid file size");
      expect(await readdir(directory)).toEqual([]);
    });
  }
});

test("oversized GNU name and link records are refused from their header without reading their body", async () => {
  for (const type of ["L", "K"]) {
    await scene(async (target, directory) => {
      const header = tarHeader("././@LongLink", 65537, 0o644, type as "0");
      const archive = gzipSync(Buffer.concat([header, new Uint8Array(1024)]));
      await expect(unpackArchive(archive, target)).rejects.toThrow("oversized path metadata");
      expect(await readdir(directory)).toEqual([]);
    });
  }
});

test("an aborted archive input is cancelled and cannot publish its staged directory", async () => {
  await scene(async (target, directory) => {
    const abort = new AbortController();
    let closed = false;
    const header = tarHeader("file", 6, 0o644, "0");
    const complete = gzipSync(
      Buffer.concat([header, Buffer.from("abcdef"), new Uint8Array(506), new Uint8Array(1024)]),
    );
    async function* source() {
      try {
        yield complete.subarray(0, 10);
        abort.abort();
        yield complete.subarray(10);
      } finally {
        closed = true;
      }
    }
    await expect(unpackStream(source(), target, { signal: abort.signal })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(closed).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    await expect(stat(target)).rejects.toThrow();
  });
});

test("directory extraction retains all bytes when the local filesystem accepts partial writes", async () => {
  const source = new URL("../src/tar.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import {mock} from "bun:test";
    import * as actual from "node:fs/promises";
    import {join} from "node:path";
    import {tmpdir} from "node:os";
    import {gzipSync} from "node:zlib";
    const originalOpen=actual.open;
    mock.module("node:fs/promises",()=>({...actual,open:async(...args)=>{const file=await originalOpen(...args);return {write:bytes=>file.write(bytes.subarray(0,2)),close:()=>file.close()};}}));
    const {tarHeader,unpackArchive}=await import(process.argv[1]);
    const directory=await actual.mkdtemp(join(tmpdir(),"runtime-tar-short-"));
    try {const target=join(directory,"target");const archive=gzipSync(Buffer.concat([tarHeader("file",6,0o644,"0"),Buffer.from("abcdef"),new Uint8Array(506),new Uint8Array(1024)]));await unpackArchive(archive,target);console.log(JSON.stringify({received:await actual.readFile(join(target,"file"),"utf8")}));}
    finally {await actual.rm(directory,{recursive:true,force:true});}
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
