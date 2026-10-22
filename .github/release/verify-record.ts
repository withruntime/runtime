// The publish workflow's first job (publish.yml): it publishes only a copy
// the hub made and asked for (Marc, 14 October 2026). Anyone who can start a
// workflow in the public mirror could start this one, so it takes nothing on
// their word: the dispatch carries a record signed by the hub's release
// signer (agents/release-signer.py), checked here with the signer's public
// key written into the workflow itself, with the same verify() the deploy
// followers use (packages/cloud/deploy/release-signature.ts, copied beside
// this file in the mirror). The record must be for target `sdks`, for the
// commit of Runtime's main repository this copy came from (its "Copied from"
// line, which only the hub's GitHub App writes: the mirror's rulesets), and at
// most 30 minutes old. The signer signs it only for a commit on main that
// passed the hub's full check.
import type { KeyObject } from "node:crypto";
import type { verify as Verify } from "../../../packages/cloud/deploy/release-signature.ts";

export const SDKS_TARGET = "sdks";
/** The signer names a host walk in every release record; an SDK release
 * walks no host, so it names vin-0, which no follower walks (as the
 * signer's self-test does). */
export const SDKS_HOSTS = "vin-0";
export const SDKS_CHECK = "runtime/full-check";
/** What vin-1's own SDK key signs for (engines control-fleet checks/sdks.rs):
 * a commit its follower admitted on CI/CD's landed pass of main. Each key
 * is held to its own check: the hub's never names this one, vin-1's never
 * the hub's. */
export const SDKS_CHECK_VIN1 = "runtime/ci-cd";
/** A dispatch can wait for a runner, and the npm job waits for nothing but
 * this one: longer than the followers' 10 minutes, still short. */
export const RECORD_MAX_AGE_MS = 30 * 60_000;

const FULL_SHA = /^[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** A record is about 400 bytes; its base64, under this. */
export const RECORD_MAX_INPUT = 4096;

/** The tags vin-1 publishes with: `publish/<commit>`. */
export const PUBLISH_TAG = "refs/tags/publish/";

/** The commit and record a pushed `publish/<commit>` tag carries, as the
 * dispatch's inputs would, or why it carries none. `tag` is `git cat-file
 * -p` of the tag object (only an annotated tag has a message), `tagged` the
 * commit it names, `head` the commit checked out (the run's), and `onMain`
 * whether `head` is on the mirror's main: a tag elsewhere publishes nothing,
 * as a dispatch runs on main only. The record is then checked by
 * checkDispatch exactly as a dispatch's. */
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
  const record = Buffer.from(input.tag.slice(at + 2).trim() + "\n").toString("base64");
  return { commit, record };
}

/** The line the hub's copy commit carries, naming its source. */
export const copiedLine = (sha: string) => `Copied from ${sha}`;

/** The one source commit a copy's message names, or undefined. */
export function copiedFrom(message: string): string | undefined {
  const found = [...message.matchAll(/^Copied from ([0-9a-f]{40})$/gm)];
  return found.length === 1 ? found[0]![1] : undefined;
}

/** Why this dispatch publishes nothing, or undefined when it may. `record`
 * is base64: a workflow input is one line. */
export function checkDispatch(input: {
  commit: string;
  record: string;
  message: string;
  pub: KeyObject | undefined;
  /** vin-1's own SDK key (RELEASE_SIGN_PUB_VIN1), for its records alone. */
  vin1Pub?: KeyObject | undefined;
  /** The tree of the mirror commit checked out, which every job publishes
   * from (`git rev-parse HEAD^{tree}`). vin-1 signs the tree it read back
   * with its own git from the copy it pushed, so its record publishes only
   * that exact tree. */
  tree?: string;
  now: Date;
  verify: typeof Verify;
}): string | undefined {
  if (!FULL_SHA.test(input.commit)) return "the commit input is not a full sha";
  // The inputs are anyone's who can start a workflow: read only as data,
  // and only in the shape the hub sends.
  if (input.record.length > RECORD_MAX_INPUT || !BASE64.test(input.record))
    return `the record input is not base64 under ${RECORD_MAX_INPUT} characters`;
  const copied = copiedFrom(input.message);
  if (!copied)
    return "this mirror commit names no single source (no Copied from line): the hub did not make it";
  if (copied !== input.commit)
    return `this mirror commit is a copy of ${copied.slice(0, 9)}, not ${input.commit.slice(0, 9)}`;
  const text = Buffer.from(input.record, "base64").toString("utf8");
  // verify() takes exactly the record's fields, in order, and refuses a
  // line more or less; the action and target are asked for exactly: a
  // record the signer gave for anything else (a host, controller, settings
  // or follower release, a lifted hold) publishes nothing.
  // Each key is asked only for the check it signs for: the hub's for its
  // full check, vin-1's for CI/CD's pass. A record either signed that names
  // the other's check publishes nothing.
  const want = {
    action: "release" as const,
    target: SDKS_TARGET,
    sha: input.commit,
    hosts: SDKS_HOSTS,
  };
  const keys = [
    { pub: input.pub, check: SDKS_CHECK },
    ...(input.vin1Pub ? [{ pub: input.vin1Pub, check: SDKS_CHECK_VIN1 }] : []),
  ];
  let why = "no key to check the record with";
  for (const key of keys) {
    const verdict = input.verify(text, key.pub, want, input.now, { maxAgeMs: RECORD_MAX_AGE_MS });
    if (!verdict.ok) {
      // The hub's answer is the one told when no key signed it.
      if (key === keys[0]) why = verdict.why;
      continue;
    }
    if (verdict.signed.check !== key.check)
      return `the record names ${verdict.signed.check}, not ${key.check}`;
    // vin-1's record names the mirror copy's own tree: a copy other than the
    // one it checked and pushed publishes nothing.
    if (key.check === SDKS_CHECK_VIN1 && verdict.signed.tree !== input.tree)
      return `the record names the tree ${verdict.signed.tree.slice(0, 9)}, not this copy's ${(input.tree ?? "(unread)").slice(0, 9)}`;
    return undefined;
  }
  return why;
}
