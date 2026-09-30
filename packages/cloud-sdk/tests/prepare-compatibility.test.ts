import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractArtifact, verifyArtifact } from "../scripts/prepare-compatibility";

test("upstream oracle artifacts must match their exact pinned integrity", () => {
  const bytes = Buffer.from("official SDK");
  for (const algorithm of ["sha256", "sha512"] as const) {
    const digest = createHash(algorithm)
      .update(bytes)
      .digest(algorithm === "sha256" ? "hex" : "base64");
    expect(() => verifyArtifact(bytes, `${algorithm}-${digest}`)).not.toThrow();
    expect(() => verifyArtifact(Buffer.from("changed"), `${algorithm}-${digest}`)).toThrow(
      "does not match",
    );
  }
  expect(() => verifyArtifact(bytes, "md5-bad")).toThrow("Unsupported");
});
test("extracting oracle sources never follows package links or traverses outside its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-oracle-extract-"));
  const script = String.raw`import io,sys,tarfile,zipfile
root=sys.argv[1]
for name, kind in [('good','file'),('traversal','traversal'),('link','link'),('absolute','absolute')]:
 with tarfile.open(root+'/'+name+'.tar','w') as tar:
  entry=tarfile.TarInfo('../escaped' if kind=='traversal' else '/escaped' if kind=='absolute' else 'package/index.js')
  if kind=='link':
   entry.type=tarfile.SYMTYPE;entry.linkname='../../escaped';tar.addfile(entry)
  else:
   entry.size=4;tar.addfile(entry,io.BytesIO(b'text'))
with zipfile.ZipFile(root+'/wheel.zip','w') as wheel: wheel.writestr('sdk/__init__.py','source')
`;
  try {
    const child = Bun.spawn(["python3", "-c", script, root], { stderr: "pipe" });
    expect(await child.exited).toBe(0);
    await extractArtifact(join(root, "good.tar"), join(root, "good"));
    expect(await readFile(join(root, "good/package/index.js"), "utf8")).toBe("text");
    await extractArtifact(join(root, "wheel.zip"), join(root, "wheel"));
    expect(await readFile(join(root, "wheel/sdk/__init__.py"), "utf8")).toBe("source");
    for (const name of ["traversal", "link", "absolute"])
      await expect(extractArtifact(join(root, `${name}.tar`), join(root, name))).rejects.toThrow(
        "refused",
      );
    await expect(readFile(join(root, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
