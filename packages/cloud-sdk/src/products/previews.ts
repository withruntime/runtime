import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";

/** A public HTTPS address for a port inside a sandbox. */
export type Preview = {
  id: string;
  sandboxId: string;
  port: number;
  visibility: "private" | "public";
  /** `https://<port>-<sandbox>.<preview domain>/`. A private preview also
   * needs the token. */
  url: string;
  /** Private previews: a fresh signed token. Send it as the
   * `x-runtime-preview-token` header. */
  token: string | null;
  tokenExpiresAt: string | null;
  /** Private previews: a link that carries the token once, for a browser. */
  urlWithToken: string | null;
  /** Turned off by Runtime after a report. */
  disabled: boolean;
  /** The sites that may show it in an iframe; null for any site. */
  embedOrigins: string[] | null;
  createdAt: string;
  /** On create only: how to share the address, in one line. */
  hint?: string;
};
export type CreatePreview = {
  /** private (default): a token is needed. public: anyone with the address;
   * a browser sees a one-time warning page naming Runtime. */
  visibility?: "private" | "public";
  /** How long the returned token lasts, 60 s to 7 days (default 1 day). */
  ttlSeconds?: number;
  /** The sites that may show it in an iframe, as origins
   * (`https://app.example.com`, `https://*.example.com`, `http://localhost:3000`),
   * up to 16. Any other site's iframe is refused. Omitted: a shared port keeps
   * its list; `[]` or null: any site, the default. */
  embedOrigins?: string[] | null;
};

/** `sbx.previews`: share ports of this sandbox at public HTTPS addresses.
 *
 *   const { url, token } = await sbx.previews.create(3000);
 *   await fetch(url, { headers: { "x-runtime-preview-token": token! } });
 *
 * WebSockets work. The server must listen on 0.0.0.0 or localhost. */
export function sandboxPreviews(t: Transport, sandbox: Sandbox) {
  const base = () => `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/previews`;
  return {
    /** Shares `port`, or changes its visibility and embedOrigins if it is
     * shared already. */
    create: (port: number, input: CreatePreview = {}, options?: RequestOptions) =>
      t.json<Preview>({ method: "POST", path: base(), body: { port, ...input }, ...options }),
    /** Every shared port, each private one with a fresh token. */
    list: async (options?: RequestOptions) =>
      (await t.json<{ data: Preview[] }>({ method: "GET", path: base(), ...options })).data,
    /** One preview, with a fresh token of `ttlSeconds` if it is private. */
    get: (port: number, ttlSeconds?: number, options?: RequestOptions) =>
      t.json<Preview>({
        method: "GET",
        path: `${base()}/${port}`,
        ...(ttlSeconds ? { query: { ttlSeconds } } : {}),
        ...options,
      }),
    /** Refuses every token issued for this port so far and returns a new one. */
    rotate: (port: number, options?: RequestOptions) =>
      t.json<Preview>({ method: "POST", path: `${base()}/${port}:rotate`, ...options }),
    /** Stops sharing `port`. Its open connections are closed before this returns. */
    delete: (port: number, options?: RequestOptions) =>
      t.json<{ id: string; sandboxId: string; port: number; deleted: true }>({
        method: "DELETE",
        path: `${base()}/${port}`,
        ...options,
      }),
  };
}
