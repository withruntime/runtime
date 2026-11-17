/* `runtime login` and `logout`: a key for this computer by OAuth 2.0's
   device flow (RFC 8628), which the API's front serves (engines/front,
   oauth.rs). The CLI asks for a device code, shows its user code and opens
   the page that approves it; the person approves there (`keys:create` with
   that `userCode`), and the CLI collects the key from `/v2/oauth/token` on
   its first poll after the approval. The key comes back over TLS to the
   holder of the device code alone and is collected once, so nothing is
   sealed to this computer. It is saved under the API's origin, read whenever
   RUNTIME_API_KEY is unset, and only ever sent over https (or to this
   computer itself). */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 3.5: a `slow_down` adds 5 seconds to every later poll. */
const SLOW_DOWN_MS = 5000;

/** Whether a key may go to the API at `baseUrl`: over https, or over
 * http to this computer itself (a local front). */
export function keySafe(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}

/** Where the key a login saved for the API at `baseUrl` is kept, by its
 * origin (scheme, host and port): `$XDG_CONFIG_HOME/runtime/key-<origin>`,
 * `~/.config` when unset. */
export function keyFile(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(root, "runtime", `key-${encodeURIComponent(new URL(baseUrl).origin)}`);
}

/** The key a login saved for `baseUrl`, if any and if it may go there ([`keySafe`]). */
export function savedKey(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!keySafe(baseUrl)) return undefined;
  try {
    return readFileSync(keyFile(baseUrl, env), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function save(file: string, key: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Written whole under a new name, then moved over: never a half-written key, always mode 600.
  const part = `${file}.${process.pid}`;
  try {
    writeFileSync(part, `${key}\n`, { mode: 0o600 });
    renameSync(part, file);
  } catch (e) {
    // No copy of the key is left behind under the part's name.
    rmSync(part, { force: true });
    throw e;
  }
}

/** `link` as a page to open, when it is one of the API's own site: https,
 * with no user or password, on the API's own host, its site's (the API's
 * host less its first name when it has three or more, so
 * api.withruntime.com's is withruntime.com) or the site's www. A host
 * further under the site is not one: under a shared parent (x.fly.dev's
 * fly.dev, which itself and its www are the parent's owner's), the other
 * hosts are anyone's. Any other scheme or host is the answer of
 * something that is not the API, and is printed but never opened. */
export function sitePage(link: string, baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  const api = new URL(baseUrl).hostname;
  const names = api.split(".");
  const site = (names.length > 2 ? names.slice(1) : names).join(".");
  const ours = [api, site, `www.${site}`].includes(url.hostname);
  return url.protocol === "https:" && ours && !url.username && !url.password ? url.href : undefined;
}

/** Opens `url`, a checked https page ([`sitePage`]), in this computer's
 * browser, as one argument and never through a shell; a computer without a
 * browser has the link printed. */
function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", ["--", url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no browser: the link is printed
  }
}

export type LoginOptions = {
  /** Whether standard output is a terminal: a key that cannot be saved is shown only there. */
  tty?: () => boolean;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  open?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  say?: (line: string) => void;
};

type OAuthAnswer = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  access_token?: string;
  error?: string;
  error_description?: string;
};

export async function login(baseUrl: string, o: LoginOptions = {}): Promise<number> {
  const fetcher = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const isTty = o.tty ?? (() => process.stdout.isTTY === true);
  const say = o.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (!keySafe(baseUrl)) {
    say(`runtime login: ${baseUrl} is not https: a key is never sent over plain http but to this computer.`);
    return 1;
  }
  const post = async (path: string, form: Record<string, string>): Promise<{ status: number; body: OAuthAnswer }> => {
    const res = await fetcher(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    let body: OAuthAnswer = {};
    try {
      body = (await res.json()) as OAuthAnswer;
    } catch {
      body = {};
    }
    return { status: res.status, body };
  };

  let started: OAuthAnswer;
  try {
    const r = await post("/v2/oauth/device", {});
    started = r.body;
    if (r.status !== 200 || !started.device_code || !started.user_code || !started.verification_uri) {
      say(`runtime login: ${started.error_description ?? `the API returned ${r.status}`}`);
      return 1;
    }
  } catch (e) {
    say(`runtime login: ${baseUrl} could not be reached (${(e as Error).message}).`);
    return 1;
  }
  const link = started.verification_uri_complete ?? started.verification_uri;
  say(`Approve this computer at ${link}`);
  say(`and check that the page shows the code ${started.user_code}.`);
  const page = sitePage(link, baseUrl);
  if (page) (o.open ?? openBrowser)(page);
  else say(`runtime login: the link is not opened in a browser: it is not a page of ${baseUrl}'s own site.`);

  let interval = Math.max(1, started.interval ?? 5) * 1000;
  const until = now() + (started.expires_in ?? 900) * 1000;
  // The front gives the key once: a poll whose answer was lost may have
  // collected it, so a login that ends without it says so.
  let lost = false;
  const ended = (why: string) => {
    say(`runtime login: ${why}`);
    if (lost)
      say("An answer from the API was lost while waiting, so a key may have been made for this login: if it was approved, revoke that key with runtime keys delete <id> or at API keys in the console.");
    return 1;
  };
  while (now() < until) {
    await sleep(interval);
    let r: { status: number; body: OAuthAnswer };
    try {
      r = await post("/v2/oauth/token", { grant_type: DEVICE_GRANT, device_code: started.device_code });
    } catch {
      // A lost connection: the device code holds until it expires, so the next poll asks again.
      lost = true;
      continue;
    }
    if (r.status === 200 && r.body.access_token) {
      const key = r.body.access_token;
      const file = keyFile(baseUrl, o.env);
      try {
        save(file, key);
      } catch (e) {
        const why = `runtime login: the key could not be saved in ${file} (${(e as Error).message}).`;
        // The key exists now and is held nowhere else: shown once to the person at this
        // terminal, never into a file or a log standard output may be.
        if (isTty()) {
          say(`${why} It is printed below, once: store it as RUNTIME_API_KEY, or revoke it.`);
          process.stdout.write(`${key}\n`);
        } else {
          say(`${why} It is not printed, as standard output is not a terminal: revoke it with runtime keys delete <id> or at API keys in the console.`);
        }
        return 1;
      }
      say(`Logged in. The key is saved in ${file}.`);
      return 0;
    }
    if (r.status === 200) {
      // A 200 whose body did not read: the key went in it.
      lost = true;
      continue;
    }
    switch (r.body.error) {
      case "authorization_pending":
      case "temporarily_unavailable":
        continue;
      case "slow_down":
        interval += SLOW_DOWN_MS;
        continue;
      case "expired_token":
        return ended("the code expired before it was approved. Run runtime login again.");
      default:
        return ended(r.body.error_description ?? r.body.error ?? `the API returned ${r.status}.`);
    }
  }
  return ended("the code expired before it was approved. Run runtime login again.");
}

/** Forgets the key a login saved for `baseUrl`. The key itself works until
 * it is revoked: `runtime keys delete <id>`, or at the console's API keys. */
export function logout(baseUrl: string, o: { env?: NodeJS.ProcessEnv; say?: (line: string) => void } = {}): number {
  const say = o.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (savedKey(baseUrl, o.env) === undefined) {
    say("runtime logout: no key is saved for this API.");
    return 0;
  }
  const file = keyFile(baseUrl, o.env);
  rmSync(file, { force: true });
  say(`Logged out: ${file} is deleted. The key works until it is revoked with runtime keys delete <id>.`);
  return 0;
}
