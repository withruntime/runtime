// Where each SDK's version is written (Marc, 14 October 2026: agents update
// and publish the SDKs by themselves). One package's version is in several
// files, and a release with them apart ships a client that names another
// version than the one installed: scripts/sdk-version.ts moves them together
// and refuses files that disagree, the hub reads them to know what to
// publish (agents/sdks.ts), and the publish workflow in the public mirror
// reads them again before each upload (cli.ts). Node runs this file in the
// mirror with its types stripped, so it imports nothing and uses no syntax
// that has to be compiled.

export type Pkg = "js" | "python" | "langchain" | "go" | "java" | "ruby";
export const PKGS: readonly Pkg[] = ["js", "python", "langchain", "go", "java", "ruby"];

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
