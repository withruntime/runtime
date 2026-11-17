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
 * image/<OVH service> (OVH's rescue system and the host image's own
 * installer, the image the signed image record names: signed/image-cell),
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
/** The check a release record names when it rests on Marc's signed approval
 * of the commit (agents/approve-release.ts), not on a passed check: the
 * release signer signs it only on an approval it verified itself with his
 * key and 24-hour window (release-signer.py `approval`: any other ask naming
 * a check other than the full check or CI/CD's is refused), so a record
 * never says a check passed where none did. */
export const APPROVAL_CHECK = "marc/approval";
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
export const ORDER_ACTIONS = ["reinstall", "rejoin", "monitor", "access"] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];
/** An OVH service name, as reverse DNS gives it (src/ovh-reinstall.ts SERVICE). */
const OVH_SERVICE = "ns[0-9]+\\.ip-[0-9]+-[0-9]+-[0-9]+\\.(us|eu|net)";
/** What each order's check field may say. */
export const ORDER_CHECK: Record<OrderAction, RegExp> = {
  reinstall: new RegExp(`^(plain|encrypted|image)/${OVH_SERVICE}$`),
  monitor: new RegExp(`^monitor/${OVH_SERVICE}$`),
  rejoin: /^rejoin(\/vin-\d+)?$/,
  /** The way into a host image that will not serve (engines/host access.rs). */
  access: /^access\/(logs|restart-engine|boot-other|release)$/,
};
/** For the follower of host orders alone: any one host, which it checks. */
export const ANY_HOST: unique symbol = Symbol("any host");

export const isOrderAction = (action: string): action is OrderAction =>
  (ORDER_ACTIONS as readonly string[]).includes(action);

export type Signed = {
  /** prebuild: build these engines ahead of merge (engines-archive.ts),
   * never a release: a follower takes only its own action. ship: Marc's
   * ship it of a pull request's head, which CI/CD's gate reads
   * (agents/ship-it.ts shipRefusal), never a follower. card: an ask, never
   * a record: the signer posts its own ship card for that head
   * (agents/release-signer.py card) and signs nothing. */
  action: "release" | "unhold" | "prebuild" | "ship" | "card" | "image" | OrderAction;
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

/** The image record (engines/host/crates/image record.rs): what makes a
 * host image a release. Signed by the release signer for target cell on
 * Marc's image approval (agents/approve-release.ts --image); its own header,
 * so no record of one kind reads as the other. Asked as action image, check
 * image/<the manifest's SHA-256>. */
export const IMAGE_HEADER = "runtime-image v1";

/** The only servers a host image built from next may name: the test region
 * (vin-12) and the servers leaving the region for cell 1, each also listed in
 * region/servers/emptying.txt (signer.test.ts refuses one without the other),
 * so that it takes no new sandbox. One may still serve its own customers'
 * sandboxes until today's moves take them off: its image install refuses it
 * while it holds anything (host-reinstall.ts, productionRefusal). The signer holds the same list in its own
 * code (release-signer.py CELL1_SERVERS) and refuses any other; what serves
 * customers takes code only from main's release. */
export const CELL1_SERVERS: readonly string[] = [
  "vin-12",
  "vin-2",
  "vin-3",
  "vin-4",
  "vin-5",
  "vin-6",
  "vin-7",
  "vin-8",
  "vin-9",
  "vin-10",
  "vin-11",
  "vin-13",
  "vin-14",
  "vin-15",
];
const IMAGE_FIELDS = ["target", "sha", "image", "hosts", "nonce", "at"] as const;
export type ImageRecord = Record<(typeof IMAGE_FIELDS)[number], string>;

/** Whether `text` is an image record signed with `key` for `want`, no older
 * than ten minutes at `now` (a host checks its own age again at install).
 * `want.hosts` is the hosts field exactly, as the signer was asked;
 * `want.host` one host among them, as the host itself checks (record.rs). */
export function verifyImage(
  text: string | undefined,
  key: KeyObject | undefined,
  want: { target: string; sha: string; image: string } & ({ hosts: string } | { host: string }),
  now: Date,
): { ok: true; signed: ImageRecord } | { ok: false; why: string } {
  if (!key) return { ok: false, why: "no signing key here (release-sign.key)" };
  // Read exactly as the host reads it (engines/host record.rs): one final
  // newline, one spelling of the signature, one form of the time.
  const lines = (text ?? "").replace(/\n$/, "").split("\n");
  if (lines.length !== IMAGE_FIELDS.length + 2 || lines[0] !== IMAGE_HEADER)
    return { ok: false, why: "not an image record" };
  const fields: Record<string, string> = {};
  for (const [i, f] of IMAGE_FIELDS.entries()) {
    const line = lines[i + 1]!;
    if (!line.startsWith(`${f}=`)) return { ok: false, why: "not an image record" };
    fields[f] = line.slice(f.length + 1);
  }
  const sig = /^sig=([A-Za-z0-9+/=]{80,100})$/.exec(lines.at(-1)!)?.[1];
  const body = lines.slice(0, -1).join("\n");
  if (
    !sig ||
    Buffer.from(sig, "base64").toString("base64") !== sig ||
    !edVerify(null, Buffer.from(body), key, Buffer.from(sig, "base64"))
  )
    return { ok: false, why: "forged: its signature is not the hub's" };
  const signed = fields as ImageRecord;
  for (const f of ["target", "sha", "image"] as const)
    if (signed[f] !== want[f])
      return { ok: false, why: `signed for ${f} ${signed[f]}, not ${want[f]}` };
  if (!signed.hosts.split(",").every((h) => CELL1_SERVERS.includes(h)))
    return { ok: false, why: `signed for hosts ${signed.hosts}, not cell 1's servers alone` };
  if ("hosts" in want ? signed.hosts !== want.hosts : !signed.hosts.split(",").includes(want.host))
    return {
      ok: false,
      why: `signed for hosts ${signed.hosts}, not ${"hosts" in want ? want.hosts : want.host}`,
    };
  const at = Date.parse(signed.at);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(signed.at) ||
    Number.isNaN(at) ||
    at > now.getTime() + SIGNED_FUTURE_MS ||
    now.getTime() - at > SIGNED_MAX_AGE_MS
  )
    return { ok: false, why: `signed at ${signed.at}, not in the last ten minutes` };
  return { ok: true, signed };
}

