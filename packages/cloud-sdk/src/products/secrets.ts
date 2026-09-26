import type { RequestOptions, Transport } from "../transport.js";

/** Which requests to a secret's hosts carry it: `methods` (every method when
 * absent) and `paths`, each exact (`/v1/chat/completions`) or a prefix ending
 * in `/*` (`/repos/acme/*`), written canonically: starting with `/`, no `.` or
 * `..` segments, no `;` or `\`, no encoded slash. A request whose path could be
 * read two ways gets no secret that has rules. Paid accounts only. */
export type SecretRule = { methods?: string[]; paths: string[] };
/** A secret your sandboxes use without seeing it. Every sandbox of your
 * organization has an environment variable of the secret's name holding
 * `placeholder`; the egress proxy puts the value into HTTPS requests to
 * `hosts` (in the URL and headers), or sets `header` on every such request.
 * The value is never returned. */
export type Secret = {
  name: string;
  hosts: string[];
  header?: string;
  format?: string;
  rules?: SecretRule[];
  placeholder: string;
  valueBytes: number;
  createdAt: string;
  updatedAt: string;
};
export type SetSecret = {
  /** Visible ASCII and spaces, at most 8 KiB. Stored sealed; never returned. */
  value: string;
  /** Where the value may go: `api.openai.com`, `*.github.com`. 1 to 16. */
  hosts: string[];
  /** Set this header on every request to the hosts, replacing the sandbox's own. */
  header?: string;
  /** With `header`: its value, `{value}` where the secret goes. Default `{value}`. */
  format?: string;
  /** Only requests a rule allows carry the value. Paid accounts only. 1 to 16.
   * Absent: every request to the hosts; replacing a secret without rules
   * clears them. */
  rules?: SecretRule[];
};

export function secrets(t: Transport) {
  const path = (name: string) => `/v1/egress-secrets/${encodeURIComponent(name)}`;
  return {
    /** Store or replace a secret. Replacing keeps its placeholder. */
    set: (name: string, input: SetSecret, options?: RequestOptions) =>
      t.json<Secret & { enforced: boolean }>({
        method: "PUT",
        path: path(name),
        body: input,
        ...options,
      }),
    /** Names, hosts and placeholders. Never values. */
    list: async (options?: RequestOptions) =>
      (
        await t.json<{ secrets: Secret[] }>({
          method: "GET",
          path: "/v1/egress-secrets",
          ...options,
        })
      ).secrets,
    /** Delete a secret: its value is erased and its placeholder stops working. */
    delete: (name: string, options?: RequestOptions) =>
      t.json<{ name: string; deleted: true; enforced: boolean }>({
        method: "DELETE",
        path: path(name),
        ...options,
      }),
  };
}
