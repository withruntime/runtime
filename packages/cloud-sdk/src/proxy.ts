/* Proxies named by the environment: HTTPS_PROXY, HTTP_PROXY and NO_PROXY, in
   lower or upper case, the lower winning when both are set (as curl reads
   them). Bun's fetch reads them itself; its WebSocket and Node's fetch and
   WebSocket do not unless NODE_USE_ENV_PROXY was set before the process
   started, which a library cannot do for its host. So every call the SDK and
   the CLI make goes through `envFetch` and `openWebSocket`, which route by the
   same rule on every runtime:

   - an https:// or wss:// address uses HTTPS_PROXY; an http:// or ws:// one
     uses HTTP_PROXY. HTTP_PROXY is never used for HTTPS (curl, Bun, Python
     and Go agree; Node's own env support would fall back to it). A connection
     error says so when that is why nothing was tried.
   - NO_PROXY is a list of host names split by commas or spaces. A name
     covers its subdomains, a leading dot is allowed, host:port limits it to
     one port, and `*` alone means every host.
   - A proxy address without a scheme is http://. Only http:// and https://
     proxies are spoken to.

   On Node the proxy is undici's ProxyAgent: undici is Node's own HTTP client
   (the code under its fetch and WebSocket), loaded only when a proxy applies.
   On Bun the proxy is passed to fetch and WebSocket as their `proxy` option. */

import { RuntimeError } from "./errors.js";

type Env = Record<string, string | undefined>;

/** How a call to an address leaves this machine. */
export type Route = {
  /** The proxy's address, credentials included, to connect through. */
  proxy?: string;
  /** The proxy as it may be shown: no user name or password. */
  shown?: string;
  /** The variable the proxy or the exemption came from. */
  variable?: string;
  /** Set when NO_PROXY exempts the host: the entry that matched. */
  exempt?: string;
  /** HTTP_PROXY was set but HTTPS_PROXY was not, for an HTTPS address. */
  httpOnly?: string;
};

const processEnv = (): Env => (typeof process === "undefined" ? {} : process.env);

function variable(env: Env, name: string): { value: string; name: string } | undefined {
  for (const candidate of [name.toLowerCase(), name.toUpperCase()]) {
    const value = env[candidate]?.trim();
    if (value) return { value, name: candidate };
  }
  return undefined;
}

/** Whether a NO_PROXY list names this host (and port). Returns the entry. */
export function exemption(list: string, hostname: string, port: string): string | undefined {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  for (const raw of list.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return entry;
    const match = /^(.*?)(?::(\d+))?$/.exec(entry.replace(/^\[(.*)\]/, "$1"))!;
    const name = match[1]!.replace(/^\./, "").replace(/\.$/, "");
    if (!name || (match[2] && match[2] !== port)) continue;
    if (host === name || host.endsWith(`.${name}`)) return entry;
  }
  return undefined;
}

/** The route the SDK takes to `target`, read from the environment now. */
export function routeFor(target: string, env: Env = processEnv()): Route {
  const url = new URL(target);
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const port = url.port || (secure ? "443" : "80");
  const found = variable(env, secure ? "https_proxy" : "http_proxy");
  if (!found) {
    const http = secure ? variable(env, "http_proxy") : undefined;
    return http ? { httpOnly: http.name } : {};
  }
  const skip = variable(env, "no_proxy");
  const exempt = skip && exemption(skip.value, url.hostname, port);
  if (skip && exempt) return { exempt, variable: skip.name };
  const proxy = /^[a-z][a-z0-9+.-]*:\/\//i.test(found.value)
    ? found.value
    : `http://${found.value}`;
  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    throw invalidProxy(found.name, found.value, "is not an address");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw invalidProxy(found.name, `${parsed.protocol}//${parsed.host}`, "is not an HTTP proxy");
  return { proxy, shown: `${parsed.protocol}//${parsed.host}`, variable: found.name };
}

function invalidProxy(name: string, shown: string, problem: string): RuntimeError {
  return new RuntimeError({
    message: `${name} (${shown}) ${problem}; Runtime connects through http:// and https:// proxies.`,
    code: "invalid_proxy",
    status: 0,
    hint: `Set ${name} to the proxy's address, for example http://proxy.example.com:3128, or unset it.`,
  });
}

