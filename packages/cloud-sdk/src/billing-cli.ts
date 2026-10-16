import type { Runtime } from "./client.js";
import { RuntimeError } from "./errors.js";
import { named } from "./cli-name.js";
import type { AutoTopUp, Topup } from "./products/billing.js";
import type { claimWalletAccount, openWalletAccount } from "./wallet.js";

/* `runtime billing`: add credit without a browser, in stablecoins.
 *
 *   runtime billing topup <usd> [--wait]   where to send, and the exact amount
 *   runtime billing status <id> [--wait]   whether the payment arrived
 *   runtime billing auto-top-up [on|off]   credit added by card when it runs low
 *
 * Billing is the account's, so it is top-level, like usage and limits. */

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };
type Args = { positional: string[]; flags: Map<string, string[]> };

export const BILLING_HELP = `runtime billing <command>

  topup <usd> [--wait]      Buy credit with stablecoins (USDC on Base, Solana or Tempo).
                            Prints an address per network and the exact amount to send.
                            Send exactly that, from any wallet, before the time shown.
                            --wait keeps checking until the credit lands.
  status <id> [--wait]      Whether a top-up's payment has arrived

  auto-top-up               Show auto top-up: the card is charged when credit runs low
  auto-top-up on [--below <usd>] [--amount <usd>] [--monthly <usd>]
                            Charge <amount> plus tax when credit falls below <below>,
                            at most <monthly> a month: $10, $20 and $500 unless given,
                            or as last set. At least $10, $20 and $100. 5% more as
                            credit each time, and 200 sandboxes at once while on.
                            A person saves the card at
                            https://withruntime.com/account/billing
  auto-top-up off           Turn it off. Running sandboxes are never stopped.

  No account yet? An agent can open one with a wallet alone:
  topup <usd> --new-account --accept-terms [--wait]
                            Opens an account and its first top-up. Prints a claim code,
                            shown once. --wait saves the key here once the money lands.
  claim <code> [--wait]     Exchange a paid account's claim code for its key, saved here

  $10 to $10,000 a top-up; $500 in an account's first week. By card:
  https://withruntime.com/account/billing
`;

function usage(message: string) {
  return new RuntimeError({
    message,
    code: "usage",
    status: 0,
    hint: `Run \`${named("runtime")} billing help\`.`,
  });
}

const DONE = new Set(["paid", "failed", "expired"]);

function describe(topup: Topup): string {
  const me = named("runtime");
  if (topup.status === "paid") return `Paid: $${topup.amountUsd} of credit is on the account.`;
  if (topup.status === "expired")
    return `Expired: no payment arrived in time. Open a new one with \`${me} billing topup ${topup.amountUsd}\`.`;
  if (topup.status === "failed") return "Failed. Nothing was credited.";
  if (topup.status === "pending")
    return `Stripe has seen the payment and is confirming it. Check again with \`${me} billing status ${topup.purchaseId}\`.`;
  const lines = [`Send exactly ${topup.amount} of one of these tokens, on one network:`, ""];
  for (const network of topup.networks)
    for (const token of network.tokens)
      lines.push(
        `  ${network.network.padEnd(7)} ${token.currency.toUpperCase().padEnd(6)} to ${network.address}`,
        `  ${"".padEnd(7)} ${"".padEnd(6)}    token ${token.contract}`,
      );
  lines.push(
    "",
    ...(topup.payBy ? [`Send before ${topup.payBy}.`] : []),
    "A different amount, token or network cannot be matched or returned automatically.",
    `The credit lands a few minutes after the transfer: \`${me} billing status ${topup.purchaseId}\`.`,
  );
  return lines.join("\n");
}

/** Wallet-account commands need no key, and the claim saves the one they get. */
export type WalletDeps = {
  open: typeof openWalletAccount;
  claim: typeof claimWalletAccount;
  /** Saves a claimed key as this machine's connection, as `login --with-key` does. */
  save: (key: string, orgId: string) => Promise<void>;
};

