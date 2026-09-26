import type { RequestOptions, Transport } from "../transport.js";

/** Your organization's referral link and what it has earned. Money is integer
 * microdollars in strings (1,000,000 = $1). */
export type ReferralSummary = {
  code: string;
  /** Share this: https://withruntime.com/r/<code>. */
  link: string;
  /** The least each side gets: a first top-up is matched, never below this. */
  rewardMicros: string;
  /** The most each side gets: a first top-up is matched up to this. */
  maxRewardMicros: string;
  /** The smallest first top-up that pays a referral. */
  minPurchaseMicros: string;
  /** The most referral credit you can earn in one calendar year (UTC). */
  yearlyCapMicros: string;
  enabled: boolean;
  year: number;
  signedUp: number;
  pending: number;
  paid: number;
  capped: number;
  reversed: number;
  earnedMicros: string;
  earnedThisYearMicros: string;
  capRemainingMicros: string;
  referredBy: {
    status: "pending" | "paid" | "refused" | "reversed";
    creditMicros: string;
  } | null;
};

/** `runtime.referrals.get()`: when a company that signs up with your link makes
 * its first top-up of at least $10, you and it each get credit equal to that
 * top-up, at least $25 and at most $500. */
export function referrals(t: Transport) {
  return {
    get: (options?: RequestOptions) =>
      t.json<ReferralSummary>({ method: "GET", path: "/v1/referrals", ...options }),
  };
}
