// Where each SDK's version is written (Marc, 14 October 2026: agents update
// and publish the SDKs by themselves). One package's version is in several
// files, and a release with them apart ships a client that names another
// version than the one installed: scripts/sdk-version.ts moves them together
// and refuses files that disagree, the hub reads them to know what to
// publish (agents/sdks.ts), and the publish workflow in the public mirror
// reads them again before each upload (cli.ts). Node runs this file in the
// mirror with its types stripped, so it imports nothing and uses no syntax
// that has to be compiled.

export type Pkg =
  | "js"
  | "python"
  | "langchain"
  | "openai-agents"
  | "pydantic-ai"
  | "google-adk"
  | "smolagents"
  | "go"
  | "java"
  | "ruby";
export const PKGS: readonly Pkg[] = [
  "js",
  "python",
  "langchain",
  "openai-agents",
  "pydantic-ai",
  "google-adk",
  "smolagents",
  "go",
  "java",
  "ruby",
];

/** The Python framework integrations under integrations/, on PyPI as
 * `<name>-withruntime` (Marc approved publishing them, 22 October 2026):
 * each one's folder and module, whose pyproject.toml and `__version__` name
 * its version. */
export const PYPI_INTEGRATIONS = {
  "openai-agents": { dir: "integrations/openai-agents", module: "openai_agents_withruntime" },
  "pydantic-ai": { dir: "integrations/pydantic-ai", module: "pydantic_ai_withruntime" },
  "google-adk": { dir: "integrations/google-adk", module: "google_adk_withruntime" },
  smolagents: { dir: "integrations/smolagents", module: "smolagents_withruntime" },
} as const;

function integration(pkg: keyof typeof PYPI_INTEGRATIONS): Spot[] {
  const { dir, module } = PYPI_INTEGRATIONS[pkg];
  return [
    { path: `${dir}/pyproject.toml`, pattern: /^version = "([^"]*)"$/gm, count: 1 },
    { path: `${dir}/${module}/__init__.py`, pattern: /^__version__ = "([^"]*)"$/gm, count: 1 },
  ];
}

/** A version in a file: the pattern's one group, found exactly `count` times. */
export type Spot = { path: string; pattern: RegExp; count: number };

const POM = /<artifactId>withruntime<\/artifactId>\n\s*<version>([^<]*)<\/version>/g;
const GUIDE = /This guide describes `withruntime` ([0-9A-Za-z.+-]+?)\.(?=\s)/g;

export const VERSION_FILES: Record<Pkg, Spot[]> = {
  // npm's withruntime, and the MCP registry's com.withruntime/runtime, which
  // lists the same version from server.json (twice: the server and its npm package).
  js: [
    { path: "packages/cloud-sdk/package.json", pattern: /^ {2}"version": "([^"]*)",$/gm, count: 1 },
    {
      path: "packages/cloud-sdk/src/transport.ts",
      pattern: /^export const VERSION = "([^"]*)";$/gm,
      count: 1,
    },
    { path: "packages/cloud-sdk/server.json", pattern: /^ +"version": "([^"]*)",$/gm, count: 2 },
    // The guide names the release it describes (packages/cloud-guide/src/content.test.ts).
    { path: "packages/cloud-guide/docs/javascript.md", pattern: GUIDE, count: 1 },
  ],
  python: [
    { path: "sdks/python/pyproject.toml", pattern: /^version = "([^"]*)"$/gm, count: 1 },
    { path: "sdks/python/withruntime/_version.py", pattern: /^VERSION = "([^"]*)"$/gm, count: 1 },
    // The package test's own witness, so a bump does not fail it.
    {
      path: "sdks/python/tests/test_package_typing.py",
      pattern: /^VERSION = "([^"]*)"$/gm,
      count: 1,
    },
    { path: "packages/cloud-guide/docs/python.md", pattern: GUIDE, count: 1 },
  ],
  langchain: [
    {
      path: "sdks/python/integrations/langchain-withruntime/pyproject.toml",
      pattern: /^version = "([^"]*)"$/gm,
      count: 1,
    },
    {
      path: "sdks/python/integrations/langchain-withruntime/langchain_withruntime/_version.py",
      pattern: /^__version__ = "([^"]*)"$/gm,
      count: 1,
    },
  ],
  "openai-agents": integration("openai-agents"),
  "pydantic-ai": integration("pydantic-ai"),
  "google-adk": integration("google-adk"),
  smolagents: integration("smolagents"),
  go: [{ path: "sdks/go/client.go", pattern: /^const Version = "([^"]*)"$/gm, count: 1 }],
  java: [
    { path: "sdks/java/pom.xml", pattern: POM, count: 1 },
    {
      path: "sdks/java/src/main/java/com/withruntime/RuntimeClient.java",
      pattern: /public static final String VERSION = "([^"]*)";/g,
      count: 1,
    },
    { path: "packages/cloud-guide/docs/java.md", pattern: POM, count: 1 },
    {
      path: "packages/cloud-guide/docs/java.md",
      pattern: /com\.withruntime:withruntime:([^")\s`]*)/g,
      count: 1,
    },
  ],
  ruby: [
    {
      path: "sdks/ruby/lib/withruntime/version.rb",
      pattern: /^ {2}VERSION = "([^"]*)"$/gm,
      count: 1,
    },
  ],
};

