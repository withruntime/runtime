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

async function requestCredentials(): Promise<{ url: string; token: string } | null> {
  let url = process.env.RUNTIME_ID_TOKEN_REQUEST_URL;
  let token = process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    // A process started before the guest wrote its environment still finds it.
    try {
      // Loaded here, so the SDK still loads where there is no file system.
      const { readFile } = await import("node:fs/promises");
      const env = JSON.parse(await readFile(sandboxMarker.path, "utf8")) as Record<string, string>;
      url = env.RUNTIME_ID_TOKEN_REQUEST_URL;
      token = env.RUNTIME_ID_TOKEN_REQUEST_TOKEN;
    } catch {
      return null;
    }
  }
  return url && token ? { url, token } : null;
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
  const url = new URL(found.url);
  url.searchParams.set("audience", input.audience);
  if (input.lifetimeSeconds !== undefined)
    url.searchParams.set("lifetimeSeconds", String(input.lifetimeSeconds));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${found.token}` },
    signal: input.signal ?? AbortSignal.timeout(10_000),
  });
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
