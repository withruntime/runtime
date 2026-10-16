// The publish workflow's steps (publish.yml), run by Node in the public
// mirror from .github/release/, at the mirror's root:
//
//   node .github/release/cli.ts record          COMMIT, RECORD and RELEASE_SIGN_PUB
//                                               in the environment; exit 1 refuses
//   node .github/release/cli.ts decide <target> version=X and do=publish|skip on
//                                               stdout (for $GITHUB_OUTPUT); exit 1 refuses
//   node .github/release/cli.ts wait <target>   until the registry lists main's version
//                                               (the MCP registry checks npm's)
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { REGISTRIES, type Target, TARGETS, decide } from "./registries.ts";
import { readVersion } from "./versions.ts";
import { checkDispatch } from "./verify-record.ts";

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
  const message = execFileSync("git", ["log", "-1", "--format=%B", "HEAD"], { encoding: "utf8" });
  const why = checkDispatch({
    commit: process.env.COMMIT ?? "",
    record: process.env.RECORD ?? "",
    message,
    pub,
    now: new Date(),
    verify,
  });
  if (why) refuse(why);
  console.error(`The hub's signed record holds for ${process.env.COMMIT}.`);
} else if (command === "decide") {
  const t = target(arg);
  const version = mainVersion(t);
  const published = await REGISTRIES[t].read(fetch);
  if (!Array.isArray(published)) refuse(published.unread);
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
    if (i >= 60) refuse(`${REGISTRIES[t].label} does not list ${version} after 20 minutes`);
    console.error(`Waiting for ${REGISTRIES[t].label} to list ${version}...`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
} else refuse("usage: cli.ts record | decide <target> | wait <target>");
