import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Runtime } from "./client.js";
import { RuntimeError } from "./errors.js";
import { named } from "./cli-name.js";
import { generateWireGuardKeyPair } from "./wireguard.js";

/* The CLI's network products, each its own product under `runtime <product>`
 * (the top level holds only what spans products):
 *
 *   runtime domains add|verify|ls|get|rm     your own hostname for a sandbox's port, with HTTPS
 *   runtime ports   open|ls|close            a public TCP port to a sandbox's port
 *   runtime ips     reserve|ls|release       a dedicated outbound address for allow-lists
 *   runtime networks wireguard create|get|rm|peer ...   a WireGuard tunnel from your network into your sandboxes
 *   runtime networks upstream-proxy set|get|remove      the account's proxy out
 *   runtime networks private on|off|status              your sandboxes reach each other by name
 *   runtime networks signed-requests on|off|status      your sandboxes sign requests as Runtime's agents
 *
 * A dedicated address needs credit on the account, the rest a kept top-up
 *; a refusal says which. */

import type { NetworkFunding, UpstreamProxy } from "./products/network-products.js";
import type { PrivateNetwork } from "./products/private-network.js";
import type { SignedRequests } from "./products/signed-requests.js";

function fundingState(value: NetworkFunding): string {
  if (value.funded === false)
    return "Traffic disabled. Check balance, spending limits and account permissions. Reservation kept until you release it.";
  if (value.funded !== true) return "Funding status unavailable.";
  return value.fundedUntil
    ? `Funded until ${value.fundedUntil}.`
    : "Funding active; no deadline reported.";
}

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };
type Args = { positional: string[]; flags: Map<string, string[]> };

export const NETWORK_PRODUCTS = ["domains", "ports", "ips", "wireguard", "networks"] as const;
export type NetworkProduct = (typeof NETWORK_PRODUCTS)[number];
/** The command each is typed as: WireGuard is inside networks. */
export const NETWORK_COMMAND: Record<NetworkProduct, string> = {
  domains: "domains",
  ports: "ports",
  ips: "ips",
  wireguard: "networks wireguard",
  networks: "networks",
};

export const NETWORK_HELP: Record<NetworkProduct, string> = {
  domains: `runtime domains <command>

  add <hostname> <sandbox> <port>        Serve a sandbox's port at your own hostname, with HTTPS
                                         Prints the DNS records to set: a TXT that proves the
                                         name is yours, and a CNAME (an A for an apex name)
  verify <hostname>                      Check the TXT record now; the name goes live when it matches
  ls                                     Your domains
  get <hostname>                         One domain and its DNS records
  rm <hostname>                          Stop serving it
  Needs a kept top-up. The first visit gets the certificate, in a few seconds.
`,
  ports: `runtime ports <command>

  open <sandbox> <port>                  A public TCP port to a port in the sandbox: Postgres,
                                         Redis, a game server, anything that is not HTTP
                                         Prints address:port for your client
  ls [--sandbox <id>]                    Your open ports
  close <portId>                         Close one, its open connections too
  Needs a kept top-up. TCP, carried as it is: use your service's own password and TLS.
`,
  ips: `runtime ips <command>

  reserve [--ipv6]                       A dedicated outbound address: every sandbox of your
                                         account sends from it, for allow-lists
  ls                                     Your addresses
  release <addressId>                    Give it back; sandboxes use the shared addresses again
  Needs credit on the account.
`,
  wireguard: `runtime networks wireguard <command>

  create [--subnet 10.250.0.0/16]        A WireGuard tunnel from your network into your sandboxes
  get                                    The tunnel, its peers, and each sandbox's address in it
  rm                                     Delete the tunnel and every peer
  peer add <name> [--route 10.0.0.0/16]... [--out runtime.conf] [--public-key <key>]
                                         Add a machine or router of yours; writes its wg-quick
                                         file. The key pair is made here and the private key
                                         never leaves this machine. Then: sudo wg-quick up ./runtime.conf
  peer rotate <peerId> [--out runtime.conf]
                                         A new key; the old one stops working within seconds
  peer rm <peerId>                       Remove it; its tunnel ends within seconds
  --route: your own ranges behind the peer that sandboxes may reach. Needs a kept top-up.
`,
  networks: `runtime networks <command>
  wireguard <command>                    A WireGuard tunnel from your network into your
                                         sandboxes: runtime networks wireguard help

  upstream-proxy set <http://host:port|https://host:port> [--secret NAME] [--host <host>]...
                                         Send your sandboxes' outbound connections through your
                                         own proxy, after Runtime's own rules allow them.
                                         --secret: one of your secrets, sent as Proxy-Authorization
                                         (its hosts must name the proxy's host). --host: only
                                         these destinations (or *.domain) go through it
  upstream-proxy get                     The proxy in use
  upstream-proxy remove                  Connections leave directly again
  A proxy that refuses or cannot be reached fails the connection; nothing goes
  around it. Needs a kept top-up.

  private on                             Your sandboxes reach each other by name, over TCP:
                                         <name>.sandbox.internal:<port> or <id>.sandbox.internal:<port>
  private off                            They stop; open connections between them are cut
  private status                         On or off
  Only your own sandboxes answer. Needs a kept top-up; free.

  signed-requests on                     Your sandboxes can get Runtime's Web Bot Auth signature
                                         for outbound HTTP requests (https://withruntime.com/docs/egress)
  signed-requests off                    New signatures stop at once; given ones expire within 5 minutes
  signed-requests status                 On or off
  Needs credit on the account; free.
`,
};

