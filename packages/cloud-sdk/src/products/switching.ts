import type { RequestOptions, Transport } from "../transport.js";

/* Switching from a rival: what your sandboxes would have cost there, and the
 * switching credit. Money is integer microdollars in strings (1,000,000 = $1). */

/** The rivals a comparison prices. `fly` is Sprites; `fly-machines` is
 * Machines, priced only at the size Fly publishes a rate for here. The server
 * prices every rival its rates table carries and names them when it refuses
 * one, so any string is sent as it is. */
export type CompareProvider =
  "e2b" | "daytona" | "vercel" | "modal" | "cloudflare" | "fly" | "fly-machines" | (string & {});

/** The rivals a switch can be recorded from. */
export type SwitchProvider = "e2b" | "daytona" | "vercel" | "modal" | "cloudflare" | "fly";

export type SwitchingSummary = {
  /** False while the programme is paused. */
  enabled: boolean;
  /** The most a first top-up is matched to. */
  maxMicros: string;
  providers: SwitchProvider[];
  /** Whether this organization can record a switch now: none recorded, and
   * no top-up paid yet. */
  eligible: boolean;
  switch: {
    provider: SwitchProvider;
    /** superseded: a referral matched the first top-up instead, which is
     * never less. The two are never both paid. */
    status: "pending" | "paid" | "superseded" | "refused" | "reversed";
    refusedReason: "program_off" | "suspended" | "same_card" | "fraud" | null;
    recordedAt: string;
    /** The switching credit this organization got and kept. */
    creditMicros: string;
  } | null;
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
    /** Of `sandboxes`, how many the free trial paid for, and their running
     * time. The trial charged nothing for them; `runtimeMicros` prices them at
     * Runtime's standard rates, what the same work costs on paid credit. */
    trialSandboxes: number;
    trialRunSeconds: number;
  };
  /** What the usage costs on Runtime on paid credit: each paid sandbox at the
   * rates it was quoted, a trial sandbox at the standard rates. */
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
 * and record the rival you are leaving so your first top-up is matched, up to
 * $100, once the payment settles. */
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
    /** Whether a switch can still be recorded, and what it paid. */
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