/** Every file that holds a version: a merge that touches one may release. */
export const VERSION_PATHS: readonly string[] = [
  ...new Set(PKGS.flatMap((p) => VERSION_FILES[p].map((s) => s.path))),
];

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type Read = (path: string) => string | undefined;

/** The one version a package's files agree on, or why they don't. */
export function readVersion(pkg: Pkg, read: Read): { version: string } | { refused: string } {
  const seen: { path: string; version: string }[] = [];
  for (const spot of VERSION_FILES[pkg]) {
    const text = read(spot.path);
    if (text === undefined) return { refused: `${spot.path} could not be read` };
    const found = [...text.matchAll(new RegExp(spot.pattern.source, spot.pattern.flags))];
    if (found.length !== spot.count)
      return {
        refused: `${spot.path} names ${pkg}'s version ${found.length} times, not ${spot.count}`,
      };
    for (const m of found) seen.push({ path: spot.path, version: m[1] ?? "" });
  }
  const versions = [...new Set(seen.map((s) => s.version))];
  if (versions.length !== 1)
    return {
      refused: `${pkg}'s files disagree: ${seen.map((s) => `${s.path} says ${s.version}`).join(", ")}`,
    };
  const version = versions[0]!;
  if (!SEMVER.test(version)) return { refused: `${pkg}'s version ${version} is not X.Y.Z` };
  return { version };
}

export type Bump = "patch" | "minor" | "major";

