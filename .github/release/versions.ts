// What version each SDK ships at, decided once per landing by the line (cli.ts `next` and `due`, run by
// engines/products/crates/pipelines sdks.rs) and carried by the record it signs (`due=<target>:<X.Y.Z>,...`), which
// the mirror's publish workflow publishes exactly. A version is a counter whose one home is the registry: no pull
// request names one or says how far it moves (Marc, 26 Nov, `sdks` and `nomajor`).
//
// - From: the newer of the registry's newest and the version the mirror's last record sent (a publish that is still
//   under way when the next landing comes is not counted twice).
// - Step: minor when the API's description (openapi v2.json) differs from the one the mirror last shipped, else
//   patch. Never major: a break never ships (`nomajor`; sdks/release.sh surface and spec-gen check refuse one).
// - Due: only a package whose tree differs from the mirror's copy, its version lines aside: nothing changed, nothing
//   published.
//
// Node runs this file in the mirror with its types stripped, so it imports nothing and uses no syntax that has to be
// compiled.

export type Pkg = "js" | "python" | "ruby" | "go" | "java";

/** Each SDK: its folder in the public tree (sdks/release.sh writes it), its publish workflow's jobs, and its files
 * whose version lines release.sh writes (each line naming a version is that package's version, so a diff that is
 * only those lines is no change). */
export const SDKS: Record<Pkg, { dir: string; targets: readonly string[]; versioned: readonly string[] }> = {
  js: { dir: "packages/cloud-sdk", targets: ["npm", "mcp"], versioned: ["package.json", "server.json"] },
  python: { dir: "sdks/python", targets: ["pypi"], versioned: ["pyproject.toml", "withruntime/_version.py"] },
  ruby: { dir: "sdks/ruby", targets: ["rubygems"], versioned: ["lib/withruntime/version.rb"] },
  go: { dir: "sdks/go", targets: ["go"], versioned: ["client.go"] },
  java: { dir: "sdks/java", targets: ["maven"], versioned: ["pom.xml"] },
};
export const PKGS = Object.keys(SDKS) as Pkg[];

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A version's three numbers, or undefined when it is not X.Y.Z (a leading v allowed, as Go's tags have). */
const nums = (v: string) => (SEMVER.test(v.replace(/^v/, "")) ? v.replace(/^v/, "").split(".").map(Number) : undefined);

/** The newest X.Y.Z of `versions`, or undefined. */
export function newest(versions: readonly string[]): string | undefined {
  let best: number[] | undefined;
  for (const v of versions) {
    const n = nums(v);
    if (n && (!best || cmp(n, best) > 0)) best = n;
  }
  return best?.join(".");
}
const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

export type Step = "minor" | "patch";

/** `version` moved by `step`. */
export function bumped(version: string, step: Step): string {
  const n = nums(version);
  if (!n) throw new Error(`${version} is not X.Y.Z`);
  return step === "minor" ? `${n[0]}.${n[1]! + 1}.0` : `${n[0]}.${n[1]}.${n[2]! + 1}`;
}

/** The step every due package takes: minor when the API's description changed since the mirror's last, else patch. */
export const stepOf = (spec: string, mirrorSpec: string | undefined): Step =>
  mirrorSpec !== undefined && spec.trim() === mirrorSpec.trim() ? "patch" : "minor";

/** A package's next version: over the newer of its registry's newest and what the last record sent; an SDK with
 * neither starts at 1.0.0. */
export function next(registry: readonly string[], sent: string | undefined, step: Step): string {
  const from = newest([...registry, ...(sent ? [sent] : [])]);
  return from ? bumped(from, step) : "1.0.0";
}

/** The versions a record's due line names, by target (`due=npm:1.2.0,mcp:1.2.0,...`). */
export function dueOf(line: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = line.trim().replace(/^due=/, "");
  for (const pair of body.split(",").filter(Boolean)) {
    const [t = "", v = ""] = pair.split(":");
    if (/^[a-z]+$/.test(t) && SEMVER.test(v)) out.set(t, v);
  }
  return out;
}

/** The due line for `due` packages at their versions: every job of each, sorted. */
export function dueLine(due: readonly { pkg: Pkg; version: string }[]): string {
  const pairs = due.flatMap((d) => SDKS[d.pkg].targets.map((t) => `${t}:${d.version}`)).sort();
  return `due=${pairs.join(",")}`;
}

/** A versioned file's text with every version on a line that names one put aside, so two trees that differ only in
 * the version they were written at compare equal. */
export const unversioned = (text: string) =>
  text.replace(/^(.*(?:version|VERSION|Version).*?)\d+\.\d+\.\d+/gm, "$1X.Y.Z");
