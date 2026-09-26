import { execFile } from "node:child_process";
import { generateKeyPair, privateDecrypt } from "node:crypto";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { connectionOrigins } from "./credentials.js";
import { RuntimeError } from "./errors.js";
import { named } from "./cli-name.js";
import { describeRoute, envFetch } from "./proxy.js";

/* `runtime keys create`: an API key for somewhere with no browser, a CI runner
   above all, asked for from a terminal and approved by an account owner in the
   browser. Marc, 23 September 2026; ARCHITECTURE.md section 10, "Keys from the
   terminal". It is the connection request `runtime login` makes, carrying the
   keys page's terms, and the website issues it through the keys page's own
   path. The key is sealed to a key pair made here and never written to disk;
   the command prints it once and keeps nothing. */

export type KeyAccess = "full" | "read";
export type KeyRequest = {
  /** The key's name, and its agent's. */
  name: string;
  access: KeyAccess;
  /** The most its agent may spend in any 24 hours, or null for none. */
  dailyLimitMicros: number | null;
};
export type CreatedKey = KeyRequest & {
  key: string;
  keyId: string;
  agentId: string;
  orgId: string;
  /** Always until revoked, as on the keys page. */
  expires: null;
};
export type KeyRequestOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Where the link, the code and progress go: standard error, never stdout. */
  notify?: (message: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  /** Whether a person is at this terminal, so a browser is worth opening. */
  interactive?: boolean;
  /** What this computer calls itself, shown to the owner beside the code. */
  machine?: string;
  /** Runs `cancel` if the command is interrupted before the key arrives;
   * returns a function that stops listening. */
  onInterrupt?: (cancel: () => Promise<void>) => () => void;
};

const KEY = /^rtcloud_([a-f0-9-]{36})_[A-Za-z0-9_-]{43}$/;
/** How often to ask whether the owner has answered. The website answers
 * "pending" to anything faster than every 4.5 seconds. */
const POLL_MS = 5000;

/** Whole microdollars from a daily limit typed in dollars ("25", "7.5",
 * "$1,000.10"), read as digits rather than through a float, from $0.01 to
 * $1,000,000: the keys page's own rule (apps/cloud-web/src/app/account/keys/limit.ts). */
export function dailyLimitMicros(typed: string): number {
  const text = typed.trim().replace(/^\$/, "").replace(/,/g, "");
  const parts = text.match(/^(\d{1,7})(?:\.(\d{1,2}))?$/);
  const cents = parts ? Number(parts[1]) * 100 + Number((parts[2] ?? "").padEnd(2, "0")) : 0;
  if (cents < 1 || cents > 100_000_000)
    throw new RuntimeError({
      code: "usage",
      status: 0,
      message: "--daily-limit is an amount in US dollars from 0.01 to 1000000, such as 25.",
    });
  return cents * 10_000;
}

function failure(code: string, message: string, status = 0, hint?: string) {
  return new RuntimeError({ code, status, message, ...(hint ? { hint } : {}) });
}

async function browser(url: string) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await promisify(execFile)(command, args, { timeout: 10_000 });
}

function interrupted(cancel: () => Promise<void>) {
  const handler = () => {
    process.stderr.write("\nCanceling the key request.\n");
    void cancel()
      .catch(() => undefined)
      .finally(() => process.exit(130));
  };
  process.once("SIGINT", handler);
  return () => void process.off("SIGINT", handler);
}

/**
 * Asks for a key, waits for an owner to approve it in the browser, and hands
 * it back with `confirm`, which tells the website it arrived. Call `confirm`
 * after the key is shown: it clears the sealed copy the website held for
 * delivery and turns the owner's page to "Key created".
 */
