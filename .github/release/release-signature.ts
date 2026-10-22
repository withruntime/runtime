/* The signature that makes a ref move Marc's word (13 October 2026). Every
 * agent has the hub's GitHub token, so a ref on origin proves nothing about
 * who moved it: deploy/hostd, and the deletion of deploy/hold, count only
 * with a record signed (Ed25519) with the hub's private key. Only the release
 * signer holds it (agents/release-signer.py: root's, in the hub sandbox,
 * where nothing else has root), never a file the hub reads (code on main
 * runs there) nor a Runtime secret placeholder (any sandbox could use one).
 * The follower's server holds only the public key
 * (~/.runtime/release-sign.pub), so it can check a release and never sign
 * one. The hub asks for a signature only on Marc's press on its own card, or
 * the release train's (agents/release.ts). The follower (follow-deploy.ts)
 * refuses anything unsigned, forged, signed for another sha, target or host
 * set, older than 10 minutes, or whose nonce it has used before, and checks
 * again before every host. Anything it cannot read is a refusal.
 *
 * The record is the message of an annotated tag, signed/<target> for a
 * release, signed/unhold for a lifted hold, and signed/prebuild-<n> for a
 * pull request head whose engines are built ahead of its merge
 * (action=prebuild, target=engines, hosts=all, check=runtime/prebuild):
 *
 *   runtime-release v3
 *   action=release
 *   target=hostd
 *   sha=<40 hex>
 *   tree=<40 hex: the commit's tree, as GitHub gave it to the hub>
 *   hosts=vin-10,vin-4,vin-2,...       (the walk, in order; "all" for a lift)
 *   check=runtime/full-check
 *   nonce=<32 hex, fresh for each press>
 *   at=2026-10-13T17:00:00.000Z        (it expires 10 minutes later)
 *   sig=<Ed25519 signature of the lines above, base64>
 *
 * A host order (Marc's `reinstall`, `rejoin` or `monitor` in #agents,
 * agents/release.ts) is the same record for the target reinstall, which the
 * follower's server runs (follow-targets/reinstall.ts): action reinstall,
 * rejoin or monitor, hosts one host, sha main's commit whose scripts it runs,
 * and check what it is to do: plain/<OVH service> (OVH's installer),
 * encrypted/<OVH service> (OVH's rescue system and encrypted-install.sh),
 * monitor/<OVH service> (OVH's monitoring back on), or rejoin (every
 * controller) or rejoin/<controller> (that one alone).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const SIGNED_MAX_AGE_MS = 10 * 60_000;
/** A clock a little ahead of the follower's is fine; one far ahead is not. */
export const SIGNED_FUTURE_MS = 60_000;
/** The target a lifted hold names: deploy/hold holds every follower. */
export const HOLD_TARGET = "hosts";
/** What a prebuild record names (engines-archive.ts, signed by
 * release-signer.py for the head of an open pull request into main that the
 * hub's App vouched for with runtime/prebuild, after every gate of the hub's
 * own passed it): its target, hosts and check. */
export const PREBUILD = { target: "engines", hosts: "all", check: "runtime/prebuild" } as const;
/** How many heads wait at most: the hub writes the newest into one of this
 * many tags (signed/prebuild-1 to -3), and the prebuilder keeps the newest
 * this many it took. */
export const PREBUILD_SLOTS = 3;
export const prebuildSlot = (n: number) => `prebuild-${n}`;

/** The target every host order is signed for: the follower that runs them. */
export const ORDER_TARGET = "reinstall";
export const ORDER_ACTIONS = ["reinstall", "rejoin", "monitor"] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];
/** An OVH service name, as reverse DNS gives it (src/ovh-reinstall.ts SERVICE). */
const OVH_SERVICE = "ns[0-9]+\\.ip-[0-9]+-[0-9]+-[0-9]+\\.(us|eu|net)";
/** What each order's check field may say. */
export const ORDER_CHECK: Record<OrderAction, RegExp> = {
  reinstall: new RegExp(`^(plain|encrypted)/${OVH_SERVICE}$`),
  monitor: new RegExp(`^monitor/${OVH_SERVICE}$`),
  rejoin: /^rejoin(\/vin-\d+)?$/,
};
/** For the follower of host orders alone: any one host, which it checks. */
export const ANY_HOST: unique symbol = Symbol("any host");

export const isOrderAction = (action: string): action is OrderAction =>
  (ORDER_ACTIONS as readonly string[]).includes(action);

export type Signed = {
  /** prebuild: build these engines ahead of merge (engines-archive.ts),
   * never a release: a follower takes only its own action. ship: Marc's
   * ship it of a pull request's head, which CI/CD's gate reads
   * (agents/ship-it.ts shipRefusal), never a follower. */
  action: "release" | "unhold" | "prebuild" | "ship" | OrderAction;
  target: string;
  sha: string;
  tree: string;
  hosts: string;
  check: string;
  nonce: string;
  at: string;
};
const FIELDS = ["action", "target", "sha", "tree", "hosts", "check", "nonce", "at"] as const;
const HEADER = "runtime-release v3";

/** The annotated tag that carries a target's record (or "unhold"'s). */
export const signedTag = (name: string) => `signed/${name}`;
export const newNonce = () => randomBytes(16).toString("hex");

function body(s: Signed): string {
  return [HEADER, ...FIELDS.map((f) => `${f}=${s[f]}`)].join("\n");
}