export function bumped(version: string, kind: Bump): string {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`${version} is not X.Y.Z`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Each file of `pkg` with its version set to `version`, by path. The files
 * must agree first: a bump never papers over a disagreement. */
export function withVersion(pkg: Pkg, version: string, read: Read): Record<string, string> {
  const now = readVersion(pkg, read);
  if ("refused" in now) throw new Error(now.refused);
  if (!SEMVER.test(version)) throw new Error(`${version} is not X.Y.Z`);
  const out: Record<string, string> = {};
  for (const spot of VERSION_FILES[pkg]) {
    const text = out[spot.path] ?? read(spot.path)!;
    out[spot.path] = text.replace(
      new RegExp(spot.pattern.source, spot.pattern.flags),
      (whole: string, old: string) => whole.replace(old, version),
    );
  }
  return out;
}

// ── What a pull request says about an SDK: that it changes, not to what ─────
//
// A version is a counter, and a counter every pull request edits is a
// conflict between any two that move one SDK: on 20 October 2026 #1770 and
// #1263 each moved Go to 0.16.0, and whichever landed second met the other
// on that one line. So no pull request edits a version line. It adds a
// change file of its own, `scripts/public-sdk/changes/<pkg>-<id>.txt`, whose
// first line is `<pkg> <patch|minor|major>` (`bun scripts/sdk-version.ts
// bump` writes one): a new file with a name of its own meets no other. The
// hub's SDK release (agents/sdk-release.ts) takes every change file on main,
// moves each SDK once by the largest step asked of it, deletes the files it
// took, and lands that as a pull request of its own; its commit then
// publishes as any version main carries does (control-fleet checks/sdks.rs).

/** The folder of change files, from the repository's root. */
export const CHANGES = "scripts/public-sdk/changes";

/** A change file's path: the folder, then a name of lowercase words. */
export const CHANGE_FILE = /^scripts\/public-sdk\/changes\/[a-z0-9][a-z0-9-]*\.txt$/;

export type Change = { path: string; pkg: Pkg; kind: Bump; note: string };

const KINDS: readonly Bump[] = ["patch", "minor", "major"];

/** A change file read, or why it isn't one. */
export function parseChange(path: string, text: string): Change | { refused: string } {
  if (!CHANGE_FILE.test(path))
    return { refused: `${path} is not a change file's name (${CHANGES}/<pkg>-<words>.txt)` };
  const [first = "", ...rest] = text.split("\n");
  // A package's name may have a hyphen (openai-agents).
  const m = /^([a-z][a-z-]*) (patch|minor|major)$/.exec(first.trim());
  if (!m || !PKGS.includes(m[1] as Pkg))
    return {
      refused: `${path}'s first line is not "<${PKGS.join("|")}> <patch|minor|major>": ${JSON.stringify(first.slice(0, 80))}`,
    };
  return { path, pkg: m[1] as Pkg, kind: m[2] as Bump, note: rest.join("\n").trim() };
}

/** A change file's text. */
export const changeText = (pkg: Pkg, kind: Bump, note = "") =>
  `${pkg} ${kind}\n${note.trim() ? `${note.trim()}\n` : ""}`;

/** The largest step each SDK's changes ask for. */
export function stepsOf(changes: readonly Change[]): Partial<Record<Pkg, Bump>> {
  const out: Partial<Record<Pkg, Bump>> = {};
  for (const c of changes) {
    const was = out[c.pkg];
    if (!was || KINDS.indexOf(c.kind) > KINDS.indexOf(was)) out[c.pkg] = c.kind;
  }
  return out;
}

/** The release of `changes` over the files `read` gives: each SDK moved once
 * by its largest step, every version file it writes by path, and what moved.
 * An SDK's files must agree first (withVersion). */
export function releaseOf(
  changes: readonly Change[],
  read: Read,
): { files: Record<string, string>; moved: { pkg: Pkg; from: string; to: string }[] } {
  const files: Record<string, string> = {};
  const moved: { pkg: Pkg; from: string; to: string }[] = [];
  const steps = stepsOf(changes);
  const now = (path: string) => files[path] ?? read(path);
  for (const pkg of PKGS) {
    const step = steps[pkg];
    if (!step) continue;
    const v = readVersion(pkg, now);
    if ("refused" in v) throw new Error(v.refused);
    const to = bumped(v.version, step);
    Object.assign(files, withVersion(pkg, to, now));
    moved.push({ pkg, from: v.version, to });
  }
  return { files, moved };
}

/** How a change moved version lines as no change may, one line each; empty
 * when it holds. An SDK's version moves only as the release of the change
 * files the same change deletes, by exactly their largest step. `before`
 * and `after` read the files at the change's merge base and at its head;
 * `taken` are the change files there before and gone after, `added` those
 * it adds. */
export function versionMoves(
  before: Read,
  after: Read,
  taken: readonly Change[],
  added: readonly { path: string; text: string }[],
): string[] {
  const out: string[] = [];
  for (const a of added) {
    const c = parseChange(a.path, a.text);
    if ("refused" in c) out.push(c.refused);
  }
  const steps = stepsOf(taken);
  for (const pkg of PKGS) {
    const was = readVersion(pkg, before);
    const now = readVersion(pkg, after);
    if ("refused" in now) {
      out.push(now.refused);
      continue;
    }
    if ("refused" in was) continue;
    const step = steps[pkg];
    if (!step) {
      if (was.version !== now.version)
        out.push(
          `${pkg}'s version moved from ${was.version} to ${now.version}, and no pull request moves a version: put its lines back as main has them and say how it changes, \`bun scripts/sdk-version.ts bump ${pkg} <patch|minor|major>\`; the version is picked when the SDKs are released`,
        );
      continue;
    }
    const want = bumped(was.version, step);
    if (now.version !== want)
      out.push(
        `${pkg}'s change files it takes ask for ${step} (${was.version} to ${want}), but its version is ${now.version}: only \`bun scripts/sdk-version.ts release\` moves it`,
      );
  }
  return out;
}
