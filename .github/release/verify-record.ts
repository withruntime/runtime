// The publish workflow's first step in every job (publish.yml): it publishes only a copy the line made and signed
// (Marc, 14 October 2026). Anyone who can push a tag to the public mirror could start this workflow, so it takes
// nothing on their word: the tag `publish/<commit>` carries a record signed by the line's key, builder-1, checked
// here with that key's public half written into the workflow itself. The record names the commit of Runtime's main
// repository the copy came from (its "Copied from" line), the mirror tree it publishes, exactly, and each package's
// version (`due=`), and is at most 30 minutes old.
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";

export const SDKS_TARGET = "sdks";
/** A tag waits for runners: longer than a push takes, still short. */
export const RECORD_MAX_AGE_MS = 30 * 60_000;

const FULL_SHA = /^[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The line's records (engines/products/crates/pipelines sdks.rs `record`): one for the landed commit, the mirror
 * tree it pushes and the versions due, signed with its one key, builder-1 (engines/cell/deploy/builder.pub), over
 * `runtime sdk record v1\ncommit <sha>\nsha256 <the record's sha256>\n`. The tag's message is the record, then
 * `builder-1=<signature>`. */
export const BUILT_SIGNER = "builder-1";
export const BUILT_SIGNS_AS = "runtime sdk record";
const BUILT_FIELDS = ["target", "sha", "tree", "due", "at"];
/** A record signed after the step's tests is pushed in seconds: one dated ahead of the runner's clock by more than
 * this is no record of ours. */
const SKEW_MS = 5 * 60_000;

/** builder-1's public half as builder.pub writes it (base64 of the 32 bytes). */
export function builderKey(raw: string): KeyObject {
  const bytes = Buffer.from(raw.trim(), "base64");
  if (bytes.length !== 32) throw new Error("not a 32-byte Ed25519 public key");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/** Why a record the line signed does not publish this copy (`commit`, the mirror commit's `tree`), or its due line
 * when it does: builder-1's signature over the record and the landed commit, each field exactly, and at most 30
 * minutes old. */
export function checkBuilt(
  text: string,
  input: { commit: string; tree?: string; pub: KeyObject | undefined; now: Date },
): { refused: string } | { due: string } {
  const why = refusal(text, input);
  if (why) return { refused: why };
  return { due: text.split("\n").find((l) => l.startsWith("due=")) ?? "due=" };
}

function refusal(
  text: string,
  input: { commit: string; tree?: string; pub: KeyObject | undefined; now: Date },
): string | undefined {
  const at = text.lastIndexOf(`\n${BUILT_SIGNER}=`);
  if (at < 0) return `the record carries no ${BUILT_SIGNER} signature`;
  const record = text.slice(0, at + 1);
  const sig = text.slice(at + BUILT_SIGNER.length + 2).trim();
  if (!BASE64.test(sig) || Buffer.from(sig, "base64").length !== 64)
    return `the record's ${BUILT_SIGNER} signature is not an Ed25519 signature`;
  if (!input.pub) return `the workflow pins no ${BUILT_SIGNER} key`;
  const lines = record.slice(0, -1).split("\n");
  const fields = new Map(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  if (lines.length !== BUILT_FIELDS.length || lines.some((l, i) => !l.startsWith(`${BUILT_FIELDS[i]}=`)))
    return `the record's fields are not ${BUILT_FIELDS.join(", ")}`;
  const hex = createHash("sha256").update(record).digest("hex");
  const signed = `${BUILT_SIGNS_AS} v1\ncommit ${input.commit}\nsha256 ${hex}\n`;
  if (!edVerify(null, Buffer.from(signed), input.pub, Buffer.from(sig, "base64")))
    return `${BUILT_SIGNER}'s signature does not hold for this record and ${input.commit.slice(0, 9)}`;
  if (fields.get("target") !== SDKS_TARGET) return `the record is for ${fields.get("target")}, not ${SDKS_TARGET}`;
  if (fields.get("sha") !== input.commit)
    return `the record names ${fields.get("sha")?.slice(0, 9)}, not ${input.commit.slice(0, 9)}`;
  if (fields.get("tree") !== input.tree)
    return `the record names the tree ${fields.get("tree")?.slice(0, 9)}, not this copy's ${(input.tree ?? "(unread)").slice(0, 9)}`;
  const when = Date.parse(fields.get("at") ?? "");
  if (!Number.isFinite(when)) return "the record names no time";
  const age = input.now.getTime() - when;
  if (age > RECORD_MAX_AGE_MS) return `the record is ${Math.round(age / 60_000)} minutes old`;
  if (age < -SKEW_MS) return "the record is dated ahead of this runner's clock";
  return undefined;
}

/** The tags the line publishes with: `publish/<commit>`. */
export const PUBLISH_TAG = "refs/tags/publish/";

/** The commit and record a pushed `publish/<commit>` tag carries, or why it carries none. `tag` is `git cat-file
 * -p` of the tag object (only an annotated tag has a message), `tagged` the commit it names, `head` the commit
 * checked out (the run's), and `onMain` whether `head` is on the mirror's main: a tag elsewhere publishes nothing.
 * The record is then checked by [checkBuilt]. */
export function fromTag(input: {
  ref: string;
  type: string;
  tag: string;
  tagged: string;
  head: string;
  onMain: boolean;
}): { commit: string; record: string } | { refused: string } {
  if (!input.ref.startsWith(PUBLISH_TAG)) return { refused: `${input.ref} is not a publish tag` };
  const commit = input.ref.slice(PUBLISH_TAG.length);
  if (!FULL_SHA.test(commit)) return { refused: "the tag names no full commit" };
  if (input.type.trim() !== "tag")
    return { refused: "the tag is not annotated: it carries no record" };
  if (!FULL_SHA.test(input.head) || input.tagged !== input.head)
    return { refused: "the tag does not name the commit checked out" };
  if (!input.onMain) return { refused: "the tagged commit is not on the mirror's main" };
  const at = input.tag.indexOf("\n\n");
  if (at < 0) return { refused: "the tag carries no message" };
  return { commit, record: input.tag.slice(at + 2).trim() + "\n" };
}

/** The line the line's copy commit carries, naming its source. */
export const copiedLine = (sha: string) => `Copied from ${sha}`;

/** The one source commit a copy's message names, or undefined. */
export function copiedFrom(message: string): string | undefined {
  const found = [...message.matchAll(/^Copied from ([0-9a-f]{40})$/gm)];
  return found.length === 1 ? found[0]![1] : undefined;
}
