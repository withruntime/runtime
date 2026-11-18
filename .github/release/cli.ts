// The publish workflow's steps (publish.yml), run by Node in the public
// mirror from .github/release/, at the mirror's root:
//
//   node .github/release/cli.ts record          COMMIT, RECORD and RELEASE_SIGN_PUB
//                                               in the environment; exit 1 refuses
//   node .github/release/cli.ts decide <target> version=X and do=publish|skip on
//                                               stdout (for $GITHUB_OUTPUT); exit 1 refuses
//   node .github/release/cli.ts wait <target>   until the registry lists main's version
//                                               (the MCP registry checks npm's)
//
// and, in Runtime's main repository before the copy is made:
//
//   bun scripts/public-sdk/release/cli.ts set <pkg> <X.Y.Z>
//                                               every version file of <pkg> at X.Y.Z: CI/CD's SDK
//                                               stage (runtime-land-sdks) writes the version it
//                                               decided into the copy it signs, never into a commit
//   bun scripts/public-sdk/release/cli.ts versions <pkg>
//                                               files=X (its version files) and newest=Y (its
//                                               registry's newest X.Y.Z, empty when none)
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  REGISTRIES,
  type Target,
  TARGETS,
  compare,
  decide,
  onPypi,
  waitsForFirstUpload,
} from "./registries.ts";
import { PKGS, type Pkg, SEMVER, readVersion, withVersion } from "./versions.ts";
import { builderKey, checkDispatch, fromTag } from "./verify-record.ts";

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

function refuse(why: string): never {
  console.error(`REFUSED: ${why}`);
  process.exit(1);
}

function target(name: string | undefined): Target {
  if (!TARGETS.includes(name as Target)) refuse(`no target ${name}; one of ${TARGETS.join(", ")}`);
  return name as Target;
}

function mainVersion(t: Target): string {
  const v = readVersion(REGISTRIES[t].pkg, read);
  if ("refused" in v) refuse(v.refused);
  return v.version;
}

const [command, arg] = process.argv.slice(2);

