import { Runtime } from "../client.js";
import type { SandboxSession } from "../sandbox.js";
import { guard, NotSupportedError, responseError } from "./errors.js";
import type { RuntimeSandbox } from "./client.js";
import type { SessionCreateOptions, SessionWithToken } from "./types.js";

/* Blaxel's sandbox sessions over Runtime's (ARCHITECTURE.md section 3.12).
 *
 * In Blaxel a session is a private preview of the sandbox's own API with a
 * token: a frontend holding it drives the sandbox without the workspace key.
 * On Runtime it is a sandbox session: a token that runs commands, reads and
 * writes files and reaches previews of that one sandbox, and nothing else.
 *
 * What maps, and how:
 * - `expiresAt`: Blaxel's default is a day from now, which is Runtime's most.
 *   Later than a day is refused rather than quietly shortened.
 * - `responseHeaders["Access-Control-Allow-Origin"]`: the page that may use it,
 *   which is how Runtime limits a session to origins. One origin, or several
 *   separated by commas; `*` is refused, because a session names its pages.
 *   Runtime answers the other CORS headers itself, so Access-Control-Allow-*
 *   headers are accepted and need nothing; any other response header is not
 *   supported.
 * - `requestHeaders`: headers Blaxel adds to each request into the sandbox.
 *   Runtime's session reaches the sandbox's commands and files, not a server
 *   in it, so there is nothing to add them to.
 * - `url`: the sandbox's address in Runtime's API, which fromSession reads the
 *   sandbox from. `name`: `session-<id>`. */

const DAY_MS = 86_400_000;
const PREFIX = "session-";
const SANDBOX_URL =
  /^(https?:\/\/[^/]+)\/v1\/sandboxes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function origins(headers: Record<string, string> = {}): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "access-control-allow-origin") {
      for (const origin of value
        .split(",")
        .map((one) => one.trim())
        .filter(Boolean)) {
        if (origin === "*")
          throw new NotSupportedError(
            'A session for every origin (Access-Control-Allow-Origin: "*")',
            'Name the page that uses it: responseHeaders: { "Access-Control-Allow-Origin": "https://app.example.com" }.',
          );
        found.push(origin.replace(/\/$/, ""));
      }
    } else if (!lower.startsWith("access-control-"))
      throw new NotSupportedError(
        `Session response header ${name}`,
        "Runtime answers a session's CORS headers itself; set other headers in the server your page talks to.",
      );
  }
  return found;
}

function seconds(expiresAt: Date | undefined): number {
  const at = expiresAt ?? new Date(Date.now() + DAY_MS);
  const left = Math.floor((at.getTime() - Date.now()) / 1000);
  if (!Number.isFinite(left) || left < 60)
    throw responseError(400, "A session must last at least a minute.");
  if (left > DAY_MS / 1000 + 5)
    throw new NotSupportedError(
      "A session lasting more than a day",
      "Make one for a day at most, and createIfExpired() again before it ends.",
    );
  return Math.min(left, DAY_MS / 1000);
}

function withToken(
  session: SandboxSession & { token?: string | null },
  apiUrl: string,
  token = "",
): SessionWithToken {
  return {
    name: `${PREFIX}${session.id}`,
    url: `${apiUrl}/v1/sandboxes/${session.sandboxId}`,
    token: session.token ?? token,
    expiresAt: new Date(session.expiresAt),
  };
}

/** The session createIfExpired made last, per sandbox, in this process. */
const made = new Map<string, SessionWithToken>();

/** Blaxel's `sandbox.sessions`. */
export class SandboxSessions {
  readonly #run: <T>(work: (runtime: RuntimeSandbox) => Promise<T>) => Promise<T>;
  readonly #apiUrl: () => string;
  readonly #id: string;
  constructor(sandbox: {
    id: string;
    run: <T>(work: (runtime: RuntimeSandbox) => Promise<T>) => Promise<T>;
    apiUrl: () => string;
  }) {
    this.#id = sandbox.id;
    this.#run = sandbox.run;
    this.#apiUrl = sandbox.apiUrl;
  }

  /** A new session, for a day unless `expiresAt` says sooner. */
  async create(options: SessionCreateOptions = {}): Promise<SessionWithToken> {
    if (options.requestHeaders && Object.keys(options.requestHeaders).length)
      throw new NotSupportedError(
        "Session request headers (requestHeaders)",
        "A Runtime session drives the sandbox's commands and files directly; pass what the headers carried as the command's env or a file.",
      );
    const made = await this.#run((runtime) =>
      guard(() =>
        runtime.sessions.create({
          ttlSeconds: seconds(options.expiresAt),
          origins: origins(options.responseHeaders),
        }),
      ),
    );
    return withToken(made, made.apiUrl || this.#apiUrl());
  }

  /** Blaxel's: the session made last, if it lasts at least `delta` ms more
   * (an hour unless given), else a new one, and the old one ends. A token is
   * shown only when its session is made, so "the session made last" is the
   * one this process made for this sandbox; a new process makes a new one. */
  async createIfExpired(
    options: SessionCreateOptions = {},
    delta = 60 * 60 * 1000,
  ): Promise<SessionWithToken> {
    const kept = made.get(this.#id);
    if (kept) {
      const live = (await this.list()).some((session) => session.name === kept.name);
      if (live && kept.expiresAt.getTime() >= Date.now() + delta) return kept;
      if (live) await this.delete(kept.name).catch(() => undefined);
    }
    const fresh = await this.create(options);
    made.set(this.#id, fresh);
    return fresh;
  }

  /** Active sessions, newest first. A token is shown only when its session is
   * made, so these carry an empty `token`: keep the one `create` gave. */
  async list(): Promise<SessionWithToken[]> {
    const sessions = await this.#run((runtime) => guard(() => runtime.sessions.list()));
    return sessions
      .filter((session) => session.state === "active")
      .map((session) => withToken(session, this.#apiUrl()));
  }

  async get(name: string): Promise<Omit<SessionWithToken, "name">> {
    const id = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
    const found = (await this.#run((runtime) => guard(() => runtime.sessions.list()))).find(
      (session) => session.id === id,
    );
    if (!found) throw responseError(404, `Session ${name} not found.`);
    const { name: _name, ...rest } = withToken(found, this.#apiUrl());
    return rest;
  }

  /** Blaxel's delete: the session ends at once. */
  async delete(name: string): Promise<SessionWithToken> {
    const id = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
    const revoked = await this.#run((runtime) => guard(() => runtime.sessions.revoke(id)));
    return withToken(revoked, this.#apiUrl());
  }
}

/** The client and sandbox a session reaches, for `SandboxInstance.fromSession`.
 * The sandbox is read once with the session, which may read it. */
export async function sessionSandbox(
  session: SessionWithToken,
): Promise<{ client: Runtime; runtime: RuntimeSandbox }> {
  const found = SANDBOX_URL.exec(session.url ?? "");
  if (!found || !session.token?.startsWith("rtsess_"))
    throw new NotSupportedError(
      "A session Runtime did not make",
      "Make the session with sandbox.sessions.create() on your backend, where a Runtime key is set, and pass what it returns.",
    );
  const client = new Runtime({ apiKey: session.token, baseUrl: found[1]! });
  const runtime = await guard(() => client.sandboxes.get(found[2]!));
  return { client, runtime };
}
