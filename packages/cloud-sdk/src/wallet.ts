import { RuntimeError } from "./errors.js";
import { apiOrigin } from "./transport.js";
import type { Topup } from "./products/billing.js";

/* An account opened with a wallet alone: no key, no sign-in, no browser.
 * (docs: pricing, "Pay with stablecoins"). These two calls go to the website,
 * which holds the payment side; everything after the key goes to the API.
 *
 *   const opened = await openWalletAccount({ usd: 20, acceptTerms: true });
 *   // send exactly opened.amount to one of opened.networks, then:
 *   const { apiKey } = await claimWalletAccount(opened.claimCode);  // once paid
 */

export type WalletOptions = {
  /** Default: RUNTIME_AUTH_URL, then https://withruntime.com. */
  authUrl?: string;
  fetch?: typeof fetch;
};

export type OpenedWalletAccount = Topup & {
  orgId: string;
  /** The only way to this account's key, shown once. Keep it secret. */
  claimCode: string;
};

export type WalletClaim =
  | { status: "paid"; orgId: string; apiKey: string }
  | { status: Exclude<Topup["status"], "paid">; orgId: string; topup: Topup | null };

function origin(options: WalletOptions): string {
  const env = typeof process === "undefined" ? {} : process.env;
  return apiOrigin(options.authUrl ?? env.RUNTIME_AUTH_URL ?? "https://withruntime.com");
}

async function post<T>(options: WalletOptions, path: string, body: unknown): Promise<[number, T]> {
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${origin(options)}${path}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new RuntimeError({
      message: `No answer from ${origin(options)}.`,
      code: "network",
      status: 0,
      hint: "Retry in a minute.",
      cause,
    });
  }
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok)
    throw new RuntimeError({
      message: answer.error ?? `The request failed (HTTP ${response.status}).`,
      code: answer.code ?? (response.status === 429 ? "rate_limited" : "request_failed"),
      status: response.status,
    });
  return [response.status, answer];
}

/** Opens an account and a stablecoin top-up of `usd` dollars ($10 to $10,000).
 *  `acceptTerms` must be true: opening one means agreeing to
 *  https://withruntime.com/legal/terms, so ask the person you work for first. */
export async function openWalletAccount(
  input: { usd: number; acceptTerms: boolean },
  options: WalletOptions = {},
): Promise<OpenedWalletAccount> {
  const [, opened] = await post<OpenedWalletAccount>(options, "/api/wallet/topups", input);
  return opened;
}

/** Exchanges a paid account's claim code for its API key, once. Until the
 *  payment arrives it answers the top-up's status instead; call it again. */
export async function claimWalletAccount(
  claimCode: string,
  options: WalletOptions = {},
): Promise<WalletClaim> {
  const [, claim] = await post<WalletClaim>(options, "/api/wallet/claim", { claimCode });
  return claim;
}