/** Words for a failed connection: the route it took, and what to check.
 * `cause` is the error fetch threw, or the status a proxy answered with (Bun's
 * fetch hands a refused tunnel back as a response). */
export function describeRoute(
  target: string,
  cause: unknown,
  env: Env = processEnv(),
): { via: string; hint?: string } {
  let route: Route;
  try {
    route = routeFor(target, env);
  } catch {
    return { via: "" };
  }
  const url = new URL(target);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (route.proxy) {
    const status = typeof cause === "number" ? cause : proxyStatus(cause);
    return {
      via: ` through the proxy ${route.shown} (${route.variable})${status ? `, which answered HTTP ${status} to the tunnel request` : ""}`,
      hint:
        status === 407
          ? `The proxy wants credentials: put them in ${route.variable}, as http://user:password@host:port.`
          : `Check that the proxy is running and allows CONNECT to ${url.hostname}:${port}, or list ${url.hostname} in NO_PROXY to connect directly.`,
    };
  }
  if (route.exempt)
    return {
      via: ` (directly: ${route.variable} lists ${route.exempt})`,
      hint: `Check the network, or remove ${route.exempt} from ${route.variable} to go through the proxy.`,
    };
  if (route.httpOnly)
    return {
      via: " (directly: no HTTPS proxy is set)",
      hint: `${route.httpOnly} is set but HTTPS_PROXY is not, and ${url.hostname} is HTTPS. Set HTTPS_PROXY to the proxy to use it.`,
    };
  return { via: "" };
}

/** The status a proxy refused a tunnel with, from undici's or Bun's error. */
function proxyStatus(cause: unknown): number | undefined {
  for (let error = cause, depth = 0; error && depth < 5; depth++) {
    const message = (error as { message?: unknown }).message;
    const text = typeof message === "string" ? message : "";
    const found = /proxy response \((\d{3})\)|proxy.*?\b(40[37]|50[0-9])\b/i.exec(text);
    if (found) return Number(found[1] ?? found[2]);
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}

const isBun = () => typeof process !== "undefined" && !!process.versions?.bun;
const isNode = () =>
  typeof process !== "undefined" &&
  !!process.versions?.node &&
  !process.versions.bun &&
  !("Deno" in globalThis);

type Undici = {
  fetch: (input: string, init: Record<string, unknown>) => Promise<unknown>;
  WebSocket: new (url: string, init: Record<string, unknown>) => WebSocket;
  dispatcher: unknown;
};
const agents = new Map<string, Promise<Undici>>();
/** One undici ProxyAgent per proxy address, so connections are reused. */
function undici(proxy: string): Promise<Undici> {
  let agent = agents.get(proxy);
  if (!agent) {
    agent = import("undici").then((module) => ({
      fetch: module.fetch as unknown as Undici["fetch"],
      WebSocket: module.WebSocket as unknown as Undici["WebSocket"],
      dispatcher: new module.ProxyAgent({ uri: proxy }),
    }));
    agent.catch(() => agents.delete(proxy));
    agents.set(proxy, agent);
  }
  return agent;
}

/** fetch, through the proxy the environment names for the address. */
export const envFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { proxy } = routeFor(target);
  if (proxy && isBun()) return fetch(input, { ...init, proxy } as unknown as RequestInit);
  if (proxy && isNode()) {
    const { fetch: proxied, dispatcher } = await undici(proxy);
    return (await proxied(target, { ...init, dispatcher })) as Response;
  }
  return fetch(input, init);
}) as typeof fetch;

/** A WebSocket, through the proxy the environment names for the address. */
export async function openWebSocket(
  url: string,
  headers: Record<string, string>,
): Promise<WebSocket> {
  const { proxy } = routeFor(url);
  if (proxy && isNode()) {
    const { WebSocket: Proxied, dispatcher } = await undici(proxy);
    return new Proxied(url, { headers, dispatcher });
  }
  const Socket = globalThis.WebSocket as unknown as new (url: string, init: unknown) => WebSocket;
  if (!Socket) throw new Error("This runtime has no WebSocket; use Node 22+ or Bun.");
  return new Socket(url, proxy && isBun() ? { headers, proxy } : { headers });
}
