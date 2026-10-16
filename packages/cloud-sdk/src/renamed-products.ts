import { RuntimeError } from "./errors.js";
import { PRODUCT_NAMES, wordOf, type ProductName } from "./product-names.js";
import { resolveWord, sdkPath } from "./product-renames.js";
import type { Sandboxes } from "./client.js";
import type { Snapshots } from "./snapshots.js";
import type { ClientExtensions } from "./products/index.js";

/* CLOUD.md section 4: one plural word names a product everywhere, and an old
 * word keeps working for 30 days after the rename ships, each use warning with
 * the new word; then it fails with name_retired and a hint. The dates are in
 * product-names.ts, the same table the API, MCP and CLI read. */

/** The client's properties under their old words, each the product it became. */
export type RenamedProducts = {
  /** @deprecated Renamed `runtime.sandboxes`; works for 30 days after the rename, with a warning. */
  readonly sandbox: Sandboxes;
  /** @deprecated Renamed `runtime.snapshots`; works for 30 days after the rename, with a warning. */
  readonly snapshot: Snapshots;
  /** @deprecated Renamed `runtime.images`; works for 30 days after the rename, with a warning. */
  readonly image: ClientExtensions["images"];
  /** @deprecated Renamed `runtime.volumes`; works for 30 days after the rename, with a warning. */
  readonly volume: ClientExtensions["volumes"];
  /** @deprecated Renamed `runtime.jobs`; works for 30 days after the rename, with a warning. */
  readonly job: ClientExtensions["jobs"];
  /** @deprecated Renamed `runtime.domains`; works for 30 days after the rename, with a warning. */
  readonly domain: ClientExtensions["domains"];
  /** @deprecated Renamed `runtime.ports`; works for 30 days after the rename, with a warning. */
  readonly port: ClientExtensions["ports"];
  /** @deprecated Renamed `runtime.ips`; works for 30 days after the rename, with a warning. */
  readonly address: ClientExtensions["ips"];
  /** @deprecated Renamed `runtime.ips`; works for 30 days after the rename, with a warning. */
  readonly addresses: ClientExtensions["ips"];
  /** @deprecated Renamed `runtime.networks`; works for 30 days after the rename, with a warning. */
  readonly network: ClientExtensions["networks"];
  /** @deprecated Renamed `runtime.networks.wireguard`; works for 30 days after the rename, with a warning. */
  readonly tunnel: ClientExtensions["networks"]["wireguard"];
};

const said = new Set<string>();

/** Puts each old word on `client` as a property that answers the product it
 * became and says so once per process, or, from the table's date, throws
 * name_retired with a hint naming the new property. An old word the client
 * already uses for something else is left alone. */
export function installRenamedProducts(
  client: object,
  options: {
    now?: () => Date;
    table?: readonly ProductName[];
    say?: (line: string) => void;
  } = {},
): void {
  const table = options.table ?? PRODUCT_NAMES;
  for (const product of table) {
    for (const old of product.old) {
      const [property] = sdkPath(wordOf(old.name));
      if (property === undefined || property in client) continue;
      Object.defineProperty(client, property, {
        configurable: true,
        enumerable: false,
        get() {
          const use = resolveWord(old.name, "sdk", options.now?.() ?? new Date(), table);
          if (use === undefined || use.kind === "current") return undefined;
          if (use.kind === "retired") throw new RuntimeError({ ...use.error });
          if (!said.has(use.warning)) {
            said.add(use.warning);
            (options.say ?? console.warn)(`Runtime: ${use.warning}`);
          }
          return sdkPath(use.to).reduce<unknown>(
            (at, key) => (at as Record<string, unknown>)[key],
            client,
          );
        },
      });
    }
  }
}