export async function createKey(
  request: KeyRequest,
  env: NodeJS.ProcessEnv,
  options: KeyRequestOptions = {},
): Promise<CreatedKey & { confirm: () => Promise<void> }> {
  const name = request.name.trim();
  if (
    !name ||
    request.name.length > 80 ||
    [...request.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw failure("usage", "Give the key a name of up to 80 characters.");
  if (request.access === "read" && request.dailyLimitMicros !== null)
    throw failure("usage", "A read-only key cannot spend, so it takes no --daily-limit.");
  const origins = connectionOrigins(env);
  const fetcher = options.fetch ?? envFetch;
  const notify = options.notify ?? ((message: string) => process.stderr.write(`${message}\n`));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A key asked for here is approved on the page this address serves: only
  // Runtime's own website, or one on this computer for testing.
  const local = (origin: string) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  if (!(origins.auth === "https://withruntime.com" || local(origins.auth)))
    throw failure(
      "usage",
      "Keys are approved at https://withruntime.com, or at a local test address. Check RUNTIME_AUTH_URL.",
    );

  async function post(path: string, body: unknown, key?: string) {
    const address = `${origins.auth}/api/connect/${path}`;
    let response: Response;
    try {
      response = await fetcher(address, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      const route = options.fetch ? { via: "" } : describeRoute(address, cause, env);
      throw failure(
        "network_error",
        `Runtime could not be reached at ${origins.auth}${route.via}.`,
        0,
        route.hint,
      );
    }
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw failure(
        response.status === 429 ? "rate_limited" : "key_request_failed",
        typeof result.error === "string" ? result.error : "Runtime could not take this request.",
        response.status,
      );
    return result;
  }

  const pair = await promisify(generateKeyPair)("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const started = await post("start", {
    purpose: "key",
    agentName: name,
    access: request.access,
    dailyLimitMicros: request.dailyLimitMicros,
    machine: options.machine ?? hostname(),
    publicKey: pair.publicKey,
  });
  if (
    typeof started.verificationUri !== "string" ||
    typeof started.deviceCode !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(started.deviceCode) ||
    typeof started.userCode !== "string" ||
    !/^[A-F0-9]{4}(-[A-F0-9]{4}){2}$/.test(started.userCode) ||
    typeof started.expiresAt !== "number" ||
    !Number.isFinite(started.expiresAt)
  )
    throw failure("key_request_failed", "Runtime returned an invalid key request.");
  const link = new URL(started.verificationUri);
  if (
    link.origin !== origins.auth ||
    link.pathname !== "/connect" ||
    link.username ||
    link.password ||
    link.hash ||
    [...link.searchParams.keys()].some((key) => key !== "code") ||
    link.searchParams.get("code") !== started.userCode
  )
    throw failure("key_request_failed", "Runtime returned an unexpected approval address.");
  const deviceCode = started.deviceCode;
  const expiresAt = Math.min(started.expiresAt, Date.now() + 15 * 60_000);

  notify(
    `Approve this key in your browser: ${link.href}\nCheck that the page shows code ${started.userCode}. An account owner chooses Create key.\nWaiting for the approval, up to 15 minutes. Stopping this cancels the request.`,
  );
  if (options.interactive ?? Boolean(process.stderr.isTTY))
    await (options.openBrowser ?? browser)(link.href).catch(() =>
      notify("Open the link in a browser where an account owner is signed in."),
    );
  const stop = (options.onInterrupt ?? interrupted)(async () => {
    await post("token", { deviceCode, action: "cancel" });
  });
  try {
    // One poll past the expiry, because an approval given in its last seconds
    // is still delivered.
    for (;;) {
      await sleep(POLL_MS);
      const last = Date.now() >= expiresAt;
      let result: Record<string, unknown>;
      try {
        result = await post("token", { deviceCode });
      } catch (error) {
        // A dropped connection or a busy website is not an answer: ask again.
        if (
          !last &&
          error instanceof RuntimeError &&
          (error.code === "network_error" || error.status >= 500)
        )
          continue;
        throw error;
      }
      if (result.status === "pending") {
        if (last) break;
        continue;
      }
      if (result.status === "denied")
        throw failure("key_request_declined", "The key request was declined. No key was created.");
      if (result.status === "canceled")
        throw failure("key_request_canceled", "The key request was canceled. No key was issued.");
      if (result.status === "expired") break;
      if (
        result.status !== "connected" ||
        typeof result.encryptedKey !== "string" ||
        typeof result.agentId !== "string" ||
        typeof result.orgId !== "string"
      )
        throw failure("key_request_failed", "Runtime returned an invalid key.");
      let key: string;
      try {
        key = privateDecrypt(
          { key: pair.privateKey, oaepHash: "sha256" },
          Buffer.from(result.encryptedKey, "base64"),
        ).toString("utf8");
      } catch {
        throw failure(
          "key_request_failed",
          "Could not open the key Runtime returned. Start again.",
        );
      }
      const match = KEY.exec(key);
      if (!match) throw failure("key_request_failed", "Runtime returned an invalid key.");
      // From here the key is this command's: an interruption must not revoke it.
      stop();
      return {
        name,
        access: request.access,
        dailyLimitMicros: request.dailyLimitMicros,
        key,
        keyId: match[1]!,
        agentId: result.agentId,
        orgId: result.orgId,
        expires: null,
        confirm: async () => {
          await post("confirm", {}, key).catch(() =>
            notify(
              "The key works, but Runtime did not hear that it arrived. The approval page may still say Approved.",
            ),
          );
        },
      };
    }
  } finally {
    stop();
  }
  throw failure(
    "key_request_expired",
    named("The key request expired before it was approved. Run `runtime keys create` again."),
  );
}