const FLAGS = new Set(["wait", "new-account", "accept-terms", "below", "amount", "monthly"]);

export async function billingCommand(
  argv: string[],
  args: Args,
  out: Out,
  client: () => Promise<Runtime>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  wallet?: WalletDeps,
): Promise<number> {
  const [verb, value] = args.positional;
  const has = (name: string) => args.flags.get(name)?.at(-1) === "true";
  const wait = has("wait");
  for (const name of args.flags.keys())
    if (!FLAGS.has(name)) throw usage(`Unknown option --${name}.`);
  if (!verb || verb === "help") {
    out.write(BILLING_HELP);
    return 0;
  }
  if ((verb === "topup" && has("new-account")) || verb === "claim") {
    if (!wallet) throw usage("Wallet accounts are not available here.");
    return walletCommand(verb, value, has("accept-terms"), wait, out, sleep, wallet);
  }
  if (verb === "auto-top-up") return autoTopUpCommand(value, args, out, client);
  for (const name of ["below", "amount", "monthly"])
    if (args.flags.has(name)) throw usage(`--${name} is for \`billing auto-top-up on\`.`);
  const api = (await client()).billing;
  let topup: Topup;
  if (verb === "topup") {
    topup = await api.topup({ usd: dollarsOf(value) }, { idempotencyKey: crypto.randomUUID() });
  } else if (verb === "status") {
    if (!value) throw usage("Give the top-up's id.");
    topup = await api.topupStatus(value);
  } else {
    throw usage(`Unknown billing command ${verb}.`);
  }
  const shown = new Set<string>();
  const show = (current: Topup) => {
    if (out.json) out.write(JSON.stringify(current));
    else if (!shown.has(current.status)) out.write(describe(current));
    shown.add(current.status);
  };
  show(topup);
  if (!wait) return 0;
  /* Stripe takes a few minutes to see a transfer; checking every ten seconds
     is quick enough and costs nothing. Stops once the top-up has an end, or
     an hour after its deadline. */
  const until = (topup.payBy ? Date.parse(topup.payBy) : Date.now()) + 60 * 60_000;
  while (!DONE.has(topup.status) && Date.now() < until) {
    await sleep(10_000);
    topup = await api.topupStatus(topup.purchaseId);
    show(topup);
  }
  return topup.status === "paid" ? 0 : 1;
}

const OFF_REASONS: Record<NonNullable<AutoTopUp["offReason"]>, string> = {
  declined: "the bank declined the last charge",
  authentication_required: "the bank asked its holder to confirm the last charge",
  card_removed: "the card was removed",
  no_address: "Stripe had no billing address to work out tax",
  blocked: "a payment on this account is under review",
  failed: "the last charge did not go through",
};

function describeAuto(auto: AutoTopUp): string {
  const figures =
    auto.below !== null && auto.amount !== null && auto.monthlyLimit !== null
      ? `adds $${auto.amount} when credit falls below $${auto.below}, up to $${auto.monthlyLimit} a month`
      : null;
  const lines = [
    auto.enabled
      ? `Auto top-up is on: it ${figures}. $${auto.thisMonth} added this month.`
      : auto.waitingForCard
        ? `Auto top-up turns on once a card is saved: it will ${figures}.`
        : auto.offReason
          ? `Auto top-up is off: ${OFF_REASONS[auto.offReason]}.`
          : "Auto top-up is off.",
  ];
  if (auto.saveCardAt) lines.push(`A person saves the card at ${auto.saveCardAt}`);
  return lines.join("\n");
}