function usage(product: NetworkProduct, message: string) {
  return new RuntimeError({
    message,
    code: "usage",
    status: 0,
    hint: `Run \`${named("runtime")} ${NETWORK_COMMAND[product]} help\`.`,
  });
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function portNumber(product: NetworkProduct, text: string | undefined): number {
  const value = Number(text);
  if (!text || !/^\d+$/.test(text) || value < 1 || value > 65_535)
    throw usage(product, "Give a port from 1 to 65535.");
  return value;
}

/** A fresh private inode prevents disclosure through permissive files, symlinks
 * and hard links. Rename publishes complete contents without a readable window. */
async function privateOutput(path: string, text: string) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Check and stage before changing a remote peer. If the request or final write
 * fails, this private draft preserves the newly generated key for recovery. */
async function prepareOutput(path: string, privateKey?: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw usage(
        "wireguard",
        "The output must be a regular file, not a directory or symbolic link.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const recovery = await privateOutput(
    path,
    `# DRAFT: request or output incomplete. Keep this file for recovery.\n[Interface]\nPrivateKey = ${privateKey ?? "<your private key>"}\n`,
  );
  return {
    recovery,
    async publish(config: string) {
      const temporary = await privateOutput(path, config);
      try {
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      await unlink(recovery);
    },
  };
}

/** Writes a wg-quick file readable by its owner alone, or prints it. */
async function deliver(
  out: Out,
  config: string | null,
  path: string | undefined,
  hint: string,
  ready = true,
  prepared?: Awaited<ReturnType<typeof prepareOutput>>,
) {
  if (!config) {
    out.error(hint);
    return;
  }
  if (path) {
    if (!prepared) throw new Error("Tunnel output was not prepared.");
    await prepared.publish(config);
    out.error(
      ready
        ? `Wrote ${path}. Bring it up with: sudo wg-quick up ${path.startsWith("/") ? path : `./${path}`}`
        : `Wrote ${path}. ${hint}`,
    );
  } else out.write(config);
}

export async function networkProductCommand(
  product: NetworkProduct,
  argv: string[],
  args: Args,
  out: Out,
  client: () => Promise<Runtime>,
): Promise<number> {
  const [verb] = argv;
  const flag = (name: string) => args.flags.get(name)?.at(-1);
  const has = (name: string) => flag(name) === "true";
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  const rest = args.positional.slice(1);
  const need = (value: string | undefined, what: string) => {
    if (!value) throw usage(product, `Give ${what}.`);
    return value;
  };
  if (!verb || verb === "help" || verb === "--help") {
    print(named(NETWORK_HELP[product]), { usage: named(NETWORK_HELP[product]) });
    return 0;
  }
  const runtime = await client();
  if (product === "domains") {
    const records = (domain: { records: Array<{ type: string; name: string; value: string }> }) =>
      table([
        ["TYPE", "NAME", "VALUE"],
        ...domain.records.map((record) => [record.type, record.name, record.value]),
      ]);
    switch (verb) {
      case "add": {
        const found = await runtime.domains.add({
          hostname: need(rest[0], "a hostname, such as app.example.com"),
          sandboxId: need(rest[1], "a sandbox id"),
          port: portNumber(product, rest[2]),
        });
        print(`${found.hostname}: ${found.state}\n\n${records(found)}\n\n${found.hint}`, found);
        return 0;
      }
      case "verify": {
        const found = await runtime.domains.verify(need(rest[0], "a hostname"));
        print(
          `${found.hostname}: ${found.state}. ${found.hint}${found.checkError ? `\n${found.checkError}` : ""}`,
          found,
        );
        return found.state === "active" ? 0 : 1;
      }
      case "ls":
      case "list": {
        const all = await runtime.domains.list();
        print(
          all.length
            ? table([
                ["HOSTNAME", "STATE", "SERVES", "PORT"],
                ...all.map((d) => [
                  d.hostname,
                  d.disabled ? "taken down" : d.state,
                  d.sandboxId ?? `app ${d.appId ?? ""}`,
                  String(d.port),
                ]),
              ])
            : named("No domains. Add one: runtime domains add app.example.com <sandbox> 3000"),
          all,
        );
        return 0;
      }
      case "get": {
        const found = await runtime.domains.get(need(rest[0], "a hostname"));
        print(`${found.hostname}: ${found.state}\n\n${records(found)}`, found);
        return 0;
      }
      case "rm":
      case "remove": {
        const gone = await runtime.domains.remove(need(rest[0], "a hostname"));
        print(`${gone.hostname} is no longer served. Remove its DNS records too.`, gone);
        return 0;
      }
    }
  }
  if (product === "ports") {
    switch (verb) {
      case "open": {
        const opened = await runtime.ports.open({
          sandboxId: need(rest[0], "a sandbox id"),
          port: portNumber(product, rest[1]),
        });
        if (!out.json) out.error(opened.hint);
        print(opened.connect, opened);
        return 0;
      }
      case "ls":
      case "list": {
        const sandboxId = flag("sandbox");
        const all = await runtime.ports.list(sandboxId ? { sandboxId } : {});
        print(
          all.length
            ? table([
                ["ID", "CONNECT", "SANDBOX", "PORT"],
                ...all.map((p) => [p.id, p.connect, p.sandboxId, String(p.port)]),
              ])
            : named("No open ports. Open one: runtime ports open <sandbox> 5432"),
          all,
        );
        return 0;
      }
      case "close":
      case "rm": {
        const gone = await runtime.ports.close(need(rest[0], "a port id"));
        print(`Closed ${gone.id}.`, gone);
        return 0;
      }
    }
  }
  if (product === "ips") {
    switch (verb) {
      case "reserve": {
        const reserved = await runtime.ips.reserve({ family: has("ipv6") ? 6 : 4 });
        if (!out.json)
          out.error(
            reserved.funded === true
              ? `Every sandbox of this account sends from it. ${fundingState(reserved)}`
              : fundingState(reserved),
          );
        print(reserved.address, reserved);
        return 0;
      }
      case "ls":
      case "list": {
        const all = await runtime.ips.list();
        print(
          all.length
            ? table([
                ["ID", "ADDRESS", "FAMILY", "FUNDING"],
                ...all.map((a) => [a.id, a.address, `IPv${a.family}`, fundingState(a)]),
              ])
            : named("No dedicated address. Reserve one: runtime ips reserve"),
          all,
        );
        return 0;
      }
      case "release":
      case "rm": {
        const gone = await runtime.ips.release(need(rest[0], "an address id"));
        print(`Released ${gone.address}.`, gone);
        return 0;
      }
    }
  }
  if (product === "wireguard") {
    const view = (
      tunnel: NetworkFunding & {
        endpoint: string;
        subnet: string;
        gatewayPublicKey: string | null;
        peers: Array<{ id: string; name: string; address: string; routes: string[] }>;
        sandboxes: Array<{
          sandboxId: string;
          name: string | null;
          address: string;
          state: string;
        }>;
      },
    ) =>
      [
        fundingState(tunnel),
        `Endpoint ${tunnel.endpoint}, subnet ${tunnel.subnet}, gateway key ${tunnel.gatewayPublicKey ?? "(starting)"}`,
        "",
        tunnel.peers.length
          ? table([
              ["PEER", "NAME", "ADDRESS", "ROUTES"],
              ...tunnel.peers.map((p) => [p.id, p.name, p.address, p.routes.join(",") || "-"]),
            ])
          : named(
              "No peers. Add one: runtime networks wireguard peer add office --route 10.0.0.0/16",
            ),
        "",
        tunnel.sandboxes.length
          ? table([
              ["SANDBOX", "NAME", "ADDRESS", "STATE"],
              ...tunnel.sandboxes.map((s) => [s.sandboxId, s.name ?? "-", s.address, s.state]),
            ])
          : "No sandboxes yet.",
      ].join("\n");
    switch (verb) {
      case "create": {
        const made = await runtime.networks.wireguard.create(
          flag("subnet") ? { subnet: flag("subnet")! } : {},
        );
        print(view(made), made);
        return 0;
      }
      case "get":
      case "ls": {
        const found = await runtime.networks.wireguard.get();
        print(view(found), found);
        return 0;
      }
      case "rm":
      case "delete": {
        const gone = await runtime.networks.wireguard.delete();
        print(`Deleted the tunnel ${gone.id}.`, gone);
        return 0;
      }
      case "peer":
      case "peers": {
        const action = rest[0];
        if (action === "add" || action === "rotate") {
          const argument = need(
            rest[1],
            action === "add" ? "the peer's name, such as office" : "a peer id",
          );
          // The pair is made here unless a key is given: the private key never
          // leaves this machine, and goes only into the file written below.
          const given = flag("public-key");
          const pair = given ? undefined : generateWireGuardKeyPair();
          const publicKey = given ?? pair!.publicKey;
          const path = out.json ? undefined : (flag("out") ?? (pair ? "runtime.conf" : undefined));
          const prepared = path ? await prepareOutput(path, pair?.privateKey) : undefined;
          try {
            const answer =
              action === "add"
                ? await runtime.networks.wireguard.addPeer({
                    name: argument,
                    publicKey,
                    routes: args.flags.get("route") ?? [],
                  })
                : await runtime.networks.wireguard.rotatePeer(argument, { publicKey });
            const configReady = answer.configReady ?? !!answer.config;
            const draftHint =
              "Keep this file: it preserves your private key. Read runtime networks wireguard get when the gateway is ready, replace PublicKey in [Peer] with gatewayPublicKey, then run wg-quick up.";
            // Older servers returned no config while the gateway was starting.
            // Preserve the locally generated key in a draft rather than discard it.
            const supplied =
              answer.config ??
              [
                "# DRAFT: gateway key missing. Keep this file; it preserves your private key.",
                "[Interface]",
                `PrivateKey = ${pair?.privateKey ?? "<your private key>"}`,
                `Address = ${answer.peer.address}/32`,
                "",
                "[Peer]",
                `PublicKey = ${answer.tunnel.gatewayPublicKey ?? "<gatewayPublicKey from runtime networks wireguard get>"}`,
                `Endpoint = ${answer.tunnel.endpoint}`,
                `AllowedIPs = ${answer.tunnel.subnet}`,
                "PersistentKeepalive = 25",
                "",
              ].join("\n");
            const privateKeyRow = /^[ \t]*PrivateKey[ \t]*=[^\r\n]*$/gm;
            if (pair && (supplied.match(privateKeyRow)?.length ?? 0) !== 1)
              throw new RuntimeError({
                code: "invalid_response",
                status: 0,
                message:
                  "Runtime returned a tunnel configuration without exactly one private-key field.",
              });
            const config = pair
              ? supplied.replace(privateKeyRow, `PrivateKey = ${pair.privateKey}`)
              : supplied;
            if (out.json) {
              print("", {
                ...answer,
                config,
                configReady,
                ...(!configReady ? { hint: draftHint } : {}),
              });
              return 0;
            }
            if (answer.tunnel.funded === false) out.error(fundingState(answer.tunnel));
            await deliver(
              out,
              config,
              path,
              configReady ? answer.hint : draftHint,
              configReady,
              prepared,
            );
            return 0;
          } catch (error) {
            if (prepared)
              out.error(
                `The peer request or output did not finish. Your private draft is saved at ${prepared.recovery}; keep it for recovery.`,
              );
            throw error;
          }
        }
        if (action === "rm" || action === "remove") {
          const after = await runtime.networks.wireguard.removePeer(need(rest[1], "a peer id"));
          print(`Removed. ${after.peers.length} peer(s) left.`, after);
          return 0;
        }
        throw usage(product, "Use peer add, peer rotate or peer rm.");
      }
    }
  }
  if (product === "networks" && verb === "private") {
    const describe = (state: PrivateNetwork) =>
      state.enabled
        ? "On: your sandboxes reach each other at <name>.sandbox.internal:<port> over TCP."
        : state.allowed
          ? "Off. Turn it on: runtime networks private on"
          : "Off. Reaching your sandboxes by name needs a kept top-up.";
    switch (rest[0]) {
      case "on":
      case "off": {
        const state = await runtime.networks.private.set({ enabled: rest[0] === "on" });
        print(
          state.enabled ? describe(state) : "Off. Open connections between your sandboxes are cut.",
          state,
        );
        return 0;
      }
      case "status":
      case undefined: {
        const state = await runtime.networks.private.get();
        print(describe(state), state);
        return 0;
      }
    }
    throw usage(product, "private takes on, off or status.");
  }
  if (product === "networks" && verb === "signed-requests") {
    const describe = (state: SignedRequests) =>
      state.enabled
        ? "On. Each site's headers: https://withruntime.com/docs/egress"
        : state.allowed
          ? "Off. Turn it on: runtime networks signed-requests on"
          : state.why === "no_credit"
            ? "Needs credit on the account."
            : `Not available (${state.why ?? "unknown"}).`;
    switch (rest[0]) {
      case "on":
      case "off": {
        const state = await runtime.networks.signedRequests.set({ enabled: rest[0] === "on" });
        print(
          state.enabled
            ? describe(state)
            : "Off. New signatures stop at once; ones already given expire within 5 minutes.",
          state,
        );
        return 0;
      }
      case "status":
      case undefined: {
        const state = await runtime.networks.signedRequests.get();
        print(describe(state), state);
        return 0;
      }
    }
    throw usage(product, "signed-requests takes on, off or status.");
  }
  if (product === "networks") {
    if (verb !== "upstream-proxy") throw usage(product, `Unknown networks command ${verb}.`);
    const upstream = runtime.networks.upstreamProxy;
    const describe = (proxy: UpstreamProxy) =>
      [
        `Outbound connections${proxy.hosts?.length ? ` to ${proxy.hosts.join(", ")}` : ""} go through ${proxy.url}.`,
        ...(proxy.secret ? [`${proxy.secret} is sent as Proxy-Authorization.`] : []),
      ].join("\n");
    switch (rest[0]) {
      case "set": {
        const hosts = args.flags.get("host");
        const secret = flag("secret");
        const saved = await upstream.set({
          url: need(rest[1], "the proxy's url, such as http://proxy.example.com:3128"),
          ...(secret ? { secret } : {}),
          ...(hosts ? { hosts } : {}),
        });
        print(
          [
            describe(saved),
            saved.enforced
              ? "A connection your proxy refuses fails; nothing goes around it."
              : "A host is catching up; running sandboxes use it within a minute.",
          ].join("\n"),
          saved,
        );
        return 0;
      }
      case "get":
      case undefined: {
        let found: UpstreamProxy;
        try {
          found = await upstream.get();
        } catch (error) {
          if (!(error instanceof RuntimeError) || error.code !== "not_found") throw error;
          print(
            named(
              "No upstream proxy. Set one: runtime networks upstream-proxy set http://proxy.example.com:3128",
            ),
            null,
          );
          return 0;
        }
        print(describe(found), found);
        return 0;
      }
      case "remove":
      case "rm": {
        const gone = await upstream.remove();
        print("Connections leave directly again.", gone);
        return 0;
      }
    }
    throw usage(product, "upstream-proxy takes set, get or remove.");
  }
  throw usage(product, `Unknown ${NETWORK_COMMAND[product]} command ${verb}.`);
}
