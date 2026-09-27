import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { tarHeader, unpackArchive } from "../src/tar";

/* A directory download unpacks an archive the sandbox built, so its contents
   are the customer's untrusted code's to choose. These archives are the ones a
   hostile sandbox would send. */

type Entry = { name: string; body?: string; link?: string; dir?: boolean; type?: "L" | "K" };

function archive(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.type) {
      const body = new TextEncoder().encode(`${entry.body}\0`);
      parts.push(tarHeader("././@LongLink", body.length, 0o644, entry.type as "0"), body);
      parts.push(new Uint8Array((512 - (body.length % 512)) % 512));
    } else if (entry.dir) parts.push(tarHeader(`${entry.name}/`, 0, 0o755, "5"));
    else if (entry.link !== undefined) parts.push(tarHeader(entry.name, 0, 0o777, "2", entry.link));
    else {
      const body = new TextEncoder().encode(entry.body ?? "");
      parts.push(tarHeader(entry.name, body.length, 0o644, "0"), body);
      parts.push(new Uint8Array((512 - (body.length % 512)) % 512));
    }
  }
  parts.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(parts));
}

async function scene(run: (target: string, outside: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "runtime-unpack-"));
  try {
    await mkdir(join(base, "outside"));
    await run(join(base, "target"), join(base, "outside"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("a link followed by a file through it cannot write outside the target", async () => {
  await scene(async (target, outside) => {
    const hostile = archive([
      { name: "x", link: "../outside" },
      { name: "x/pwned.txt", body: "owned" },
    ]);
    await expect(unpackArchive(hostile, target)).rejects.toThrow(/outside the target/);
    expect(await exists(join(outside, "pwned.txt"))).toBe(false);
  });
});

test("a link to an absolute path is refused and removed", async () => {
  await scene(async (target) => {
    await expect(unpackArchive(archive([{ name: "etc", link: "/etc" }]), target)).rejects.toThrow(
      /leads outside the target/,
    );
    expect(await exists(join(target, "etc"))).toBe(false);
  });
});

test("a link that climbs out through another link is refused", async () => {
  await scene(async (target) => {
    // Lexically `d/up/..` is `d`, inside; followed, `d/up` is the target itself
    // and `..` leaves it.
    const hostile = archive([
      { name: "d", dir: true },
      { name: "d/up", link: ".." },
      { name: "x", link: "d/up/.." },
    ]);
    await expect(unpackArchive(hostile, target)).rejects.toThrow(/x -> d\/up\/\.\./);
    expect(await exists(join(target, "x"))).toBe(false);
  });
});

test("a file is never written through a link already in the target", async () => {
  await scene(async (target, outside) => {
    await mkdir(target);
    await symlink(outside, join(target, "cache"));
    const hostile = archive([{ name: "cache/pwned.txt", body: "owned" }]);
    await expect(unpackArchive(hostile, target)).rejects.toThrow(/passes through a link/);
    expect(await exists(join(outside, "pwned.txt"))).toBe(false);
  });
});

test("links that stay inside land intact, including GNU long link targets", async () => {
  await scene(async (target) => {
    const deep = `pkg/${"d".repeat(60)}/${"e".repeat(60)}/cli.js`;
    await unpackArchive(
      archive([
        { name: "node_modules/.bin", dir: true },
        { name: "node_modules/pkg/cli.js", body: "run()" },
        { name: "node_modules/.bin/tool", link: "../pkg/cli.js" },
        { name: `node_modules/${deep}`, body: "deep()" },
        { name: "", type: "K", body: `../${deep}` },
        { name: "node_modules/.bin/deep", link: "truncated" },
        { name: "current", link: "node_modules/.bin" },
      ]),
      target,
    );
    expect(await readFile(join(target, "node_modules/.bin/tool"), "utf8")).toBe("run()");
    expect(await readlink(join(target, "node_modules/.bin/deep"))).toBe(`../${deep}`);
    expect(await readFile(join(target, "node_modules/.bin/deep"), "utf8")).toBe("deep()");
    expect(await readFile(join(target, "current/tool"), "utf8")).toBe("run()");
  });
});
