import type { RequestOptions, Transport } from "../transport.js";

/** A ceiling a plan raises, as GET /v1/limits and quota_exceeded name it
 * (sandbox.count); a null max is no limit at all. */
export type PlanLimit = { limit: string; max: number | null };

/** Usage a plan includes each month beside its fee, such as Apps' traffic
 * out. */
export type PlanIncluded = { product: string; meter: string; quantity: number; unit: string };

/** An add-on a plan offers, charged monthly beside its fee. */
export type PlanAddOn = {
  /** What `addOn` takes. */
  id: string;
  name: string;
  /** Monthly, beside the plan's fee. */
  feeMicros: string;
  /** What it adds to a limit. */
  limits: { limit: string; add: number }[];
  /** The feature it turns on, if any. */
  feature: string | null;
};

/** One plan: a monthly fee that comes back as plan usage, spent first each
 * month at the same measured prices, plus a bonus for committing. Money is
 * integer microdollars in strings (1,000,000 = $1). */
export type Plan = {
  /** What choose takes. */
  id: string;
  name: string;
  /** Plans shown as one card with a switch share it, such as Pro and its
   * larger option. */
  card: string | null;
  /** The monthly fee, before tax; 0 for Free. */
  feeMicros: string;
  /** A year paid at once: ten months' fee for twelve. Null without a yearly
   * price. */
  yearlyFeeMicros: string | null;
  /** Usage given on top of the fee each month. */
  bonusMicros: string;
  /** Days of trial, no card; 0 for none. */
  trialDays: number;
  /** The first month on the plan, and the first after an upgrade to it,
   * holds twice its usage. */
  firstPeriodDouble: boolean;
  support: "docs" | "agent" | "slack" | "dedicated";
  /** card: the fee is charged to the card the plan saves. invoice: a
   * contract, invoiced. */
  collection: "card" | "invoice";
  /** A contract made for your organization alone. */
  contract: boolean;
  /** The catalogue's order: the next plan up is next. */
  position: number;
  included: PlanIncluded[];
  /** Ceilings the plan raises, never lowers. A ceiling is not reserved room. */
  limits: PlanLimit[];
  /** What the plan turns on: sso, roles, audit, support-agent… */
  features: string[];
  addOns: PlanAddOn[];
};

/** The plan your organization is on, or null with none (Free). */
export type PlanNow = {
  planId: string;
  name: string;
  /** incomplete: the first payment is not through yet. trialing: a trial,
   * until trialEndsAt. past_due: a payment failed and is retried. */
  status: "incomplete" | "trialing" | "active" | "past_due" | "canceled";
  interval: "month" | "year";
  periodStart: string | null;
  /** The next fee, or the end of a cancelled plan. */
  periodEnd: string | null;
  /** When a trial ends; null outside one. */
  trialEndsAt: string | null;
  /** True once a cancel takes effect at periodEnd. */
  cancelAtPeriodEnd: boolean;
  /** The plan a downgrade moves to at periodEnd. */
  nextPlanId: string | null;
  startedAt: string;
  /** endsAt: when a removed add-on stops; null while it renews. */
  addOns: { id: string; quantity: number; endsAt: string | null }[];
  /** An owner said yes to moving up a plan when a limit refuses. */
  autoUpgrade: boolean;
  /** This period's plan usage, spent before any credit; it ends with the
   * period. */
  planUsage: { grantedMicros: string; leftMicros: string; expiresAt: string } | null;
};

export type Plans = { current: PlanNow | null; plans: Plan[] };

/** What a change answers: a link where a person starts a first plan or a
 * trial in the browser, or the plan as changed. */
export type PlanChange = { checkoutUrl: string | null; current: PlanNow | null };

/** `runtime.plans`: monthly plans whose fee is prepaid usage. You still pay
 * only for what runs, at the same prices; the fee comes back as usage. */
export function plans(t: Transport) {
  const change =
    (method: "POST" | "PUT" | "DELETE", path: string, body: object | undefined) =>
    (options?: RequestOptions) =>
      t.json<PlanChange>({ method, path, ...(body ? { body } : {}), ...options });
  return {
    list: (options?: RequestOptions) =>
      t.json<Plans>({ method: "GET", path: "/v1/plans", ...options }),
    /** Start a plan, or move to another; interval year pays ten months for
     * twelve. */
    choose: (plan: string, options?: RequestOptions & { interval?: "month" | "year" }) => {
      const { interval, ...rest } = options ?? {};
      return change("POST", "/v1/plans/choose", { plan, ...(interval ? { interval } : {}) })(rest);
    },
    /** End the plan at periodEnd. */
    cancel: (options?: RequestOptions) => change("POST", "/v1/plans/cancel", {})(options),
    /** Keep a plan you cancelled, before periodEnd. */
    resume: (options?: RequestOptions) => change("POST", "/v1/plans/resume", {})(options),
    /** Add an add-on to the plan, charged now prorated. */
    addOn: (addOn: string, options?: RequestOptions) =>
      change("POST", "/v1/plans/add-ons", { addOn })(options),
    /** Remove an add-on: its charge stops now, and it holds to periodEnd. */
    removeAddOn: (addOn: string, options?: RequestOptions) =>
      change("DELETE", `/v1/plans/add-ons/${encodeURIComponent(addOn)}`, undefined)(options),
    /** Move up a plan by itself when a limit refuses, or not. Owners only. */
    autoUpgrade: (on: boolean, options?: RequestOptions) =>
      change("PUT", "/v1/plans/auto-upgrade", { on })(options),
  };
}
