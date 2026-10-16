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
/** A dispatch can wait for a runner, and the npm job waits for nothing but
 * this one: longer than the followers' 10 minutes, still short. */
export const RECORD_MAX_AGE_MS = 30 * 60_000;

const FULL_SHA = /^[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** A record is about 400 bytes; its base64, under this. */
export const RECORD_MAX_INPUT = 4096;

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
  const verdict = input.verify(
    text,
    input.pub,
    { action: "release", target: SDKS_TARGET, sha: input.commit, hosts: SDKS_HOSTS },
    input.now,
    { maxAgeMs: RECORD_MAX_AGE_MS },
  );
  if (!verdict.ok) return verdict.why;
  if (verdict.signed.check !== SDKS_CHECK)
    return `the record names ${verdict.signed.check}, not ${SDKS_CHECK}`;
  return undefined;
}
