import { execFile } from "node:child_process";
import { generateKeyPair, privateDecrypt } from "node:crypto";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { me, named } from "./cli-name.js";
import { Runtime } from "./client.js";
import { connectionOrigins, connectionStore } from "./credentials.js";
import { describeRoute, envFetch } from "./proxy.js";

class ConnectionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export { me, named };
/** The connection id recorded for a key pasted with `login --with-key`. */
const PASTED = "pasted";

/** A key from standard input: piped, or typed at a prompt that does not echo. */
async function readKey(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  process.stderr.write("Paste a key from https://withruntime.com/account/keys (it is not shown): ");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (value: string | Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return done(typed);
        if (char === "\u0003") return done(new Error("Cancelled."));
        if (char === "\u007f") typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.on("data", onData);
  });
}

type LoginOptions = {
  readKey?: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  notify?: (message: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  /** A person at a terminal, who can wait out the approval; an agent's tool
   * call is not. Defaults to whether standard input and error are terminals. */
  interactive?: boolean;
};
/** How long a login run by an agent waits for the approval before it hands
 * back the link: inside the common tool timeouts, long enough for a person
 * at the same machine to press Connect agent. */
export const AGENT_WAIT_MS = 50_000;
async function browser(url: string) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await promisify(execFile)(command, args, { timeout: 10_000 });
}
/** The origins, the saved-connection store and the website's connect API. */
function connection(env: NodeJS.ProcessEnv, options: LoginOptions) {
  const origins = connectionOrigins(env);
  const store = connectionStore(env);
  const fetcher = options.fetch ?? envFetch;
  async function request(path: string, body?: unknown, key?: string) {
    let response: Response;
    const address = `${origins.auth}/api/connect/${path}`;
    try {
      response = await fetcher(address, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      });
    } catch (cause) {
      const route = options.fetch ? { via: "" } : describeRoute(address, cause, env);
      throw new ConnectionError(
        503,
        route.hint
          ? `Runtime could not be reached at ${origins.auth}${route.via}. ${route.hint}`
          : "Runtime could not be reached. Retry the connection.",
      );
    }
    if (response.status === 407 && !options.fetch) {
      const route = describeRoute(address, 407, env);
      throw new ConnectionError(
        503,
        `Runtime could not be reached at ${origins.auth}${route.via}. ${route.hint ?? ""}`.trim(),
      );
    }
    if (!response.ok)
      throw new ConnectionError(
        response.status,
        response.status === 401
          ? named("This connection is no longer active. Run `runtime login`.")
          : response.status === 429
            ? "Too many connection attempts. Try again later."
            : "Runtime could not complete this connection. Try again.",
      );
    return (await response.json()) as Record<string, unknown>;
  }
  return { origins, store, request, fetcher };
}

