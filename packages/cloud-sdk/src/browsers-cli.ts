import { writeFileSync } from "node:fs";
import { me, named } from "./cli-name.js";
import type { CliKit } from "./cli.js";
import type { Runtime } from "./client.js";
import { browsers, type CreateBrowser } from "./products/browsers.js";
import { desktops, type CreateDesktop } from "./products/desktops.js";

type Out = { json: boolean; write: (text: string) => void; error: (text: string) => void };

export const BROWSER_HELP = `runtime browsers <command>

  A browser is Chromium on its own sandbox, billed at the sandbox rates, with a
  private CDP address for Playwright, Puppeteer, browser-use or Stagehand.
  In a private beta: outside it, each command says how to ask to join.

  create [--memory <1024-16384>] [--vcpu <1-16>] [--visible] [--width <px>] [--height <px>]
         [--timeout <seconds>] [--name <name>] [--label key=value]...
                                              Start one; prints its id, then its cdpUrl
  ls                                          Your browsers
  get <browser>                               One browser, with a fresh cdpUrl (an id or its name)
  screenshot <browser> [<url>] [--out <file.png>] [--full] [--jpeg] [--wait <ms>]
                                              Open url in a new tab and save its screenshot
                                              (without url: what it shows now)
  rm <browser>                                Delete it and its sandbox

Examples
  runtime browsers create --name scraper
  runtime browsers screenshot scraper https://withruntime.com --out home.png
  runtime browsers rm scraper
`;

