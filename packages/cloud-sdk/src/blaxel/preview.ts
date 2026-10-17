import type { Preview as RuntimePreview } from "../products/previews.js";
import type { RuntimeSandbox } from "./client.js";
import { guard, isNotFound, NotSupportedError, responseError } from "./errors.js";
import { PREVIEW } from "./lookup.js";

/* `sandbox.previews` over Runtime previews: a port shared at
   `https://<port>-<sandbox>.runtimehost.com`, public or behind a token.
   Runtime keys a preview by its port; the Blaxel name is kept in a label on
   the sandbox (`blaxel/preview.<name>`), so any client finds it by name. */

export type PreviewMetadata = {
  name: string;
  displayName?: string;
  resourceName?: string;
  resourceType?: string;
  workspace?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type PreviewSpec = {
  customDomain?: string;
  expires?: string;
  port?: number;
  prefixUrl?: string;
  public?: boolean;
  readonly region?: string;
  requestHeaders?: { [key: string]: string };
  responseHeaders?: { [key: string]: string };
  ttl?: string;
  readonly url?: string;
};
export type Preview = {
  events?: Array<Record<string, unknown>>;
  metadata: PreviewMetadata;
  spec: PreviewSpec;
  status?: string;
};
/** @blaxel/core 0.3.29's shorthand for `previews.create` and
 * `createIfNotExists`: a port, with a name (`preview-<port>` when left out)
 * and public (false when left out). */
export type SandboxPreviewCreateConfiguration = {
  port: number;
  name?: string;
  public?: boolean;
};

const isShorthand = (preview: Preview | SandboxPreviewCreateConfiguration): boolean =>
  !("metadata" in preview || "spec" in preview);

/** Blaxel's shorthand as the full shape, with Blaxel's checks and messages. */
function normalizePreview(preview: Preview | SandboxPreviewCreateConfiguration): Preview {
  if (!isShorthand(preview)) return preview as Preview;
  const short = preview as SandboxPreviewCreateConfiguration;
  if (!Number.isInteger(short.port) || short.port < 1 || short.port > 65535)
    throw new RangeError("Preview port must be an integer between 1 and 65535");
  if (short.name !== undefined && (typeof short.name !== "string" || short.name.length === 0))
    throw new RangeError("Preview name must be a nonempty string");
  if (short.public !== undefined && typeof short.public !== "boolean")
    throw new RangeError("Preview public must be a boolean");
  return {
    metadata: { name: short.name ?? `preview-${short.port}` },
    spec: { port: short.port, public: short.public ?? false },
  };
}

export type PreviewToken = {
  metadata: { name: string; resourceName?: string; previewName?: string };
  spec: { readonly expired?: boolean; expiresAt?: string; readonly token?: string };
};

/** What the previews need from their sandbox. */
export interface PreviewContext {
  readonly sandboxName: string;
  /** The Runtime sandbox's id, when known: tokens made for a sandbox are
   * never reused for another of the same name. */
  readonly sandboxId?: string;
  run<T>(work: (runtime: RuntimeSandbox) => Promise<T>): Promise<T>;
  /** The sandbox's labels as last read. */
  labels(): Record<string, string>;
  /** Sets (or with undefined removes) some of the adapter's labels. */
  setLabels(changes: Record<string, string | undefined>): Promise<void>;
}

function checkName(name: string) {
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(name))
    throw new NotSupportedError(
      `The preview name "${name}"`,
      "Use 1 to 48 letters, digits, dots, dashes or underscores.",
    );
}

function modelOf(
  preview: RuntimePreview,
  name: string,
  sandboxName: string,
  status = "DEPLOYED",
): Preview {
  return {
    metadata: {
      name,
      resourceName: sandboxName,
      resourceType: "sandbox",
      createdAt: preview.createdAt,
    },
    spec: {
      port: preview.port,
      public: preview.visibility === "public",
      url: preview.url.replace(/\/$/, ""),
    },
    status,
  };
}

