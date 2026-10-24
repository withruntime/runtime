import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { describeRoute, routeFor } from "../src/proxy";
import { RuntimeError } from "../src/errors";

/* Which proxy an address uses, as curl reads the variables. That calls go
   through it, on Node and on Bun, is tests/proxy.e2e.test.ts. */

const HOST = "api.runtime.test";

describe("which proxy an address uses", () => {
  test("lower case wins over upper case, as curl reads them", () => {
    expect(
      routeFor("https://api.withruntime.com", {
        https_proxy: "http://lower:1",
        HTTPS_PROXY: "http://upper:2",
      }),
    ).toEqual({ proxy: "http://lower:1", shown: "http://lower:1", variable: "https_proxy" });
    expect(routeFor("https://api.withruntime.com", { HTTPS_PROXY: "http://upper:2" })).toEqual({
      proxy: "http://upper:2",
      shown: "http://upper:2",
      variable: "HTTPS_PROXY",
    });
  });

  test("HTTP_PROXY is for http:// addresses only, and an HTTPS failure says it was not used", () => {
    expect(routeFor("http://localhost:8080", { HTTP_PROXY: "proxy:3128" })).toMatchObject({
      proxy: "http://proxy:3128",
      variable: "HTTP_PROXY",
    });
    const env = { HTTP_PROXY: "http://proxy:3128" };
    expect(routeFor("https://api.withruntime.com", env)).toEqual({ httpOnly: "HTTP_PROXY" });
    expect(describeRoute("https://api.withruntime.com", new Error("x"), env)).toEqual({
      via: " (directly: no HTTPS proxy is set)",
      hint: "HTTP_PROXY is set but HTTPS_PROXY is not, and api.withruntime.com is HTTPS. Set HTTPS_PROXY to the proxy to use it.",
    });
    expect(routeFor("wss://api.withruntime.com/v1/x", { HTTPS_PROXY: "http://p:1" }).proxy).toBe(
      "http://p:1",
    );
  });

  test("NO_PROXY: a name covers its subdomains, a leading dot, a port, and *", () => {
    const route = (list: string, target = "https://api.withruntime.com") =>
      routeFor(target, { HTTPS_PROXY: "http://p:1", NO_PROXY: list });
    expect(route("withruntime.com").exempt).toBe("withruntime.com");
    expect(route(".withruntime.com").exempt).toBe(".withruntime.com");
    expect(route("API.WithRuntime.com").exempt).toBe("api.withruntime.com");
    expect(route("localhost api.withruntime.com:443").exempt).toBe("api.withruntime.com:443");
    expect(route("*").exempt).toBe("*");
    expect(route("api.withruntime.com:8443").proxy).toBe("http://p:1");
    expect(route("runtime.com").proxy).toBe("http://p:1");
    expect(route("otherwithruntime.com").proxy).toBe("http://p:1");
    expect(route("").proxy).toBe("http://p:1");
    expect(routeFor("https://x.io", { HTTPS_PROXY: "http://p:1", no_proxy: "x.io" })).toEqual({
      exempt: "x.io",
      variable: "no_proxy",
    });
  });

  test("a proxy Runtime cannot speak to is refused by name, not retried", async () => {
    let error: unknown;
    try {
      routeFor("https://api.withruntime.com", { HTTPS_PROXY: "socks5://user:pw@proxy:1080" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("invalid_proxy");
    expect((error as RuntimeError).message).toBe(
      "HTTPS_PROXY (socks5://proxy:1080) is not an HTTP proxy; Runtime connects through http:// and https:// proxies.",
    );
    /* Through a client it fails at once: retrying cannot change a variable.
       In a process of its own, because Bun 1.4 carries a deleted HTTPS_PROXY
       into the next file a --parallel worker runs, and four other files
       then failed on this proxy (26 September 2026). */
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Runtime } = await import(${JSON.stringify(join(import.meta.dir, "../src/index.ts"))});
         const started = performance.now();
         const code = await new Runtime({ apiKey: "rk", baseUrl: "https://${HOST}", maxRetries: 4 })
           .me()
           .then(() => "none", (error) => error.code);
         console.log(JSON.stringify({ code, ms: performance.now() - started }));`,
      ],
      {
        // Only this proxy: the machine's own (a Runtime sandbox sets
        // https_proxy, which wins over HTTPS_PROXY) would hide it.
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !/_proxy$/i.test(name)),
          ),
          HTTPS_PROXY: "socks5://proxy:1080",
        },
        stdout: "pipe",
      },
    );
    const { code, ms } = JSON.parse(await new Response(child.stdout).text()) as {
      code: string;
      ms: number;
    };
    expect(code).toBe("invalid_proxy");
    expect(ms).toBeLessThan(200);
  });
});