export async function authenticationCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: LoginOptions = {},
) {
  const { origins, store, request, fetcher } = connection(env, options);
  const notify = options.notify ?? ((message: string) => process.stderr.write(`${message}\n`));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const [command, ...rest] = args;
  if (command === "auth" && rest.length === 1 && rest[0] === "status") {
    if (env.RUNTIME_API_KEY) {
      await new Runtime({
        apiKey: env.RUNTIME_API_KEY,
        baseUrl: origins.api,
        fetch: fetcher,
      }).usage();
      return { connected: true, source: "environment" };
    }
    const saved = await store.read();
    if (!saved) return { connected: false };
    try {
      await request("confirm", undefined, saved.key);
    } catch (error) {
      if (error instanceof ConnectionError && error.status === 401)
        return { connected: false, reason: "revoked" };
      throw error;
    }
    return { connected: true, agentName: saved.agentName, orgId: saved.orgId };
  }
  if (command === "logout" && rest.length === 0) {
    if (env.RUNTIME_API_KEY)
      throw new Error(
        "This shell uses RUNTIME_API_KEY. Remove that override before disconnecting the saved connection.",
      );
    const saved = await store.read();
    if (!saved) return { disconnected: true };
    // A pasted key belongs to the website's key list: forget it here, and
    // revoke it there if it should stop working everywhere.
    if (saved.connectionId === PASTED) {
      await store.remove();
      return { disconnected: true };
    }
    try {
      await request("disconnect", undefined, saved.key);
    } catch (error) {
      if (!(error instanceof ConnectionError && error.status === 401)) throw error;
    }
    await store.remove();
    return { disconnected: true };
  }
  if (command !== "login")
    throw new Error(named("Use `runtime login`, `runtime whoami` or `runtime logout`."));
  let agentName = "My coding agent";
  let noBrowser = false;
  let withKey = false;
  let wait: boolean | undefined;
  // `runtime account add`: connect another account even though this machine
  // is connected already; the one in use is kept among the saved accounts.
  let another = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--no-browser") noBrowser = true;
    else if (rest[i] === "--another-account") another = true;
    else if (rest[i] === "--with-key") withKey = true;
    else if (rest[i] === "--wait") wait = true;
    else if (rest[i] === "--no-wait") wait = false;
    else if (rest[i] === "--agent-name" && rest[i + 1]) agentName = rest[++i]!;
    else
      throw new Error(
        named(
          "Use `runtime login [--agent-name <name>] [--no-browser] [--wait]`, or `runtime login --with-key` to paste a key.",
        ),
      );
  }
  if (
    !agentName.trim() ||
    agentName.length > 80 ||
    [...agentName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Give the agent a name of up to 80 characters.");
  // Never obtain a production key and then direct it at an unrelated API.
  const local = (origin: string) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  if (!(
    (origins.auth === "https://withruntime.com" && origins.api === "https://api.withruntime.com") ||
    (local(origins.auth) && local(origins.api))
  ))
    throw new Error(
      "Browser login supports Runtime's production endpoints or local test endpoints. Check RUNTIME_AUTH_URL and RUNTIME_API_URL.",
    );
  if (withKey) {
    // The fallback to a browser approval: a key from the website, read from
    // standard input so it never sits in a command line or shell history.
    const key = (await (options.readKey ?? readKey)()).trim();
    if (!/^rtcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/.test(key))
      throw new Error(
        "That is not a Runtime key: keys start with rtcloud_. Create one at https://withruntime.com/account/keys.",
      );
    const account = await new Runtime({ apiKey: key, baseUrl: origins.api, fetch: fetcher }).me();
    await store.save({
      version: 1,
      apiOrigin: origins.api,
      authOrigin: origins.auth,
      key,
      connectionId: PASTED,
      orgId: account.orgId,
      agentName: "pasted key",
    });
    return { connected: true, agentName: "pasted key", orgId: account.orgId, source: "key" };
  }
  if (env.RUNTIME_API_KEY) {
    await new Runtime({
      apiKey: env.RUNTIME_API_KEY,
      baseUrl: origins.api,
      fetch: fetcher,
    }).usage();
    return { connected: true, source: "environment" };
  }
  const saved = another ? null : await store.read();
  if (saved) {
    try {
      await request("confirm", undefined, saved.key);
      return { connected: true, agentName: saved.agentName, orgId: saved.orgId };
    } catch (error) {
      if (!(error instanceof ConnectionError && error.status === 401)) throw error;
      await store.remove();
    }
  }
  const pending = await beginDeviceLogin(env, agentName, options);
  // A person at a terminal waits for the approval. An agent's tool call waits
  // briefly and then hands back the link, and --no-browser (the person is on
  // another device) hands it back at once: the request is saved, so the next
  // command, or `login --wait`, finishes it.
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const budget =
    wait === true || (wait === undefined && interactive && !noBrowser)
      ? Infinity
      : wait === false || noBrowser
        ? 0
        : AGENT_WAIT_MS;
  const until = Math.min(pending.expiresAt, Date.now() + budget);
  notify(
    `Connect your agent: ${pending.url}\nCheck that the browser shows code ${pending.userCode}, then choose Connect agent.${budget > 0 ? "\nWaiting for the approval. Stopping this is safe: running it again keeps the same link." : ""}`,
  );
  if (!noBrowser && !pending.resumed)
    await (options.openBrowser ?? browser)(pending.url).catch(() =>
      notify("Open the connection link in your browser to continue."),
    );
  for (let first = true; first || Date.now() < until; first = false) {
    if (!first || !pending.resumed) {
      if (budget === 0) break;
      await sleep(3000);
    }
    const outcome = await pending.check();
    if (outcome === "expired")
      throw new Error(named("The connection expired. Run `runtime login` again."));
    if (outcome !== "pending") return outcome;
  }
  if (Date.now() >= pending.expiresAt)
    throw new Error(named("The connection expired. Run `runtime login` again."));
  return {
    connected: false as const,
    pending: true as const,
    url: pending.url,
    userCode: pending.userCode,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

export type PendingLogin = {
  /** Open this in a browser, where the account owner approves the agent. */
  url: string;
  /** The code the browser shows, to check it is this request. */
  userCode: string;
  expiresAt: number;
  /** An earlier request from this machine, still waiting: its link is already
   * open or shown, so it is not opened again. */
  resumed: boolean;
  /** Asks once whether it was approved: pending, expired, or connected (the
   * key is then saved and confirmed). Throws when it was declined. */
  check(): Promise<"pending" | "expired" | { connected: true; agentName: string; orgId: string }>;
};

/** Starts a browser-approved connection and hands back its link, without
 * waiting: `runtime login` waits on it, and the MCP bridge gives the link to
 * the agent, which shows it to the person it works for. */
export async function beginDeviceLogin(
  env: NodeJS.ProcessEnv,
  agentName: string,
  options: LoginOptions = {},
): Promise<PendingLogin> {
  const { origins, store, request } = connection(env, options);
  // A request this machine already started and nobody has answered yet: pick
  // it up, so a command stopped while it waited (an agent's tool timing out)
  // shows the same link and code again rather than a new one to approve.
  let pending = await store.readPending();
  const resumed = pending !== null;
  if (!pending) {
    const pair = await promisify(generateKeyPair)("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    // The computer's own name goes to the approval page beside the code, so an
    // owner can tell this request from a link somebody else started.
    const started = await request("start", {
      agentName,
      publicKey: pair.publicKey,
      machine: hostname(),
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
      throw new Error("Runtime returned an invalid connection request.");
    const verification = new URL(started.verificationUri);
    if (
      verification.origin !== origins.auth ||
      verification.pathname !== "/connect" ||
      verification.username ||
      verification.password ||
      verification.hash ||
      [...verification.searchParams.keys()].some((name) => name !== "code") ||
      verification.searchParams.get("code") !== started.userCode
    )
      throw new Error("Runtime returned an unexpected connection address.");
    pending = {
      version: 1,
      apiOrigin: origins.api,
      authOrigin: origins.auth,
      privateKey: pair.privateKey,
      deviceCode: started.deviceCode,
      url: verification.href,
      userCode: started.userCode,
      agentName,
      expiresAt: Math.min(started.expiresAt, Date.now() + 15 * 60_000),
    };
    await store.savePending(pending);
  }
  const { deviceCode, privateKey } = pending;
  const name = pending.agentName;
  return {
    url: pending.url,
    userCode: pending.userCode,
    expiresAt: pending.expiresAt,
    resumed,
    async check() {
      let result: Record<string, unknown>;
      try {
        result = await request("token", { deviceCode });
      } catch (error) {
        if (error instanceof ConnectionError && error.status >= 500) return "pending";
        await store.removePending();
        throw error;
      }
      if (result.status === "pending") return "pending";
      // Answered either way: the next attempt starts afresh. An approval
      // forgets the request only once its key is saved.
      if (result.status === "denied") {
        await store.removePending();
        throw new Error("The connection was declined.");
      }
      if (result.status === "expired") {
        await store.removePending();
        return "expired";
      }
      if (
        result.status !== "connected" ||
        typeof result.encryptedKey !== "string" ||
        typeof result.connectionId !== "string" ||
        typeof result.orgId !== "string"
      ) {
        await store.removePending();
        throw new Error("Runtime returned an invalid connection result.");
      }
      let key: string;
      try {
        key = privateDecrypt(
          { key: privateKey, oaepHash: "sha256" },
          Buffer.from(result.encryptedKey, "base64"),
        ).toString("utf8");
      } catch {
        await store.removePending();
        throw new Error("Could not verify Runtime's connection result. Start again.");
      }
      if (!/^rtcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/.test(key)) {
        await store.removePending();
        throw new Error("Runtime returned an invalid credential.");
      }
      // Persist before confirmation: losing the response must never lose access
      // or make onboarding falsely report that the agent is connected.
      await store.save({
        version: 1,
        apiOrigin: origins.api,
        authOrigin: origins.auth,
        key,
        connectionId: result.connectionId,
        orgId: result.orgId,
        agentName: name,
      });
      await store.removePending();
      await request("confirm", undefined, key);
      return { connected: true as const, agentName: name, orgId: result.orgId };
    },
  };
}
