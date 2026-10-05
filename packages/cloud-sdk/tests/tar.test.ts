import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { link } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { packDirectory, tarHeader, unpackArchive, unpackStream } from "../src/tar";

/* A directory download unpacks an archive the sandbox built, so its contents
   are the customer's untrusted code's to choose. These archives are the ones a
   hostile sandbox would send. */

type Entry = {
  name: string;
  body?: string;
  link?: string;
  hard?: string;
  dir?: boolean;
  type?: "L" | "K";
};

function archive(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.type) {
      const body = new TextEncoder().encode(`${entry.body}\0`);
      parts.push(tarHeader("././@LongLink", body.length, 0o644, entry.type as "0"), body);
      parts.push(new Uint8Array((512 - (body.length % 512)) % 512));
    } else if (entry.dir) parts.push(tarHeader(`${entry.name}/`, 0, 0o755, "5"));
    else if (entry.link !== undefined) parts.push(tarHeader(entry.name, 0, 0o777, "2", entry.link));
    else if (entry.hard !== undefined)
      parts.push(tarHeader(entry.name, 0, 0o644, "1" as "0", entry.hard));
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

test("hard-linked files land with their content, as tar writes them", async () => {
  // tar writes a file's first name as a file and every other as a hard link
  // to it: a folder holding one file twice (1 October 2026 audit).
  await scene(async (target, outside) => {
    const source = join(outside, "source");
    await mkdir(join(source, "sub"), { recursive: true });
    await writeFile(join(source, "original.txt"), "same bytes");
    await link(join(source, "original.txt"), join(source, "sub", "copy.txt"));
    const packed = spawnSync("tar", ["-czf", "-", "-C", source, "."]).stdout;
    const listed = spawnSync("tar", ["-tvzf", "-"], { input: packed }).stdout.toString();
    expect(listed).toMatch(/link to|^h/m);
    await unpackArchive(packed, target);
    expect(await readFile(join(target, "original.txt"), "utf8")).toBe("same bytes");
    expect(await readFile(join(target, "sub", "copy.txt"), "utf8")).toBe("same bytes");
    // A later entry of the first name replaces it without changing the link's copy.
    await unpackArchive(
      archive([
        { name: "a.txt", body: "first" },
        { name: "b.txt", hard: "./a.txt" },
        { name: "a.txt", body: "second" },
      ]),
      target,
    );
    expect(await readFile(join(target, "a.txt"), "utf8")).toBe("second");
    expect(await readFile(join(target, "b.txt"), "utf8")).toBe("first");
  });
});

test("a long link target and a long multibyte folder name round-trip exactly", async () => {
  // ustar holds a 100-byte link and a 155-byte prefix; past them the writer
  // used to cut the bytes short (1 October 2026 audit).
  await scene(async (target, outside) => {
    const source = join(outside, "source");
    const folder = "é".repeat(80); // 160 bytes in UTF-8
    const deep = join(source, folder, "ü".repeat(60));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "file.txt"), "deep");
    const far = `${"x".repeat(60)}/${"y".repeat(60)}`; // 121 bytes
    await symlink(far, join(source, "far"));
    const packed = await packDirectory(source);
    // -z: GNU tar, unlike macOS's, reads gzip from a pipe only when told.
    const listed = spawnSync("tar", ["-tvzf", "-"], { input: packed }).stdout.toString();
    expect(listed).toContain(far);
    expect(listed.normalize("NFC")).toContain(`${folder}/${"ü".repeat(60)}/file.txt`);
    await unpackArchive(packed, target);
    expect(await readlink(join(target, "far"))).toBe(far);
    expect(await readFile(join(target, folder, "ü".repeat(60), "file.txt"), "utf8")).toBe("deep");
  });
});

test("a hard link must name a file the archive already carried", async () => {
  await scene(async (target, outside) => {
    await writeFile(join(outside, "secret.txt"), "theirs");
    const refused = async (entries: Entry[], pattern: RegExp) =>
      expect(unpackArchive(archive(entries), target)).rejects.toThrow(pattern);
    await refused([{ name: "x", hard: "../outside/secret.txt" }], /leads outside the target/);
    await refused([{ name: "x", hard: "/etc/hosts" }], /leads outside the target/);
    await refused(
      [
        { name: "x", hard: "later.txt" },
        { name: "later.txt", body: "a" },
      ],
      /does not carry/,
    );
    await refused(
      [
        { name: "d", link: "../outside" },
        { name: "x", hard: "d/secret.txt" },
      ],
      /does not carry/,
    );
    await refused(
      [
        { name: "d", dir: true },
        { name: "x", hard: "d" },
      ],
      /does not carry/,
    );
    expect(await exists(target)).toBe(false);
  });
});

test("a folder archive that arrives cut short throws download_incomplete and writes nothing", async () => {
  // A tar that fails part way in the sandbox ends its gzip stream short.
  const whole = archive([{ name: "a.txt", body: "a" }]);
  const base = await mkdtemp(join(tmpdir(), "runtime-unpack-"));
  try {
    const target = join(base, "target");
    await expect(unpackArchive(whole.subarray(0, whole.length - 12), target)).rejects.toMatchObject(
      {
        code: "download_incomplete",
      },
    );
    await expect(stat(target)).rejects.toThrow();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a folder streams in chunks, merges into what is there, and a cut leaves the target as it was", async () => {
  await scene(async (target) => {
    await mkdir(target);
    await writeFile(join(target, "kept.txt"), "mine");
    await writeFile(join(target, "a.txt"), "old");
    const whole = archive([
      { name: "a.txt", body: "new" },
      { name: "sub", dir: true },
      { name: "sub/b.txt", body: "b".repeat(5_000) },
    ]);
    // A cut part way: nothing changes, and nothing is left beside it.
    const cut = async function* () {
      yield whole.subarray(0, 40);
      yield whole.subarray(40, whole.length - 12);
    };
    await expect(unpackStream(cut(), target)).rejects.toMatchObject({
      code: "download_incomplete",
    });
    expect(await readFile(join(target, "a.txt"), "utf8")).toBe("old");
    expect(await exists(join(target, "sub"))).toBe(false);
    expect((await readdir(join(target, ".."))).sort()).toEqual(["outside", "target"]);
    // Whole, one byte at a time: merged, same names replaced, the rest kept.
    const bytewise = async function* () {
      for (let at = 0; at < whole.length; at++) yield whole.subarray(at, at + 1);
    };
    await unpackStream(bytewise(), target);
    expect(await readFile(join(target, "a.txt"), "utf8")).toBe("new");
    expect(await readFile(join(target, "kept.txt"), "utf8")).toBe("mine");
    expect(await readFile(join(target, "sub/b.txt"), "utf8")).toBe("b".repeat(5_000));
    expect((await readdir(join(target, ".."))).sort()).toEqual(["outside", "target"]);
  });
});
