import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { tarHeader, unpackArchive } from "../src/tar.js";

const archive = (header: Uint8Array, end = 1024) =>
  gzipSync(Buffer.concat([header, new Uint8Array(end)]));

test("an invalid header checksum leaves the destination unpublished", async () => {
  const base = await mkdtemp(join(tmpdir(), "runtime-archive-integrity-"));
  try {
    const target = join(base, "target");
    const header = tarHeader("a", 0, 0o644, "0");
    header[0] = 98;
    await expect(unpackArchive(archive(header), target)).rejects.toThrow("checksum");
    await expect(lstat(target)).rejects.toThrow();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a single termination block is incomplete", async () => {
  const base = await mkdtemp(join(tmpdir(), "runtime-archive-integrity-"));
  try {
    await expect(
      unpackArchive(archive(tarHeader("a", 0, 0o644, "0"), 512), join(base, "target")),
    ).rejects.toMatchObject({ code: "download_incomplete" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("incoming links are validated against the destination before merge", async () => {
  const base = await mkdtemp(join(tmpdir(), "runtime-archive-merge-"));
  const target = join(base, "target");
  try {
    await mkdir(target);
    await mkdir(join(base, "outside"));
    await symlink("../outside", join(target, "old"));
    await expect(
      unpackArchive(archive(tarHeader("new", 0, 0o777, "2", "old/file")), target),
    ).rejects.toThrow("outside the target");
    await expect(lstat(join(target, "new"))).rejects.toThrow();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a safe existing link remains usable after merge", async () => {
  const base = await mkdtemp(join(tmpdir(), "runtime-archive-merge-"));
  const target = join(base, "target");
  try {
    await mkdir(target);
    await writeFile(join(target, "a"), "kept");
    await symlink("a", join(target, "old"));
    await unpackArchive(archive(tarHeader("new", 0, 0o777, "2", "old")), target);
    expect(await readFile(join(target, "new"), "utf8")).toBe("kept");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