if (command === "record") {
  // The signature module sits beside this file in the mirror (export.sh).
  const { verify } = await import(new URL("./release-signature.ts", import.meta.url).href);
  let pub;
  try {
    pub = createPublicKey(process.env.RELEASE_SIGN_PUB ?? "");
  } catch {
    refuse("the workflow's RELEASE_SIGN_PUB is not a public key");
  }
  // vin-1's own SDK key, when the workflow pins one: its records name
  // CI/CD's pass (verify-record.ts SDKS_CHECK_VIN1).
  let vin1Pub;
  if (process.env.RELEASE_SIGN_PUB_VIN1?.trim()) {
    try {
      vin1Pub = createPublicKey(process.env.RELEASE_SIGN_PUB_VIN1);
    } catch {
      refuse("the workflow's RELEASE_SIGN_PUB_VIN1 is not a public key");
    }
  }
  // CI/CD's SDK stage's key on next, when the workflow pins one.
  let stagePub;
  if (process.env.RELEASE_SIGN_PUB_STAGE?.trim()) {
    try {
      stagePub = createPublicKey(process.env.RELEASE_SIGN_PUB_STAGE);
    } catch {
      refuse("the workflow's RELEASE_SIGN_PUB_STAGE is not a public key");
    }
  }
  // The pipeline service's key, builder-1: its records are of the trees it pushes after a land.
  let builderPub;
  if (process.env.RELEASE_SIGN_PUB_BUILDER1?.trim()) {
    try {
      builderPub = builderKey(process.env.RELEASE_SIGN_PUB_BUILDER1);
    } catch {
      refuse("the workflow's RELEASE_SIGN_PUB_BUILDER1 is not a public key");
    }
  }
  const message = execFileSync("git", ["log", "-1", "--format=%B", "HEAD"], { encoding: "utf8" });
  let commit = process.env.COMMIT ?? "";
  let record = process.env.RECORD ?? "";
  // A push of vin-1's tag publish/<commit>: the record is its message.
  if (process.env.GITHUB_EVENT_NAME === "push") {
    const ref = process.env.GITHUB_REF ?? "";
    // Each answer, or undefined when the command failed.
    const git = (...args: string[]) => {
      try {
        return execFileSync("git", args, { encoding: "utf8" }).trim();
      } catch {
        return undefined;
      }
    };
    const main = "refs/remotes/origin/main";
    git("fetch", "-q", "--no-tags", "origin", `+${ref}:${ref}`, `+refs/heads/main:${main}`);
    const head = git("rev-parse", "HEAD") ?? "";
    const tagged = fromTag({
      ref,
      type: git("cat-file", "-t", ref) ?? "",
      tag: git("cat-file", "-p", ref) ?? "",
      tagged: git("rev-parse", `${ref}^{commit}`) ?? "",
      head,
      onMain: git("merge-base", "--is-ancestor", head, main) !== undefined,
    });
    if ("refused" in tagged) refuse(tagged.refused);
    commit = tagged.commit;
    record = tagged.record;
  }
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const why = checkDispatch({
    commit,
    record,
    message,
    pub,
    vin1Pub,
    stagePub,
    builderPub,
    tree,
    now: new Date(),
    verify,
  });
  if (why) refuse(why);
  console.error(`The signed record holds for ${process.env.COMMIT}.`);
} else if (command === "decide") {
  const t = target(arg);
  const version = mainVersion(t);
  const published = await REGISTRIES[t].read(fetch);
  if (!Array.isArray(published)) refuse(published.unread);
  // A PyPI project's first upload waits for any before it (waitsForFirstUpload).
  const lists: Partial<Record<Target, readonly string[]>> = { [t]: published };
  if (onPypi(t) && !published.length)
    for (const o of TARGETS.slice(0, TARGETS.indexOf(t)).filter(onPypi)) {
      const l = await REGISTRIES[o].read(fetch);
      if (!Array.isArray(l)) refuse(l.unread);
      lists[o] = l;
    }
  const waits = waitsForFirstUpload(t, (o) => lists[o] ?? []);
  if (waits) {
    console.error(
      `${REGISTRIES[t].label} waits for ${waits}'s first upload: PyPI holds one pending publisher for \`release\`.`,
    );
    console.log(`version=${version}\ndo=skip`);
    process.exit(0);
  }
  const d = decide(version, published, REGISTRIES[t].label);
  if ("refused" in d) refuse(d.refused);
  console.error(
    d.do === "skip"
      ? `${REGISTRIES[t].label} has ${version} already: skipped.`
      : `${REGISTRIES[t].label}: ${version} goes out.`,
  );
  console.log(`version=${version}\ndo=${d.do}`);
} else if (command === "wait") {
  const t = target(arg);
  const version = mainVersion(t);
  for (let i = 0; ; i++) {
    const published = await REGISTRIES[t].read(fetch);
    if (Array.isArray(published) && published.includes(version)) break;
    if (i >= 600) refuse(`${REGISTRIES[t].label} does not list ${version} after 20 minutes`);
    console.error(`Waiting for ${REGISTRIES[t].label} to list ${version}...`);
    // Read every 2 s: a 20 s pause left the MCP publish waiting up to 20 s
    // past npm's own listing (10 s on average), for one small read.
    await new Promise((r) => setTimeout(r, 2_000));
  }
} else if (command === "set") {
  // The files must agree first (withVersion): a set never papers over a
  // disagreement, and a version only ever moves forward from them.
  const pkg = arg as Pkg;
  const version = process.argv[4] ?? "";
  if (!PKGS.includes(pkg)) refuse(`no SDK ${arg}; one of ${PKGS.join(", ")}`);
  const now = readVersion(pkg, read);
  if ("refused" in now) refuse(now.refused);
  let files: Record<string, string>;
  try {
    files = withVersion(pkg, version, read);
  } catch (e) {
    refuse((e as Error).message);
  }
  for (const [path, text] of Object.entries(files)) writeFileSync(path, text);
  console.error(`${pkg}: ${now.version} -> ${version}`);
} else if (command === "versions") {
  // What CI/CD's SDK stage moves a version from: the one the files name,
  // and the newest X.Y.Z the SDK's first registry lists (none: empty).
  const pkg = arg as Pkg;
  if (!PKGS.includes(pkg)) refuse(`no SDK ${arg}; one of ${PKGS.join(", ")}`);
  const files = readVersion(pkg, read);
  if ("refused" in files) refuse(files.refused);
  const t = TARGETS.find((t) => REGISTRIES[t].pkg === pkg)!;
  const published = await REGISTRIES[t].read(fetch);
  if (!Array.isArray(published)) refuse(published.unread);
  const releases = published.map((v) => v.replace(/^v/, "")).filter((v) => SEMVER.test(v));
  const newest = releases.sort(compare).at(-1) ?? "";
  console.log(`files=${files.version}\nnewest=${newest}`);
} else
  refuse(
    "usage: cli.ts record | decide <target> | wait <target> | set <pkg> <X.Y.Z> | versions <pkg>",
  );