/** Marc's image approval (agents/approve-release.ts --image, engines/host
 * record.rs check_approval): what a host takes in the image record's place,
 * checked with his cell key. Read as the host reads it. */
export const IMAGE_APPROVAL_HEADER = "runtime-image-approval v3";
const APPROVAL_FIELDS = ["sha", "image", "hosts", "undo", "nonce", "at"] as const;
export type ImageApproval = Record<(typeof APPROVAL_FIELDS)[number], string>;

/** One record of `header` and `fields`, signed with `key` (base64, one
 * spelling), its fields; or why not. One final newline, as record.rs reads. */
function readSigned<F extends readonly string[]>(
  text: string | undefined,
  key: KeyObject | undefined,
  header: string,
  fields: F,
  what: string,
): { ok: true; fields: Record<F[number], string> } | { ok: false; why: string } {
  if (!key) return { ok: false, why: "no key here to check it with" };
  const lines = (text ?? "").replace(/\n$/, "").split("\n");
  if (lines.length !== fields.length + 2 || lines[0] !== header)
    return { ok: false, why: `not ${what}` };
  const read: Record<string, string> = {};
  for (const [i, f] of fields.entries()) {
    const line = lines[i + 1]!;
    if (!line.startsWith(`${f}=`)) return { ok: false, why: `not ${what}` };
    read[f] = line.slice(f.length + 1);
  }
  const sig = /^sig=([A-Za-z0-9+/=]{80,100})$/.exec(lines.at(-1)!)?.[1];
  if (
    !sig ||
    Buffer.from(sig, "base64").toString("base64") !== sig ||
    !edVerify(null, Buffer.from(lines.slice(0, -1).join("\n")), key, Buffer.from(sig, "base64"))
  )
    return { ok: false, why: "forged: not signed with Marc's cell key" };
  return { ok: true, fields: read as Record<F[number], string> };
}

/** Whether `at` (the one form records write) is within ten minutes of `now`. */
const freshAt = (at: string, now: Date) => {
  const t = Date.parse(at);
  return (
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) &&
    !Number.isNaN(t) &&
    t <= now.getTime() + SIGNED_FUTURE_MS &&
    now.getTime() - t <= SIGNED_MAX_AGE_MS
  );
};

/** Whether `text` is Marc's approval of image `want.image` of commit
 * `want.sha` naming `want.host`, signed with his cell key `key`: what
 * runtime-host-install takes with --cell-pub. No clock of its own: the
 * reinstall order beside it is fresh and taken once (verifyHostOrder), and a
 * running server spends the approval's nonce (engines/host init update.rs). */
export function verifyImageApproval(
  text: string | undefined,
  key: KeyObject | undefined,
  want: { sha: string; image: string; host: string },
): { ok: true; signed: ImageApproval } | { ok: false; why: string } {
  const read = readSigned(text, key, IMAGE_APPROVAL_HEADER, APPROVAL_FIELDS, "an image approval");
  if (!read.ok) return read;
  const signed = read.fields;
  for (const f of ["sha", "image"] as const)
    if (signed[f] !== want[f])
      return { ok: false, why: `approved for ${f} ${signed[f]}, not ${want[f]}` };
  const hosts = signed.hosts.split(",");
  if (!hosts.every((h) => CELL1_SERVERS.includes(h)))
    return { ok: false, why: `approved for hosts ${signed.hosts}, not cell 1's servers alone` };
  if (!hosts.includes(want.host))
    return { ok: false, why: `approved for hosts ${signed.hosts}, not ${want.host}` };
  return { ok: true, signed };
}

