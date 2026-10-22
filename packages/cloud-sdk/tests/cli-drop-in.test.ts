import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dropInLines, run } from "../src/cli";

/* The drop-in adapters were found only on each rival's guide page (customer
   report c465f9ad, 28 September 2026): `switch --from` and `compare --from`
   now print the one import that moves the code. The lines are the guides'
   own, so a guide that changes its import fails here until the CLI follows. */

const GUIDES = join(import.meta.dir, "../../cloud-guide/docs");
const PAGES = {
  e2b: "e2b-alternative.md",
  daytona: "daytona-alternative.md",
  vercel: "vercel-sandbox-alternative.md",
  blaxel: "blaxel-alternative.md",
  modal: "modal-sandbox-alternative.md",
  cloudflare: "cloudflare-sandbox-alternative.md",
} as const;

test("each drop-in's import lines are the ones its guide page shows", () => {
  for (const [provider, page] of Object.entries(PAGES)) {
    const text = readFileSync(join(GUIDES, page), "utf8");
    const [, js, second] = dropInLines(provider as keyof typeof PAGES);
    expect(text).toContain(js!.trim());
    // Cloudflare's SDK runs only in a Worker, so it has no Python line.
    if (provider !== "cloudflare") expect(text).toContain(second!.trim());
    else {
      // More than the import changes; the page and the CLI both say what.
      expect(second).toContain("containers");
      for (const step of [
        'export { Sandbox } from "withruntime/cloudflare"',
        "npx wrangler secret put RUNTIME_API_KEY",
      ])
        expect(text).toContain(step);
    }
  }
});

test("no rival named prints no import", () => {
  expect(dropInLines(undefined)).toEqual([]);
});

test("switch --from blaxel names the import after recording the switch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({
      eligible: true,
      providers: ["e2b", "blaxel"],
      maxMicros: "500000000",
      switch: null,
    })) as typeof fetch;
  let written = "";
  try {
    const code = await run(
      ["switch", "--from", "blaxel"],
      { RUNTIME_API_KEY: "rk", RUNTIME_API_URL: "https://api.example.test" },
      { json: false, write: (text: string) => void (written += `${text}\n`), error: () => {} },
    );
    expect(code).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
  expect(written).toContain("Recorded: switching from Blaxel.");
  expect(written).toContain('from "withruntime/blaxel"; // was: from "@blaxel/core"');
});

test("Fly Machines code moves by its address: the lines are the Fly guide's", () => {
  const text = readFileSync(join(GUIDES, "fly-alternative.md"), "utf8");
  const [intro, ...lines] = dropInLines("fly", "fly-machines");
  expect(intro).toContain("one address changed");
  for (const line of lines) expect(text).toContain(line.trim());
  // "fly" alone may be Sprites, which moves another way.
  expect(dropInLines("fly", "fly")).toEqual([]);
});

test("switch --from fly-machines records Fly and names the address to change", async () => {
  const original = globalThis.fetch;
  let sent: unknown;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") sent = JSON.parse(init.body);
    return Response.json({
      eligible: true,
      providers: ["e2b", "fly"],
      maxMicros: "500000000",
      switch: null,
    });
  }) as typeof fetch;
  let written = "";
  try {
    const code = await run(
      ["switch", "--from", "fly-machines"],
      { RUNTIME_API_KEY: "rk", RUNTIME_API_URL: "https://api.example.test" },
      { json: false, write: (text: string) => void (written += `${text}\n`), error: () => {} },
    );
    expect(code).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
  expect(sent).toEqual({ provider: "fly" });
  expect(written).toContain("Recorded: switching from Fly.");
  expect(written).toContain("npx withruntime fly-api");
});
