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
  };
}
