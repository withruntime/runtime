import { RuntimeError } from "./errors.js";
import { sandboxMarker } from "./transport.js";

/** An identity token, as the API returns it. */
export type IdentityToken = {
  /** The OIDC ID token (a JWT), signed by Runtime. */
  token: string;
  expiresAt: string;
  /** https://withruntime.com/oidc */
  issuer: string;
  /** org:<org>:image:<image>:sandbox:<sandbox> */
  subject: string;
  audience: string;
};

type Credentials = { url: string; token: string };

async function requestCredentials(): Promise<Credentials | null> {
  const url = process.env.RUNTIME_ID_TOKEN_REQUEST_URL;
  const token = process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN;
  if (url && token) return { url, token };
  // A process started without them (a server started before the guest wrote
  // its environment, a sandbox whose guest software predates the variables)
  // asks the host, which answers every running sandbox whatever its image or
  // age, then the guest's file. Only inside a sandbox: elsewhere nothing is
  // asked over the network.
  if (!(await exists(sandboxMarker.path))) return null;
  return currentCredentials();
}

async function exists(path: string): Promise<boolean> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileCredentials(): Promise<Credentials | null> {
  try {
    // Loaded here, so the SDK still loads where there is no file system.
    const { readFile } = await import("node:fs/promises");
    const env = JSON.parse(await readFile(sandboxMarker.path, "utf8")) as Record<string, string>;
    const url = env.RUNTIME_ID_TOKEN_REQUEST_URL;
    const token = env.RUNTIME_ID_TOKEN_REQUEST_TOKEN;
    return url && token ? { url, token } : null;
  } catch {
    return null;
  }
}

/** The sandbox's own listener (packages/cloud/src/linux/egress.ts). */
const ENVIRONMENT_URL = "http://runtime.internal/v1/environment";

/** The sandbox's request token as its host holds it now. The one in
 * process.env was current when the process started: it changes with every
 * renewal of the sandbox's lease (about every 30 minutes for one that keeps
 * running), and a server restored from a snapshot (an App's copies, a fork)
 * holds the statement of the sandbox it was saved from. The host's listener
 * answers this sandbox's own; guest-net.py's file is a few seconds behind it. */
async function currentCredentials(signal?: AbortSignal): Promise<Credentials | null> {
  try {
    const response = await fetch(ENVIRONMENT_URL, {
      signal: signal ?? AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const env = (await response.json()) as Record<string, unknown>;
      const url = env.RUNTIME_ID_TOKEN_REQUEST_URL;
      const token = env.RUNTIME_ID_TOKEN_REQUEST_TOKEN;
      if (typeof url === "string" && url && typeof token === "string" && token)
        return { url, token };
    }
  } catch {
    // Not in a sandbox, or a host that predates the listener's environment.
  }
  return fileCredentials();
}

/**
 * Inside a Runtime sandbox: a short-lived OIDC token, signed by Runtime,
 * naming this sandbox, its organization and its image, for `audience`. Trade
 * it for cloud credentials without storing a key: AWS
 * AssumeRoleWithWebIdentity (audience `sts.amazonaws.com`), Google Cloud
 * workload identity federation, Azure federated credentials, or your own API.
 * Needs no API key. Lives ten minutes unless asked (60 to 3600 seconds).
 *
 *   import { Sandbox } from "withruntime";
 *   const { token } = await Sandbox.identityToken({ audience: "sts.amazonaws.com" });
 */
export async function identityToken(input: {
  audience: string;
  lifetimeSeconds?: number;
  signal?: AbortSignal;
}): Promise<IdentityToken> {
  const found = await requestCredentials();
  if (!found)
    throw new RuntimeError({
      code: "identity_unavailable",
      status: 0,
      message:
        "Identity tokens are issued only inside a Runtime sandbox (RUNTIME_ID_TOKEN_REQUEST_TOKEN is not set).",
    });
  const ask = (credentials: Credentials) => {
    const url = new URL(credentials.url);
    url.searchParams.set("audience", input.audience);
    if (input.lifetimeSeconds !== undefined)
      url.searchParams.set("lifetimeSeconds", String(input.lifetimeSeconds));
    return fetch(url, {
      headers: { authorization: `Bearer ${credentials.token}` },
      signal: input.signal ?? AbortSignal.timeout(10_000),
    });
  };
  let response = await ask(found);
  // Refused for a request token that is no longer this sandbox's current one:
  // ask once more with the one its host holds now.
  if (response.status === 401 || response.status === 403) {
    const current = await currentCredentials(input.signal);
    if (current && current.token !== found.token) {
      await response.body?.cancel();
      response = await ask(current);
    }
  }
  const body = (await response.json().catch(() => ({}))) as IdentityToken & {
    error?: { code?: string; message?: string; requestId?: string };
  };
  if (!response.ok || !body.token)
    throw new RuntimeError({
      code: body.error?.code ?? "identity_refused",
      status: response.status,
      message: body.error?.message ?? `Could not get an identity token (HTTP ${response.status}).`,
      ...(body.error?.requestId ? { requestId: body.error.requestId } : {}),
    });
  return body;
}

/** The header and audience the website keys its per-network limits on
 * (apps/cloud-web/src/lib/limit-key.ts): inside a sandbox, Runtime's own
 * sign-in calls count against this sandbox, not the address every sandbox on
 * its host shares. */
const LIMIT_HEADER = "x-runtime-sandbox-identity";
const LIMIT_AUDIENCE = "https://withruntime.com/limits";
let limitToken: { token: string; until: number } | undefined;

/** Headers for a call to the website's connect API: this sandbox's identity
 * token, or none outside a sandbox or when one cannot be had. Never throws. */
export async function sandboxIdentityHeaders(): Promise<Record<string, string>> {
  if (limitToken && Date.now() < limitToken.until) return { [LIMIT_HEADER]: limitToken.token };
  if (!(await requestCredentials())) return {};
  try {
    const issued = await identityToken({
      audience: LIMIT_AUDIENCE,
      signal: AbortSignal.timeout(3_000),
    });
    // Renewed a minute before it lapses, so a slow call never carries a dead one.
    limitToken = { token: issued.token, until: Date.parse(issued.expiresAt) - 60_000 };
    return { [LIMIT_HEADER]: issued.token };
  } catch {
    return {};
  }
}
