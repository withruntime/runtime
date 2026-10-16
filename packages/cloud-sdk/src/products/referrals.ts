import type { RequestOptions, Transport } from "../transport.js";

/** Your organization's referral link and what it has earned. Money is integer
 * microdollars in strings (1,000,000 = $1). */
export type ReferralSummary = {
  code: string;
  /** Share this: https://withruntime.com/r/<code>. */
  link: string;
  /** The least each side gets on the referred company's first qualifying
   * payment: a smaller one is matched up to this. */
  rewardMicros: string;
  /** The most each side gets per referred company, all its matched payments
   * together. */
  maxRewardMicros: string;
  /** The smallest payment a referral matches. */
  minPurchaseMicros: string;
  /** The most referral credit, matches and share together, you can earn in
   * one calendar year (UTC). */
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
  /** Referred companies with a matched payment still standing. */
  payingCompanies: number;
  /** Share credit you kept, all time. */
  shareEarnedMicros: string;
  /** Your share of what a referred company spends from credit it paid for,
   * in basis points: 1000 is 10%. */
  shareBasisPoints: number;
  /** How long the share runs from a company's first matched payment. */
  shareMonths: number;
  /** How long after sign-up a referred company's payments are matched. */
  windowDays: number;
};

/** `runtime.referrals`: a company that signs up with your link has every
 * payment in its first 30 days matched, up to $1,000, and you get the same;
 * then for 12 months you earn 10% of what it spends from credit it paid for. */
export function referrals(t: Transport) {
  return {
    get: (options?: RequestOptions) =>
      t.json<ReferralSummary>({ method: "GET", path: "/v1/referrals", ...options }),
  };
}