export const DESKTOP_HELP = `runtime desktops <command>

  A desktop is a Linux desktop on its own sandbox, billed at the sandbox rates,
  with a private live view and computer use: screenshot, click, type, open.
  In a private beta: outside it, each command says how to ask to join.

  create [--memory <1024-16384>] [--vcpu <1-16>] [--width <px>] [--height <px>]
         [--timeout <seconds>] [--name <name>] [--label key=value]...
                                              Start one; prints its id, then its live view
  ls                                          Your desktops
  get <desktop>                               One desktop, with a fresh live view (an id or its name)
  screenshot <desktop> [--out <file.png>]     Save its screen
  open <desktop> <url>                        Open url in its Chromium
  rm <desktop>                                Delete it and its sandbox

Examples
  runtime desktops create --name qa
  runtime desktops open qa https://withruntime.com
  runtime desktops screenshot qa --out screen.png
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `runtime browsers` and `runtime desktops`: the five verbs, a screenshot
 * saved to a file, and a desktop's open. */
export async function machineProductCommand(
  which: "browsers" | "desktops",
  argv: string[],
  out: Out,
  client: () => Promise<Runtime>,
  kit: CliKit,
): Promise<number> {
  const { parse, flag, has, integer, need, pairs, table, usage } = kit;
  const noun = which === "browsers" ? "browser" : "desktop";
  const help = which === "browsers" ? BROWSER_HELP : DESKTOP_HELP;
  const [verb, ...rest] = argv;
  const print = (human: string, value: unknown) =>
    out.write(out.json ? JSON.stringify(value) : human);
  if (!verb || verb === "help" || verb === "--help") {
    print(named(help), { usage: named(help) });
    return 0;
  }
  const transport = (await client()).transport;
  const api = which === "browsers" ? browsers(transport) : desktops(transport);
  const idOf = async (target: string | undefined) => {
    const given = need(target, `a ${noun}'s id or name`);
    if (UUID.test(given)) return given;
    const found = (await api.list({ name: given })).data;
    if (found.length === 1) return found[0]!.id;
    throw usage(
      found.length
        ? `${found.length} ${which} are named ${given}; give one's id (${me} ${which} ls).`
        : `No ${noun} is named ${given}. Your ${which}: ${me} ${which} ls`,
    );
  };
  const save = (file: string, bytes: Uint8Array, value: Record<string, unknown>) => {
    writeFileSync(file, bytes);
    print(`Saved ${file} (${bytes.length} bytes).`, { ...value, file, base64: undefined });
  };
  switch (verb) {
    case "create": {
      const args = parse(
        rest,
        ["visible"],
        ["memory", "vcpu", "width", "height", "timeout", "name", "label"],
      );
      const input: CreateBrowser & CreateDesktop = {
        ...(integer(args, "memory") === undefined ? {} : { memoryMiB: integer(args, "memory")! }),
        ...(integer(args, "vcpu") === undefined ? {} : { vcpu: integer(args, "vcpu")! }),
        ...(integer(args, "width") === undefined ? {} : { width: integer(args, "width")! }),
        ...(integer(args, "height") === undefined ? {} : { height: integer(args, "height")! }),
        ...(integer(args, "timeout") === undefined
          ? {}
          : { timeoutSeconds: integer(args, "timeout")! }),
        ...(flag(args, "name") === undefined ? {} : { name: flag(args, "name")! }),
        ...(args.flags.has("label") ? { labels: pairs(args, "label") } : {}),
        ...(which === "browsers" && has(args, "visible") ? { headless: false } : {}),
      };
      const made = (await api.create(input)) as unknown as Record<string, unknown>;
      const reach = which === "browsers" ? made.cdpUrl : made.liveViewUrl;
      print(`${String(made.id)}\n${typeof reach === "string" ? reach : ""}`, made);
      return 0;
    }
    case "ls":
    case "list": {
      const all = (await (await api.list({ limit: 100 })).toArray(Infinity)) as unknown as Record<
        string,
        unknown
      >[];
      print(
        all.length
          ? table([
              ["ID", "NAME", "STATE", "SIZE", "SANDBOX"],
              ...all.map((item) => [
                String(item.id),
                typeof item.name === "string" ? item.name : "-",
                String(item.state),
                `${String(item.vcpu)} vCPU, ${String(item.memoryMiB)} MiB`,
                String(item.sandboxId),
              ]),
            ])
          : `No ${which}. Start one: ${me} ${which} create`,
        all,
      );
      return 0;
    }
    case "get": {
      const found = await api.get(await idOf(rest[0]));
      print(JSON.stringify(found, null, 2), found);
      return 0;
    }
    case "screenshot":
    case "shot": {
      const args = parse(rest, ["full", "jpeg"], ["out", "wait"]);
      const id = await idOf(args.positional[0]);
      const jpeg = has(args, "jpeg");
      const file = flag(args, "out") ?? `${noun}-${id.slice(0, 8)}.${jpeg ? "jpg" : "png"}`;
      if (which === "desktops") {
        const bytes = await desktops(transport).screenshot(id, jpeg ? { format: "jpeg" } : {});
        save(file, bytes, { id });
        return 0;
      }
      const url = args.positional[1];
      const shot = await browsers(transport).screenshot(id, {
        ...(url ? { url } : {}),
        ...(has(args, "full") ? { fullPage: true } : {}),
        ...(jpeg ? { format: "jpeg" as const } : {}),
        ...(integer(args, "wait") === undefined ? {} : { waitMs: integer(args, "wait")! }),
      });
      if (!out.json) out.error(`${shot.url} (${shot.status ?? "-"}): ${shot.title}`);
      save(file, Buffer.from(shot.base64, "base64"), shot);
      return 0;
    }
    case "open": {
      if (which !== "desktops") break;
      const id = await idOf(rest[0]);
      const url = need(rest[1], "a URL to open");
      const done = await desktops(transport).act(id, { action: "open", url });
      print(`Opened ${url}.`, done);
      return 0;
    }
    case "rm":
    case "delete": {
      const gone = await api.delete(await idOf(rest[0]));
      print(`${String(rest[0])} deleted.`, gone ?? { deleted: true });
      return 0;
    }
  }
  throw kit.unknown(
    `${which} command`,
    verb,
    which === "browsers"
      ? ["create", "ls", "get", "screenshot", "rm"]
      : ["create", "ls", "get", "screenshot", "open", "rm"],
  );
}
