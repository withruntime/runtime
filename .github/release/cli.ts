// The SDK release's steps. In the public mirror, the publish workflow's (publish.yml), run by Node from
// .github/release/ at the mirror's root:
//
//   node .github/release/cli.ts record          the tag's record checked with RELEASE_SIGN_PUB_BUILDER1;
//                                               due=<its line> on stdout (for $GITHUB_OUTPUT); exit 1 refuses
//   node .github/release/cli.ts decide <target> version=X and do=publish|skip on stdout, from DUE (the record's
//                                               due line); exit 1 refuses
//   node .github/release/cli.ts wait <target>   until the registry lists DUE's version of it
//
// and on the line, from its checkout of the landed commit, before and after export.sh writes the copy
// (engines/products/crates/pipelines sdks.rs):
//
//   bun scripts/public-sdk/release/cli.ts next MIRROR SRC
//                                               each SDK's next version (`js=X python=X ruby=X go=X java=X`),
//                                               for export.sh's SDK_VERSIONS
//   bun scripts/public-sdk/release/cli.ts due MIRROR OUT js=X python=X ...
//                                               each SDK in OUT whose tree is the mirror's, its version lines aside,
//                                               and whose mirror version its registry lists, put back as the mirror
//                                               has it; the due line of the rest on stdout
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { REGISTRIES, type Target, TARGETS, decide } from "./registries.ts";
import { PKGS, SDKS, dueLine, dueOf, next, stepOf, unversioned } from "./versions.ts";
import { builderKey, checkBuilt, copiedFrom, fromTag } from "./verify-record.ts";

function refuse(why: string): never {
  console.error(`REFUSED: ${why}`);
  process.exit(1);
}

function target(name: string | undefined): Target {
  if (!TARGETS.includes(name as Target)) refuse(`no target ${name}; one of ${TARGETS.join(", ")}`);
  return name as Target;
}

/** The version the record's due line names for `t`, or undefined when it names none. */
const dueVersion = (t: Target) => dueOf(process.env.DUE ?? "").get(t);

const git = (dir: string, ...args: string[]) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Every file under `dir`, relative to it, sorted. */
function files(dir: string, at = ""): string[] {
  if (!existsSync(join(dir, at))) return [];
  return readdirSync(join(dir, at))
    .sort()
    .flatMap((n) => (statSync(join(dir, at, n)).isDirectory() ? files(dir, join(at, n)) : [join(at, n)]));
}

const [command, arg, arg2] = process.argv.slice(2);

