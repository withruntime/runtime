/** Download exact, hash-verified SDK sources for package-only contract tests.
 * Never installs dependencies or runs code or lifecycle scripts from a package. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import type { CompatibilityLock, Upstream } from "./check-upstream";

const MAX_ARCHIVE = 50 * 1024 * 1024;
export function verifyArtifact(bytes: Uint8Array, integrity: string): void {
  const dash = integrity.indexOf("-");
  const algorithm = integrity.slice(0, dash);
  const expected = integrity.slice(dash + 1);
  if (algorithm !== "sha256" && algorithm !== "sha512")
    throw new Error("Unsupported artifact hash");
  const actual = createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha256" ? "hex" : "base64");
  if (actual !== expected)
    throw new Error("Published artifact does not match compatibility-lock.json");
}
const extractor = String.raw`
import os, pathlib, sys, tarfile, zipfile
archive, destination = sys.argv[1:]
root = pathlib.Path(destination)
seen = set()
size = 0
def target(name, length, directory=False):
    global size
    path = pathlib.PurePosixPath(name)
    if '\\' in name or path.is_absolute() or '..' in path.parts or not path.parts:
        raise ValueError('Unsafe package path')
    key = str(path)
    if key in seen and not directory:
        raise ValueError('Duplicate package file')
    seen.add(key)
    size += length
    if size > 256 * 1024 * 1024 or len(seen) > 20000:
        raise ValueError('Package extraction limit exceeded')
    result = root.joinpath(*path.parts)
    if directory:
        result.mkdir(parents=True, exist_ok=True)
    else:
        result.parent.mkdir(parents=True, exist_ok=True)
    return result
def copy(source, path, length):
    with path.open('xb') as out:
        remaining = length
        while remaining:
            data = source.read(min(65536, remaining))
            if not data: raise ValueError('Incomplete archive member')
            out.write(data)
            remaining -= len(data)
    path.chmod(0o644)
if zipfile.is_zipfile(archive):
    with zipfile.ZipFile(archive) as package:
        for item in package.infolist():
            kind = (item.external_attr >> 16) & 0o170000
            if kind not in (0, 0o100000, 0o040000): raise ValueError('Package links and special files are refused')
            path = target(item.filename, item.file_size, item.is_dir())
            if not item.is_dir():
                with package.open(item) as source: copy(source, path, item.file_size)
else:
    with tarfile.open(archive) as package:
        for item in package:
            if not item.isdir() and not item.isfile(): raise ValueError('Package links and special files are refused')
            path = target(item.name, item.size, item.isdir())
            if item.isfile():
                with package.extractfile(item) as source: copy(source, path, item.size)
`;

export async function extractArtifact(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const process = Bun.spawn(["python3", "-c", extractor, archive, destination], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(`Package extraction refused: ${stderr.trim()}`);
}
async function boundedDownload(url: string): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !["registry.npmjs.org", "files.pythonhosted.org"].includes(parsed.hostname)
  )
    throw new Error("Artifact URL must use the official package registry");
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!response.ok || !response.body)
    throw new Error(`Artifact download failed (${response.status})`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_ARCHIVE) throw new Error("SDK artifact exceeds the download bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
async function sourceManifest(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (name === ".runtime-contract-pin.json" || name === ".runtime-contract-files.json")
        continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        result[name] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      else throw new Error("Verified source cache contains a link or special file");
    }
  };
  await visit(root);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export async function prepare(pin: Upstream, root: string): Promise<string> {
  const destination = join(root, pin.registry, `${encodeURIComponent(pin.name)}@${pin.version}`);
  // Only what identifies the artifact; review notes such as `unsupported` must not
  // invalidate a verified cache.
  const marker = JSON.stringify({
    registry: pin.registry,
    name: pin.name,
    version: pin.version,
    artifacts: pin.artifacts,
  });
  let existing: string | undefined;
  try {
    existing = await readFile(join(destination, ".runtime-contract-pin.json"), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    if (existing !== marker)
      throw new Error(`Existing source cache has a different pin: ${destination}`);
    const recorded = await readFile(join(destination, ".runtime-contract-files.json"), "utf8");
    if (recorded !== JSON.stringify(await sourceManifest(destination)))
      throw new Error(`Verified source cache changed: ${destination}`);
    return destination;
  }
  const metadataUrl =
    pin.registry === "npm"
      ? `https://registry.npmjs.org/${encodeURIComponent(pin.name)}/${encodeURIComponent(pin.version)}`
      : `https://pypi.org/pypi/${encodeURIComponent(pin.name)}/${encodeURIComponent(pin.version)}/json`;
  const response = await fetch(metadataUrl, {
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Registry lookup failed (${response.status})`);
  const metadata = (await response.json()) as {
    dist?: { tarball?: string; integrity?: string };
    urls?: { filename: string; url: string; digests: { sha256: string } }[];
  };
  let url: string, integrity: string;
  if (pin.registry === "npm") {
    if (typeof metadata.dist?.tarball !== "string") throw new Error("Registry omitted tarball URL");
    url = metadata.dist.tarball;
    integrity = pin.artifacts[pin.version]!;
    if (metadata.dist.integrity !== integrity) throw new Error("Registry integrity changed");
  } else {
    if (!Array.isArray(metadata.urls)) throw new Error("Registry omitted release files");
    const file = metadata.urls.find(
      (item: { filename: string }) =>
        item.filename.endsWith(".whl") && pin.artifacts[item.filename],
    );
    if (!file) throw new Error("No pinned wheel is available");
    url = file.url;
    integrity = pin.artifacts[file.filename]!;
    if (`sha256-${file.digests.sha256}` !== integrity)
      throw new Error("Registry integrity changed");
  }
  const bytes = await boundedDownload(url);
  verifyArtifact(bytes, integrity);
  await mkdir(join(root, pin.registry), { recursive: true });
  const temporary = await mkdtemp(join(root, pin.registry, ".prepare-"));
  try {
    const archive = join(temporary, "artifact");
    const extracted = join(temporary, "source");
    await writeFile(archive, bytes);
    await extractArtifact(archive, extracted);
    await writeFile(join(extracted, ".runtime-contract-pin.json"), marker);
    await writeFile(
      join(extracted, ".runtime-contract-files.json"),
      JSON.stringify(await sourceManifest(extracted)),
    );
    await rename(extracted, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return destination;
}
if (import.meta.main) {
  const root = resolve(process.argv[2] ?? "/tmp/runtime-compat-upstreams");
  const lock = (await Bun.file(
    new URL("../compatibility-lock.json", import.meta.url),
  ).json()) as CompatibilityLock;
  for (const provider of lock.providers)
    for (const pin of provider.upstreams) {
      const directory = await prepare(pin, root);
      console.log(`${provider.id}\t${pin.registry}:${pin.name}@${pin.version}\t${directory}`);
    }
}