/** Marc's own host order, signed on his Mac with his cell key
 * (approve-release.ts --reinstall), which the follower of host orders takes
 * with no release signer (Marc, 5 November 2026: the signer is out of the
 * image path): one host, its OVH service, the image by its manifest's
 * SHA-256 and the commit it was built from, a fresh nonce, taken once
 * within ten minutes. Its own header: no record of another kind reads as
 * one, and no host or follower takes one as anything else. `engine` is the
 * engine line host.conf takes, signed with the rest so no follower chooses
 * what the server runs: cell 1's engine (CELL_ENGINE), or a vault's server's
 * `runtime-vault host ...` (engines/identity/crates/vault), nothing else.
 *
 *   runtime-host-order v2
 *   action=reinstall
 *   host=vin-4
 *   service=ns5012345.ip-15-204-162.us
 *   mode=image
 *   image=<64 hex>
 *   sha=<40 hex>
 *   engine=cell1-host --plan /state/0/plan --host 0 --dir /data/0/cell1
 *   nonce=<32 hex>
 *   at=2026-11-06T17:00:00.000Z
 *   sig=<Ed25519 signature of the lines above, base64>
 */
export const HOST_ORDER_HEADER = "runtime-host-order v2";
const HOST_ORDER_FIELDS = [
  "action",
  "host",
  "service",
  "mode",
  "image",
  "sha",
  "engine",
  "nonce",
  "at",
] as const;

/** Cell 1's engine on a server installed with the host image: its disk 0's
 * volumes, which the image mounts by their labels. */
export const CELL_ENGINE = "cell1-host --plan /state/0/plan --host 0 --dir /data/0/cell1";

/** Why `line` is not an engine line Marc's order may name, or undefined:
 * cell 1's engine, or a vault's server's (`runtime-vault host`), its words
 * printable ASCII with no line break (host.conf reads one line, split on
 * spaces; no shell ever reads it). */
export function engineWhy(line: string): string | undefined {
  if (line.length > 2048) return "the engine line is longer than 2048 characters";
  if (!/^(cell1-host|runtime-vault host)( [!-~]+)*$/.test(line))
    return "the engine is cell1-host or `runtime-vault host`, its words printable with one space between";
  return undefined;
}
export type HostOrder = Record<(typeof HOST_ORDER_FIELDS)[number], string>;
const SERVICE_RE = new RegExp(`^${OVH_SERVICE}$`);

/** Why `o` is not a host order Marc may sign, or undefined. */
function hostOrderWhy(o: HostOrder): string | undefined {
  if (o.action !== "reinstall" || o.mode !== "image")
    return "Marc's host order is a reinstall onto the host image";
  if (!/^vin-[1-9][0-9]{0,3}$/.test(o.host)) return "it names one server: vin-N";
  if (!SERVICE_RE.test(o.service)) return `${o.service} is not an OVH service name`;
  if (!/^[0-9a-f]{64}$/.test(o.image)) return "it names the image's manifest SHA-256";
  if (!/^[0-9a-f]{40}$/.test(o.sha)) return "it names the image's full commit";
  const engine = engineWhy(o.engine);
  if (engine) return engine;
  if (!/^[0-9a-f]{32}$/.test(o.nonce)) return "no nonce";
  return undefined;
}

export function signHostOrder(o: Omit<HostOrder, "nonce" | "at">, key: KeyObject, at = new Date()) {
  const full: HostOrder = { ...o, nonce: newNonce(), at: at.toISOString() };
  const why = hostOrderWhy(full);
  if (why) throw new Error(why);
  const body = [HOST_ORDER_HEADER, ...HOST_ORDER_FIELDS.map((f) => `${f}=${full[f]}`)].join("\n");
  return `${body}\nsig=${edSign(null, Buffer.from(body), key).toString("base64")}\n`;
}

/** Whether `text` is Marc's host order signed with his cell key `key`, for
 * no other server than the follower's own checks, within ten minutes at
 * `now`, its nonce not in `used`. */
export function verifyHostOrder(
  text: string | undefined,
  key: KeyObject | undefined,
  now: Date,
  used: readonly string[],
): { ok: true; order: HostOrder } | { ok: false; why: string } {
  const read = readSigned(text, key, HOST_ORDER_HEADER, HOST_ORDER_FIELDS, "Marc's host order");
  if (!read.ok) return read;
  const order = read.fields;
  const why = hostOrderWhy(order);
  if (why) return { ok: false, why };
  if (used.includes(order.nonce))
    return { ok: false, why: "already used: a replayed order. Sign it again" };
  if (!freshAt(order.at, now))
    return { ok: false, why: `signed at ${order.at}, not in the last ten minutes: sign it again` };
  return { ok: true, order };
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