/** A preview token, as Blaxel's. Runtime reads it from the
 * `x-runtime-preview-token` header or `?runtime_preview_token=`. */
export class SandboxPreviewToken {
  readonly #token: PreviewToken;
  constructor(previewToken: PreviewToken) {
    this.#token = previewToken;
  }
  get name(): string {
    return this.#token.metadata?.name ?? "";
  }
  get value(): string {
    return this.#token.spec.token ?? "";
  }
  get expiresAt(): string | Date {
    return this.#token.spec.expiresAt ?? new Date();
  }
  get expired(): boolean {
    const at = this.#token.spec.expiresAt;
    return at !== undefined && Date.parse(at) <= Date.now();
  }
}

/** The token createIfExpired made last, per sandbox and port, in this
 * process: Runtime keeps no list of the tokens it signed. */
const madeTokens = new Map<string, { token: SandboxPreviewToken; expiresAt: number }>();

/** A preview's tokens. Runtime signs a token for a duration; it keeps no
 * list of the tokens issued. */
export class SandboxPreviewTokens {
  readonly #preview: SandboxPreview;
  readonly #ctx: PreviewContext;
  constructor(preview: SandboxPreview, ctx: PreviewContext) {
    this.#preview = preview;
    this.#ctx = ctx;
  }
  get previewName(): string {
    return this.#preview.name;
  }
  get resourceName(): string {
    return this.#ctx.sandboxName;
  }
  #key(): string {
    return `${this.#ctx.sandboxId ?? this.#ctx.sandboxName}:${this.#preview.spec.port}`;
  }
  /** A token bounded by `expiresAt`; native signing floors milliseconds and
   * caps it to the caller's session. Older servers refuse without a TTL fallback. */
  async create(expiresAt: Date): Promise<SandboxPreviewToken> {
    const requested = expiresAt.getTime();
    if (!Number.isFinite(requested))
      throw responseError(400, "A preview token needs a valid expiration date.");
    const remaining = requested - Date.now();
    if (remaining < 60_000 || remaining > 7 * 86_400_000)
      throw new NotSupportedError(
        "A preview token lasting less than a minute or more than a week",
        "Request an expiration at least one minute and at most seven days away.",
      );
    const got = await this.#ctx.run((runtime) =>
      runtime.previews.get(this.#preview.spec.port!, undefined, {
        expiresAt: expiresAt.toISOString(),
      }),
    );
    const actual = got.tokenExpiresAt === null ? Number.NaN : Date.parse(got.tokenExpiresAt);
    if (!got.token || !Number.isFinite(actual) || actual > requested)
      throw new NotSupportedError(
        "A preview token with the requested expiration",
        "The server must issue a token that never outlives the requested expiration; no duration-based fallback was requested.",
      );
    return new SandboxPreviewToken({
      metadata: { name: `token-${Date.now()}`, previewName: this.previewName },
      spec: { token: got.token, expiresAt: got.tokenExpiresAt! },
    });
  }
  /** Blaxel's (0.3.29): the latest token lasting at least `minValidity` ms
   * more (an hour unless given) and not past `expiresAt` (a day from now
   * unless given), else a new one until `expiresAt`. Blaxel picks among the
   * preview's listed tokens; Runtime keeps no list, so the one reused is the
   * token this call made last in this process for this sandbox's port, and a
   * new process makes a new one. Arguments are checked as Blaxel does. */
  async createIfExpired(
    expiresAt?: Date,
    minValidity: number = 3_600_000,
  ): Promise<SandboxPreviewToken> {
    const now = Date.now();
    if (!Number.isFinite(minValidity) || minValidity < 0)
      throw new RangeError("minValidity must be finite and non-negative");
    const requested = expiresAt ?? new Date(now + 86_400_000);
    const ceiling = requested instanceof Date ? requested.getTime() : Number.NaN;
    if (!Number.isFinite(ceiling) || ceiling <= now || ceiling < now + minValidity)
      throw new RangeError("expiresAt must be a valid future date at least minValidity from now");
    if (this.#preview.spec.public === true)
      throw new Error("Cannot create or reuse a token for a public preview");
    const key = this.#key();
    const kept = madeTokens.get(key);
    if (
      kept &&
      kept.expiresAt > now &&
      kept.expiresAt >= now + minValidity &&
      kept.expiresAt <= ceiling
    )
      return kept.token;
    const token = await this.create(requested);
    const until = Date.parse(String(token.expiresAt));
    if (Number.isFinite(until)) madeTokens.set(key, { token, expiresAt: until });
    return token;
  }
  list(): Promise<never> {
    return Promise.reject(
      new NotSupportedError(
        "Listing a preview's tokens",
        "Runtime keeps no list of issued tokens: keep the ones you create, or create a new one.",
      ),
    );
  }
  /** Revokes the preview's tokens. Runtime cannot revoke one token alone, so
   * every token issued for this preview stops working. */
  async delete(_tokenName: string): Promise<{ message?: string }> {
    const port = this.#preview.spec.port!;
    await this.#ctx.run((runtime) => runtime.previews.rotate(port));
    madeTokens.delete(this.#key());
    return { message: "Every token of this preview was revoked" };
  }
}

/** A shared port, as Blaxel's SandboxPreview. */
export class SandboxPreview {
  readonly #preview: Preview;
  readonly tokens: SandboxPreviewTokens;
  constructor(preview: Preview, ctx: PreviewContext) {
    this.#preview = preview;
    this.tokens = new SandboxPreviewTokens(this, ctx);
  }
  get name(): string {
    return this.#preview.metadata.name;
  }
  get metadata(): PreviewMetadata {
    return this.#preview.metadata;
  }
  get spec(): PreviewSpec {
    return this.#preview.spec;
  }
  /** The preview's address (`spec.url`), or `""`. */
  get url(): string {
    return this.#preview.spec?.url ?? "";
  }
}

/** `sandbox.previews`. */
export class SandboxPreviews {
  readonly #ctx: PreviewContext;
  constructor(ctx: PreviewContext) {
    this.#ctx = ctx;
  }
  get sandboxName(): string {
    return this.#ctx.sandboxName;
  }

  /** Names by port, from the sandbox's labels. */
  #names(): Map<number, string> {
    const names = new Map<number, string>();
    for (const [key, value] of Object.entries(this.#ctx.labels()))
      if (key.startsWith(PREVIEW)) names.set(Number(value), key.slice(PREVIEW.length));
    return names;
  }
  #portOf(name: string): number | undefined {
    const label = this.#ctx.labels()[`${PREVIEW}${name}`];
    if (label !== undefined) return Number(label);
    const plain = /^preview-(\d{1,5})$/.exec(name);
    return plain ? Number(plain[1]) : undefined;
  }

  /** Every shared port. One Runtime shared without a Blaxel name is named
   * `preview-<port>`. */
  async list(): Promise<SandboxPreview[]> {
    const previews = await this.#ctx.run((runtime) => runtime.previews.list());
    const names = this.#names();
    return previews.map(
      (one) =>
        new SandboxPreview(
          modelOf(one, names.get(one.port) ?? `preview-${one.port}`, this.sandboxName),
          this.#ctx,
        ),
    );
  }

  /** Shares `spec.port`: public with `spec.public`, else behind a token.
   * Blaxel's shorthand `{ port, name?, public? }` is a private
   * `preview-<port>` unless it says otherwise. */
  async create(
    input: Preview | SandboxPreviewCreateConfiguration,
    _force?: boolean,
  ): Promise<SandboxPreview> {
    const preview =
      input && typeof input === "object" ? normalizePreview(input) : (input as Preview);
    const spec = preview?.spec ?? {};
    const name = preview?.metadata?.name;
    const refusals: Array<[keyof PreviewSpec, string]> = [
      [
        "prefixUrl",
        "Runtime's preview address is fixed: https://<port>-<sandbox>.runtimehost.com.",
      ],
      [
        "customDomain",
        "Point your domain at the preview with runtime.domains, or keep the preview's own address.",
      ],
      [
        "requestHeaders",
        "Set the headers in your server, or in the client that calls the preview.",
      ],
      ["responseHeaders", "Set the headers (CORS and the rest) in your server's responses."],
      [
        "ttl",
        "A Runtime preview lasts until deleted: call sandbox.previews.delete(name) when done.",
      ],
      [
        "expires",
        "A Runtime preview lasts until deleted: call sandbox.previews.delete(name) when done.",
      ],
    ];
    for (const [field, alternative] of refusals)
      if (
        spec[field] !== undefined &&
        !(typeof spec[field] === "object" && !Object.keys(spec[field]).length)
      )
        throw new NotSupportedError(`A preview's ${field}`, alternative);
    const port = spec.port;
    if (!Number.isInteger(port) || port! < 1 || port! > 65_535)
      throw responseError(400, "spec.port is required: the port your server listens on");
    if (name !== undefined) checkName(name);
    const [made] = await Promise.all([
      this.#ctx.run((runtime) =>
        runtime.previews.create(port!, { visibility: spec.public ? "public" : "private" }),
      ),
      name !== undefined && this.#portOf(name) !== port
        ? this.#ctx.setLabels({ [`${PREVIEW}${name}`]: String(port) })
        : undefined,
    ]);
    return new SandboxPreview(
      modelOf(made, name ?? `preview-${port}`, this.sandboxName),
      this.#ctx,
    );
  }

  /** The named preview, or a new one when there is none. An existing
   * preview is answered as it is: the shorthand's private default applies
   * only to a new one. */
  async createIfNotExists(
    input: Preview | SandboxPreviewCreateConfiguration,
    force?: boolean,
  ): Promise<SandboxPreview> {
    const preview = normalizePreview(input);
    try {
      return await this.get(preview.metadata.name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      return await this.create(preview, force);
    } catch (error) {
      // Blaxel's race: another caller made it first.
      if (!isShorthand(input) || (error as { status?: unknown } | null)?.status !== 409)
        throw error;
      return this.get(preview.metadata.name);
    }
  }

  async get(previewName: string): Promise<SandboxPreview> {
    const port = this.#portOf(previewName);
    if (port === undefined) throw responseError(404, `preview ${previewName} not found`);
    const found = await this.#ctx.run((runtime) => runtime.previews.get(port));
    return new SandboxPreview(modelOf(found, previewName, this.sandboxName), this.#ctx);
  }

  /** Stops sharing the port; its open connections are closed before this returns. */
  async delete(previewName: string): Promise<Preview> {
    const port = this.#portOf(previewName);
    if (port === undefined) throw responseError(404, `preview ${previewName} not found`);
    await Promise.all([
      this.#ctx.run((runtime) => runtime.previews.delete(port)),
      `${PREVIEW}${previewName}` in this.#ctx.labels()
        ? this.#ctx.setLabels({ [`${PREVIEW}${previewName}`]: undefined })
        : undefined,
    ]);
    return {
      metadata: { name: previewName, resourceName: this.sandboxName, resourceType: "sandbox" },
      spec: { port },
      status: "DELETING",
    };
  }
}

/** A private preview of `port` with a token that lasts a while, for
 * `sandbox.fetch`: made once, then reused until its token nears its end. */
export async function portAccess(
  runtime: RuntimeSandbox,
  port: number,
): Promise<{ url: string; token: string | null; until: number }> {
  let preview: RuntimePreview;
  try {
    preview = await guard(() => runtime.previews.get(port, 3600));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    preview = await guard(() => runtime.previews.create(port, { ttlSeconds: 3600 }));
  }
  const until = preview.tokenExpiresAt ? Date.parse(preview.tokenExpiresAt) : Infinity;
  return { url: preview.url.replace(/\/$/, ""), token: preview.token, until };
}
