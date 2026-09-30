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
export type PreviewToken = {
  metadata: { name: string; resourceName?: string; previewName?: string };
  spec: { readonly expired?: boolean; expiresAt?: string; readonly token?: string };
};

/** What the previews need from their sandbox. */
export interface PreviewContext {
  readonly sandboxName: string;
  run<T>(work: (runtime: RuntimeSandbox) => Promise<T>): Promise<T>;
  /** The sandbox's labels as last read. */
  labels(): Record<string, string>;
  /** Sets (or with undefined removes) some of the adapter's labels. */
  setLabels(changes: Record<string, string | undefined>): Promise<void>;
}

/** Runtime's shortest and longest token, in seconds. */
const TOKEN_MIN = 60;
const TOKEN_MAX = 7 * 86_400;

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
  /** A token that lasts until `expiresAt` (at least a minute, at most a week). */
  async create(expiresAt: Date): Promise<SandboxPreviewToken> {
    const seconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
    if (seconds > TOKEN_MAX)
      throw new NotSupportedError(
        "A preview token lasting more than a week",
        "Create one for at most seven days, and a new one when it runs out.",
      );
    const port = this.#preview.spec.port!;
    const got = await this.#ctx.run((runtime) =>
      runtime.previews.get(port, Math.max(TOKEN_MIN, seconds)),
    );
    return new SandboxPreviewToken({
      metadata: { name: `token-${Date.now()}`, previewName: this.previewName },
      spec: {
        ...(got.token ? { token: got.token } : {}),
        ...(got.tokenExpiresAt ? { expiresAt: got.tokenExpiresAt } : {}),
      },
    });
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

  /** Shares `spec.port`: public with `spec.public`, else behind a token. */
  async create(preview: Preview, _force?: boolean): Promise<SandboxPreview> {
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

  /** The named preview, or a new one when there is none. */
  async createIfNotExists(preview: Preview, force?: boolean): Promise<SandboxPreview> {
    try {
      return await this.get(preview.metadata.name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return this.create(preview, force);
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
