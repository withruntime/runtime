import type { RequestOptions, Transport } from "../transport.js";

/* `runtime.billing`: add credit without a browser, in stablecoins
 * (docs: billing, "Pay with stablecoins"). Billing is the account's, so it
 * spans products. */

/** Where to pay for a stablecoin top-up, and whether the payment arrived. */
export type Topup = {
  /** Poll this until `status` is `paid`. */
  purchaseId: string;
  /** open: waiting for your payment. pending: Stripe saw it and is confirming.
   *  paid: the credit is on the account. expired: nothing arrived in time. */
  status: "open" | "pending" | "paid" | "failed" | "expired";
  /** The credit this buys, in dollars, such as "20.00". */
  amountUsd: string;
  /** The exact token amount to send, to six decimals, such as "20.000000".
   *  A different amount, token or network cannot be matched or returned
   *  automatically. */
  amount: string;
  /** Send before this. */
  payBy: string | null;
  /** Pay on any one of these, with one of its tokens. */
  networks: {
    network: string;
    address: string;
    tokens: { currency: string; contract: string }[];
  }[];
};

/** Auto top-up: when credit falls below `below`, the saved card is charged
 *  `amount` plus tax, within `monthlyLimit` a calendar month (UTC). Each
 *  automatic top-up adds 5% more as credit, and while it is on the account
 *  may run 200 sandboxes at once. Dollars are numbers in whole cents. */
export type AutoTopUp = {
  /** Charging now. */
  enabled: boolean;
  /** Asked to turn on; turns on once a person saves a card at `saveCardAt`. */
  waitingForCard: boolean;
  below: number | null;
  amount: number | null;
  monthlyLimit: number | null;
  /** Dollars added this month, a charge in flight included. */
  thisMonth: number;
  card: boolean;
  /** Why it turned itself off; null while on. */
  offReason:
    | "declined"
    | "authentication_required"
    | "card_removed"
    | "no_address"
    | "blocked"
    | "failed"
    | null;
  offAt: string | null;
  /** Where a person saves the card, while none is saved. */
  saveCardAt: string | null;
};

/** A figure left out keeps the one saved, or takes its default. */
export type AutoTopUpInput = {
  enabled: boolean;
  /** Charge when credit falls below this: $10 at least, and the default. */
  below?: number;
  /** Each time, before tax: $20 (the default) to $10,000, and at most $500
   *  in an account's first week. */
  amount?: number;
  /** The most a calendar month (UTC): $100 at least and at least `amount`;
   *  $500 by default. */
  monthlyLimit?: number;
};

export function billing(t: Transport) {
  return {
    /** Open a stablecoin top-up of `usd` dollars ($10 to $10,000). Pass the
     *  same `idempotencyKey` when retrying to get the same top-up back. */
    topup: (input: { usd: number }, options?: RequestOptions) =>
      t.json<Topup>({ method: "POST", path: "/v1/billing/topups", body: input, ...options }),
    /** Read a top-up: whether its payment has arrived. */
    topupStatus: (purchaseId: string, options?: RequestOptions) =>
      t.json<Topup>({
        method: "GET",
        path: `/v1/billing/topups/${encodeURIComponent(purchaseId)}`,
        ...options,
      }),
    /** Auto top-up's settings. A person saves its card on the website. */
    autoTopUp: {
      get: (options?: RequestOptions) =>
        t.json<AutoTopUp>({ method: "GET", path: "/v1/billing/auto-top-up", ...options }),
      /** Set the three figures, and turn it on (once a card is saved) or keep it off. */
      set: (input: AutoTopUpInput, options?: RequestOptions) =>
        t.json<AutoTopUp>({
          method: "PUT",
          path: "/v1/billing/auto-top-up",
          body: input,
          ...options,
        }),
      /** Turn it off. The figures and the card are kept; running sandboxes are never stopped. */
      off: (options?: RequestOptions) =>
        t.json<AutoTopUp>({ method: "DELETE", path: "/v1/billing/auto-top-up", ...options }),
    },
  };
}