export function sign(s: Signed, key: KeyObject): string {
  if (key.type !== "private") throw new Error("only a private key signs");
  if (!/^[a-z]+$/.test(s.target) || !/^[0-9a-f]{40}$/.test(s.sha) || !/^[0-9a-f]{40}$/.test(s.tree))
    throw new Error("a signed record names a target, a full sha and its tree");
  if (!/^(all|vin-\d+(,vin-\d+)*)$/.test(s.hosts) || !/^[0-9a-f]{32}$/.test(s.nonce))
    throw new Error("a signed record names its hosts and a fresh nonce");
  if (isOrderAction(s.action)) {
    if (s.target !== ORDER_TARGET || !/^vin-\d+$/.test(s.hosts))
      throw new Error("a host order is for the reinstall target and one host");
    if (!ORDER_CHECK[s.action].test(s.check)) throw new Error(`not what a ${s.action} order says`);
  } else if (!/^[a-z0-9/_-]+$/.test(s.check)) throw new Error("a signed record names its check");
  if (Number.isNaN(Date.parse(s.at))) throw new Error("a signed record names its time");
  return `${body(s)}\nsig=${edSign(null, Buffer.from(body(s)), key).toString("base64")}\n`;
}

export type Verdict = { ok: true; signed: Signed } | { ok: false; why: string };

/** Whether `text` is a record signed with the key whose public half is
 * `key`, for `want`, no older than 10
 * minutes at `now`, with a nonce not in `used`. `accepted`, the nonce of the
 * record the follower already took for this very sha, is neither held to the
 * age nor counted as used: a walk lasts longer than ten minutes. `maxAgeMs`
 * replaces the 10 minutes for a reader that waits longer before it reads,
 * such as the SDK publish workflow, queued on GitHub's runners (14 October
 * 2026, scripts/public-sdk/release/verify-record.ts). */
export function verify(
  text: string | undefined,
  key: KeyObject | undefined,
  want: {
    /** Several: any of them, as the follower of host orders takes each. */
    action: Signed["action"] | readonly Signed["action"][];
    target: string;
    sha?: string;
    /** The host set signed, or ANY_HOST: one host order's, which the
     * reader then checks itself. Never undefined. */
    hosts: string | typeof ANY_HOST;
  },
  now: Date,
  options: { accepted?: string; used?: readonly string[]; maxAgeMs?: number } = {},
): Verdict {
  try {
    if (!key) return { ok: false, why: "no signing key here (release-sign.key)" };
    if (!text?.trim()) return { ok: false, why: "unsigned: no signed record on origin" };
    const lines = text.trim().split("\n");
    if (lines.length !== FIELDS.length + 2 || lines[0] !== HEADER)
      return { ok: false, why: "not a signed record" };
    const fields: Record<string, string> = {};
    for (const [i, f] of FIELDS.entries()) {
      const line = lines[i + 1]!;
      if (!line.startsWith(`${f}=`)) return { ok: false, why: "not a signed record" };
      fields[f] = line.slice(f.length + 1);
    }
    const sig = /^sig=([A-Za-z0-9+/=]{80,100})$/.exec(lines.at(-1)!)?.[1];
    const signed = fields as Signed;
    if (!sig || !edVerify(null, Buffer.from(body(signed)), key, Buffer.from(sig, "base64")))
      return { ok: false, why: "forged: its signature is not the hub's" };
    const actions: readonly string[] =
      typeof want.action === "string" ? [want.action] : want.action;
    if (!actions.includes(signed.action) || signed.target !== want.target)
      return {
        ok: false,
        why: `signed for ${signed.action} of ${signed.target}, not ${actions.join(" or ")} of ${want.target}`,
      };
    if (isOrderAction(signed.action) && !ORDER_CHECK[signed.action].test(signed.check))
      return { ok: false, why: `not what a ${signed.action} order says: ${signed.check}` };
    if (want.sha !== undefined && signed.sha !== want.sha)
      return {
        ok: false,
        why: `signed for ${signed.sha.slice(0, 9)}, not ${want.sha.slice(0, 9)}`,
      };
    if (want.hosts !== ANY_HOST && signed.hosts !== want.hosts)
      return { ok: false, why: `signed for hosts ${signed.hosts}, not ${want.hosts}` };
    if (!/^[0-9a-f]{32}$/.test(signed.nonce)) return { ok: false, why: "no nonce" };
    const at = Date.parse(signed.at);
    if (Number.isNaN(at)) return { ok: false, why: "its time does not read" };
    if (at > now.getTime() + SIGNED_FUTURE_MS)
      return { ok: false, why: `dated ${signed.at}, in the future` };
    if (signed.nonce === options.accepted) return { ok: true, signed };
    if (options.used?.includes(signed.nonce))
      return { ok: false, why: "already used: a replayed record. Press it again" };
    const maxAge = options.maxAgeMs ?? SIGNED_MAX_AGE_MS;
    if (now.getTime() - at > maxAge)
      return {
        ok: false,
        why: `signed at ${signed.at}, older than ${Math.round(maxAge / 60_000)} minutes: press it again`,
      };
    return { ok: true, signed };
  } catch (error) {
    return { ok: false, why: `the record could not be checked: ${String(error)}` };
  }
}

/** The hub's private key: a PEM file only its owner reads. Anything else,
 * or a file that cannot be read, is no key. */
export function readPrivateKey(path: string): KeyObject | undefined {
  try {
    if ((statSync(path).mode & 0o077) !== 0) return undefined;
    const key = createPrivateKey(readFileSync(path, "utf8"));
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

/** The follower's public key: a PEM file nobody else may change. */
export function readPublicKey(path: string): KeyObject | undefined {
  try {
    if ((statSync(path).mode & 0o022) !== 0) return undefined;
    const key = createPublicKey(readFileSync(path, "utf8"));
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

/** A public key's fingerprint: SHA-256 of its DER, in hex. The follower
 * reports its pin's (follow-deploy.ts signPub), so the hub asks a signer
 * whose key the followers check releases with (agents/signer.ts). */
export function fingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}