/** `billing auto-top-up [on|off]`. */
async function autoTopUpCommand(
  verb: string | undefined,
  args: Args,
  out: Out,
  client: () => Promise<Runtime>,
): Promise<number> {
  const flag = (name: string) => args.flags.get(name)?.at(-1);
  const api = (await client()).billing.autoTopUp;
  const options = { idempotencyKey: crypto.randomUUID() };
  let auto: AutoTopUp;
  if (!verb || verb === "show") auto = await api.get();
  else if (verb === "off") auto = await api.off(options);
  else if (verb === "on") {
    // A figure not given keeps the one saved, or takes its default.
    const figure = (name: string) => {
      const value = flag(name);
      if (value === undefined) return undefined;
      const usd = Number(value.replace(/^\$/, ""));
      if (!value || !Number.isFinite(usd) || usd <= 0)
        throw usage(`Give --${name} in dollars, such as --${name} 20.`);
      return usd;
    };
    const below = figure("below");
    const amount = figure("amount");
    const monthlyLimit = figure("monthly");
    auto = await api.set(
      {
        enabled: true,
        ...(below === undefined ? {} : { below }),
        ...(amount === undefined ? {} : { amount }),
        ...(monthlyLimit === undefined ? {} : { monthlyLimit }),
      },
      options,
    );
  } else throw usage(`Unknown auto-top-up command ${verb}: show, on or off.`);
  out.write(out.json ? JSON.stringify(auto) : describeAuto(auto));
  return 0;
}

function dollarsOf(value: string | undefined): number {
  const usd = Number(value?.replace(/^\$/, ""));
  if (!value || !Number.isFinite(usd) || usd <= 0)
    throw usage("Say how many dollars of credit to buy, such as `billing topup 20`.");
  return usd;
}

/** `topup <usd> --new-account` and `claim <code>`: an account with no key. */
async function walletCommand(
  verb: "topup" | "claim",
  value: string | undefined,
  acceptTerms: boolean,
  wait: boolean,
  out: Out,
  sleep: (ms: number) => Promise<void>,
  wallet: WalletDeps,
): Promise<number> {
  const me = named("runtime");
  let code: string;
  let payBy: string | null = null;
  if (verb === "topup") {
    if (!acceptTerms)
      throw usage(
        "Opening an account means agreeing to https://withruntime.com/legal/terms. Add --accept-terms to agree to them for whoever you act for.",
      );
    const opened = await wallet.open({ usd: dollarsOf(value), acceptTerms: true });
    code = opened.claimCode;
    payBy = opened.payBy;
    if (out.json) out.write(JSON.stringify(opened));
    else
      out.write(
        [
          describe(opened),
          "",
          `Claim code (shown once, keep it secret): ${code}`,
          `Once paid: \`${me} billing claim ${code}\` gives this machine the account's key.`,
          "A person can take the account over at https://withruntime.com/account/claim with the same code.",
        ].join("\n"),
      );
    if (!wait) return 0;
  } else {
    if (!value) throw usage("Give the claim code.");
    code = value;
  }
  const until = (payBy ? Date.parse(payBy) : Date.now()) + 60 * 60_000;
  for (let first = verb === "claim"; ; first = false) {
    if (!first) await sleep(10_000);
    const claim = await wallet.claim(code);
    if (claim.status === "paid") {
      await wallet.save(claim.apiKey, claim.orgId);
      out.write(
        out.json
          ? JSON.stringify({ status: "paid", orgId: claim.orgId, connected: true })
          : "Paid. This machine is connected to the new account; its key is saved, not shown.",
      );
      return 0;
    }
    if (claim.status === "expired" || claim.status === "failed") {
      out.write(
        out.json
          ? JSON.stringify(claim)
          : `The top-up ${claim.status}: nothing was credited. Open a new one with \`${me} billing topup <usd> --new-account --accept-terms\`.`,
      );
      return 1;
    }
    // A top-up that never reached Stripe has no address: waiting cannot help.
    const noAddress = claim.topup?.status === "open" && !claim.topup.networks.length;
    if (noAddress || !wait || Date.now() >= until) {
      out.write(
        out.json
          ? JSON.stringify(claim)
          : noAddress
            ? (claim.next ?? "This top-up has no address to pay to yet.")
            : `Not paid yet (${claim.status}). Run \`${me} billing claim ${code}\` again once the transfer has gone through.`,
      );
      return noAddress || wait ? 1 : 0;
    }
  }
}
