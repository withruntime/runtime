import type { RequestOptions, Transport } from "../transport.js";

/* Switching from a rival: what your sandboxes would have cost there, the
 * switch on record, and the welcome match. Money is integer microdollars in strings (1,000,000 = $1). */

/** The rivals a comparison prices. `fly` is Sprites; `fly-machines` is
 * Machines, priced only at the size Fly publishes a rate for here. The server
 * prices every rival its rates table carries and names them when it refuses
 * one, so any string is sent as it is. */
export type CompareProvider =
  | "e2b"
  | "daytona"
  | "vercel"
  | "modal"
  | "cloudflare"
  | "fly"
  | "fly-machines"
  | "blaxel"
  | (string & {});

/** The rivals a switch can be recorded from. */
export type SwitchProvider =
  "e2b" | "daytona" | "vercel" | "modal" | "cloudflare" | "fly" | "blaxel";

export type SwitchingSummary = {
  /** False while the programme is paused. */
  enabled: boolean;
  /** The most the organization's payments are matched to, in total. */
  maxMicros: string;
  providers: SwitchProvider[];
  /** Whether this organization can record a switch now: none recorded, and
   * no top-up paid yet. */
  eligible: boolean;
  switch: {
    provider: SwitchProvider;
    /** superseded: a referral matches the payments instead, which is
     * never less. The two are never both paid. */
    status: "pending" | "paid" | "superseded" | "refused" | "reversed";
    refusedReason: "program_off" | "suspended" | "same_card" | "fraud" | "too_late" | null;
    recordedAt: string;
    /** The matches this organization got and kept. */
    creditMicros: string;
  } | null;
  /** The welcome match: credit an organization adds within 30 days of
   * signing up is matched, up to $1,000 in total. */
  welcome: WelcomeMatch;
};

export type WelcomeMatch = {
  /** False while the match is paused. */
  enabled: boolean;
  /** The most the organization's payments are matched to, in total. */
  maxMicros: string;
  /** When the offer ends: 30 days after the organization signed up. */
  endsAt: string;
  /** Whether credit added now would be matched: some is left, before endsAt. */
  eligible: boolean;
  /** Whether credit has been added. */
  toppedUp: boolean;
  /** Null until a payment is decided; paid while a match is kept.
   * superseded: a referral matches the payments instead, which is never
   * less. */
  status: "pending" | "paid" | "superseded" | "refused" | "reversed" | null;
  /** The matches this organization got and kept. */
  creditMicros: string;
  /** The part of maxMicros used so far. Absent from a server before
   * 8 October 2026. */
  usedMicros?: string;
  /** What credit added now could still get; "0" once the offer ends. Absent
   * from a server before 8 October 2026. */
  leftMicros?: string;
};

export type UsageComparison = {
  provider: CompareProvider;
  rival: {
    name: string;
    /** ISO date the rival's published rates were read. */
    checked: string;
    rates: string[];
    planFee: string;
    sources: { label: string; url: string }[];
  };
  /** usage: your settled sandboxes. example: none in the window yet, so a
   * stated example workload is priced instead (see `note`). */
  basis: "usage" | "example";
  window: { days: number; from: string; to: string };
  usage: {
    sandboxes: number;
    runSeconds: number;
    activeCpuSeconds: number;
    unpricedSandboxes: number;
    /** Of `sandboxes`, how many free usage paid for, and their running time. It charged nothing for them; `runtimeMicros` prices them at
     * Runtime's standard rates, what the same work costs on paid credit. */
    trialSandboxes: number;
    trialRunSeconds: number;
  };
  /** What the usage costs on Runtime on paid credit: each paid sandbox at the
   * rates it was quoted, a sandbox free usage paid for at the standard rates. */
  runtimeMicros: string;
  rivalMicros: string;
  /** Rival less Runtime: negative when the rival would cost less. */
  savingMicros: string;
  savingPercent: number | null;
  /** Scaled to 30 days from the days the usage covers; null for the example. */
  perMonth: {
    fromDays: number;
    runtimeMicros: string;
    rivalMicros: string;
    savingMicros: string;
  } | null;
  /** What was compared, at which rates, and what was left out. */
  note: string;
  switching: SwitchingSummary;
};

/** `runtime.switching`: compare your usage with a rival's published rates,
 * record the rival you are leaving, and read the welcome match: credit added
 * within 30 days of signing up is matched, up to $1,000 in total, as each
 * payment settles. */
export function switching(t: Transport) {
  return {
    /** Your settled sandbox usage over the last `days` (default 30, at most
     * 90), priced on Runtime and at the rival, with the saving. */
    compare: (input: { provider: CompareProvider; days?: number }, options?: RequestOptions) =>
      t.json<UsageComparison>({
        method: "GET",
        path: "/v1/usage/compare",
        query: { provider: input.provider, days: input.days },
        ...options,
      }),
    /** Whether a switch can still be recorded, and what the welcome match paid. */
    get: (options?: RequestOptions) =>
      t.json<SwitchingSummary>({ method: "GET", path: "/v1/switching", ...options }),
    /** Once per organization, before its first top-up. Recording the same
     * provider again answers the same summary; another fails with 409. */
    record: (input: { provider: SwitchProvider }, options?: RequestOptions) =>
      t.json<SwitchingSummary>({
        method: "POST",
        path: "/v1/switching",
        body: { provider: input.provider },
        ...options,
      }),
  };
}