if (command === "record") {
  let pub;
  try {
    pub = builderKey(process.env.RELEASE_SIGN_PUB_BUILDER1 ?? "");
  } catch {
    refuse("the workflow's RELEASE_SIGN_PUB_BUILDER1 is not a public key");
  }
  const ref = process.env.GITHUB_REF ?? "";
  const main = "refs/remotes/origin/main";
  git(".", "fetch", "-q", "--no-tags", "origin", `+${ref}:${ref}`, `+refs/heads/main:${main}`);
  const head = git(".", "rev-parse", "HEAD") ?? "";
  const tagged = fromTag({
    ref,
    type: git(".", "cat-file", "-t", ref) ?? "",
    tag: git(".", "cat-file", "-p", ref) ?? "",
    tagged: git(".", "rev-parse", `${ref}^{commit}`) ?? "",
    head,
    onMain: git(".", "merge-base", "--is-ancestor", head, main) !== undefined,
  });
  if ("refused" in tagged) refuse(tagged.refused);
  const copied = copiedFrom(git(".", "log", "-1", "--format=%B", "HEAD") ?? "");
  if (copied !== tagged.commit)
    refuse(`this mirror commit is a copy of ${copied?.slice(0, 9) ?? "nothing"}, not ${tagged.commit.slice(0, 9)}`);
  const verdict = checkBuilt(tagged.record, {
    commit: tagged.commit,
    tree: git(".", "rev-parse", "HEAD^{tree}"),
    pub,
    now: new Date(),
  });
  if ("refused" in verdict) refuse(verdict.refused);
  console.error(`The signed record holds for ${tagged.commit}: ${verdict.due}`);
  console.log(`due=${verdict.due.replace(/^due=/, "")}`);
} else if (command === "decide") {
  const t = target(arg);
  const version = dueVersion(t);
  if (!version) {
    console.error(`${REGISTRIES[t].label}: not in this release: skipped.`);
    console.log("do=skip");
    process.exit(0);
  }
  const published = await REGISTRIES[t].read(fetch);
  if (!Array.isArray(published)) refuse(published.unread);
  const d = decide(version, published, REGISTRIES[t].label);
  if ("refused" in d) refuse(d.refused);
  console.error(
    d.do === "skip" ? `${REGISTRIES[t].label} has ${version} already: skipped.` : `${REGISTRIES[t].label}: ${version} goes out.`,
  );
  console.log(`version=${version}\ndo=${d.do}`);
} else if (command === "wait") {
  const t = target(arg);
  const version = dueVersion(t) ?? refuse(`the release names no version of ${t}`);
  for (let i = 0; ; i++) {
    const published = await REGISTRIES[t].read(fetch);
    if (Array.isArray(published) && published.includes(version)) break;
    if (i >= 600) refuse(`${REGISTRIES[t].label} does not list ${version} after 20 minutes`);
    console.error(`Waiting for ${REGISTRIES[t].label} to list ${version}...`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
} else if (command === "next") {
  const mirror = arg ?? refuse("next MIRROR SRC");
  const src = arg2 ?? refuse("next MIRROR SRC");
  const spec = read(join(src, "engines/front/crates/spec/openapi/v2.json")) ?? refuse(`${src} holds no API description`);
  const step = stepOf(spec, read(join(mirror, SDKS.js.dir, "openapi.json")));
  // What the mirror's newest record sent, by target: its tags are the line's own record of what it published.
  const last = (git(mirror, "tag", "-l", "publish/*", "--sort=-creatordate") ?? "").split("\n").filter(Boolean)[0];
  const sent = dueOf(
    (last ? (git(mirror, "tag", "-l", "--format=%(contents)", last) ?? "") : "").split("\n").find((l) => l.startsWith("due=")) ?? "",
  );
  const out: string[] = [];
  for (const pkg of PKGS) {
    const t = SDKS[pkg].targets[0] as Target;
    const listed = await REGISTRIES[t].read(fetch);
    if (!Array.isArray(listed)) refuse(listed.unread);
    out.push(`${pkg}=${next(listed, sent.get(t), step)}`);
  }
  console.error(`The API's description ${step === "minor" ? "changed" : "did not change"}: each due SDK takes a ${step} step.`);
  console.log(out.join(" "));
} else if (command === "due") {
  const mirror = arg ?? refuse("due MIRROR OUT");
  const out = arg2 ?? refuse("due MIRROR OUT");
  // The versions export.sh wrote, as `next` printed them.
  const versions = new Map(process.argv.slice(5).map((w) => w.split("=") as [string, string]));
  const due: { pkg: (typeof PKGS)[number]; version: string }[] = [];
  for (const pkg of PKGS) {
    const { dir, versioned } = SDKS[pkg];
    const [a, b] = [join(mirror, dir), join(out, dir)];
    const same = (() => {
      const [fa, fb] = [files(a), files(b)];
      if (fa.join("\n") !== fb.join("\n")) return false;
      return fb.every((f) => {
        const [x, y] = [readFileSync(join(a, f), "utf8"), readFileSync(join(b, f), "utf8")];
        return x === y || (versioned.includes(f) && unversioned(x) === unversioned(y));
      });
    })();
    // The version the mirror's copy names, published: a copy whose upload failed (or never ran) is due again.
    const held = SDKS[pkg].named.exec(read(join(a, versioned[0]!)) ?? "")?.[1];
    const listed = held ? await REGISTRIES[SDKS[pkg].targets[0] as Target].read(fetch) : [];
    if (!Array.isArray(listed)) refuse(listed.unread);
    if (same && held && listed.map((v) => v.replace(/^v/, "")).includes(held)) {
      // Nothing changed: the copy keeps the version the registry has.
      rmSync(b, { recursive: true, force: true });
      cpSync(a, b, { recursive: true });
      continue;
    }
    const v = versions.get(pkg) ?? refuse(`no version of ${pkg} among ${process.argv.slice(5).join(" ")}`);
    due.push({ pkg, version: v });
  }
  console.log(dueLine(due));
} else refuse("usage: cli.ts record | decide <target> | wait <target> | next MIRROR SRC | due MIRROR OUT VERSIONS...");

