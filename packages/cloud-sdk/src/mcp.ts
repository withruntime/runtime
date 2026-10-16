import process from "node:process";
import {
  checkBrowserOrigins,
  connectionOrigins,
  resolveCredential,
  saveWalletConnection,
} from "./credentials.js";
import { RuntimeError } from "./errors.js";
import { beginDeviceLogin, type PendingLogin } from "./login.js";
import { envFetch } from "./proxy.js";
import { apiOrigin, defaultBaseUrl, VERSION } from "./transport.js";
import type { OpenedWalletAccount, WalletClaim } from "./wallet.js";

const CONNECT_INSTRUCTIONS =
  "Runtime is not connected on this machine yet. Call runtime_connect: it gives you a link and a code for the person you work for to approve in their browser (no key to copy). Once they have, call runtime_connect again; Runtime's tools then appear (sandboxes, commands, files and the rest). No person to approve? Open an account paid in USDC: runtime_wallet_open gives an address and the exact amount to send, and runtime_wallet_claim connects once the payment lands (in a shell, `npx withruntime billing topup 20 --new-account --accept-terms --wait` does the same; then call runtime_connect). There is no free trial on that path.";
const connectTool = {
  name: "runtime_connect",
  title: "Connect this machine to Runtime",
  description:
    "Connect Runtime on this machine with a browser approval. The first call returns a link and a code: show them to the person you work for and ask them to approve. Call again after they have; it waits up to 45 seconds for the approval, then Runtime's tools appear.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const walletOpenTool = {
  name: "runtime_wallet_open",
  title: "Open a Runtime account paid with a wallet",
  description:
    "For an agent with no person to approve a browser login: opens a Runtime account and its first top-up, paid in USDC on Base, Solana or Tempo. No free trial: the account gets its key only once the payment lands. Answers with an address per network, the exact amount to send and a claim code, shown once: keep it secret, it is the only way to the account. Send exactly that amount from any wallet, then call runtime_wallet_claim with the claim code. Opening an account means agreeing to https://withruntime.com/legal/terms for whoever you act for.",
  inputSchema: {
    type: "object",
    properties: {
      usd: {
        type: "number",
        description: "Dollars of credit to buy: $10 to $500 in an account's first week.",
      },
      acceptTerms: {
        type: "boolean",
        description: "true agrees to https://withruntime.com/legal/terms. Required.",
      },
    },
    required: ["usd", "acceptTerms"],
    additionalProperties: false,
  },
};
const walletClaimTool = {
  name: "runtime_wallet_claim",
  title: "Connect to a Runtime account opened with a wallet",
  description:
    "Once a runtime_wallet_open top-up is paid, saves the account's key on this machine (not shown) and connects; Runtime's tools then appear. Until the payment lands it waits up to 45 seconds and says the top-up's status: call it again.",
  inputSchema: {
    type: "object",
    properties: {
      claimCode: { type: "string", description: "The claim code runtime_wallet_open gave." },
    },
    required: ["claimCode"],
    additionalProperties: false,
  },
};

/** Where to send a wallet account's first top-up, for an agent to act on. */
function describeOpened(opened: OpenedWalletAccount): string {
  const lines = [
    `Opened a Runtime account. Send exactly ${opened.amount} USDC (for $${opened.amountUsd} of credit), on one of these networks:`,
    "",
  ];
  for (const network of opened.networks)
    for (const token of network.tokens)
      lines.push(
        `- ${network.network}: ${token.currency.toUpperCase()} to ${network.address} (token contract ${token.contract})`,
      );
  lines.push(
    "",
    ...(opened.payBy ? [`Send before ${opened.payBy}.`] : []),
    "A different amount, token or network cannot be matched or returned automatically.",
    "",
    `Claim code (shown once, keep it secret): ${opened.claimCode}`,
    "Once sent, call runtime_wallet_claim with this claim code: it connects when the payment lands, a few minutes after the transfer.",
    "A person can take the account over at https://withruntime.com/account/claim with the same code.",
  );
  return lines.join("\n");
}

/** Bridges an MCP client that speaks stdio to Runtime's hosted MCP endpoint.
 * Newline-delimited JSON-RPC in, the same out; every message is forwarded as
 * it is, so the server's tools, schemas and `instructions` reach the client
 * unchanged, and nothing here keeps a second catalogue. The one change: the
 * initialize answer's serverInfo.version is this package's. Starting it costs a
 * process and one TLS connection (undici loads only behind a proxy).
 *
 * With no key on this machine it does not fail: it serves one tool,
 * runtime_connect, that walks the agent and its person through the browser
 * approval, then connects to Runtime and tells the client its tools changed.
 * So `claude mcp add runtime -- npx -y withruntime mcp` is the whole
 * setup. */
export async function serveMcp(
  env: NodeJS.ProcessEnv = process.env,
  options: { openBrowser?: (url: string) => Promise<void>; fetch?: typeof fetch } = {},
): Promise<void> {
  const fetcher = options.fetch ?? envFetch;
  let key: string | undefined;
  try {
    key = await resolveCredential(env);
  } catch (error) {
    if (!(error instanceof RuntimeError && error.code === "missing_api_key")) throw error;
  }
  const origin = apiOrigin(defaultBaseUrl(env));
  const endpoint = new URL("/mcp", origin).href;
  let protocolVersion: string | undefined;
  let session: string | undefined;
  let initialize: Record<string, unknown> | undefined;
  let pending: PendingLogin | undefined;
  const inFlight = new Set<Promise<void>>();

  const write = (message: unknown) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const failure = (id: unknown, message: string, data?: unknown) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32000, message, ...(data === undefined ? {} : { data }) },
  });

  /** One message to the hosted endpoint, and the messages it answered. */
  async function post(
    body: string,
  ): Promise<{ status: number; messages: unknown[]; text: string }> {
    const response = await fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-runtime-client": `mcp-bridge/${VERSION}`,
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body,
      signal: AbortSignal.timeout(600_000),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    const messages: unknown[] = [];
    if (response.ok && response.status !== 202 && response.status !== 204) {
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        for (const block of text.split(/\n\n/))
          for (const data of block.split("\n").filter((l) => l.startsWith("data:")))
            messages.push(JSON.parse(data.slice(5).trim()) as unknown);
      } else if (text.trim()) messages.push(JSON.parse(text) as unknown);
    }
    for (const reply of messages) {
      const result = (
        reply as { result?: { protocolVersion?: string; serverInfo?: { version?: string } } }
      ).result;
      if (result?.protocolVersion) protocolVersion = result.protocolVersion;
      // The client runs this package: it reports the package's version, as
      // before connecting, not the hosted API's contract version (0.2.0).
      if (result?.serverInfo) result.serverInfo.version = VERSION;
    }
    return { status: response.status, messages, text };
  }

  async function forward(line: string, id: unknown, isRequest: boolean) {
    let answer: Awaited<ReturnType<typeof post>>;
    try {
      answer = await post(line);
    } catch {
      if (isRequest)
        write(failure(id, "Runtime could not be reached. Check the network and retry."));
      return;
    }
    if (answer.status >= 400) {
      let detail: unknown;
      try {
        detail = (JSON.parse(answer.text) as { error?: unknown }).error;
      } catch {
        detail = answer.text.slice(0, 500);
      }
      const hint =
        answer.status === 401
          ? "The key was refused. Run `npx -y withruntime login` again, or set RUNTIME_API_KEY."
          : `Runtime answered ${answer.status}.`;
      if (isRequest) write(failure(id, hint, detail));
      return;
    }
    for (const reply of answer.messages) write(reply);
  }

  /** The website's wallet sign-up, at the same origins a login would use. */
  function wallet() {
    const origins = connectionOrigins(env);
    checkBrowserOrigins(origins);
    const walletOptions = {
      authUrl: origins.auth,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    return {
      open: async (input: { usd: number; acceptTerms: boolean }) =>
        (await import("./wallet.js")).openWalletAccount(input, walletOptions),
      claim: async (code: string) =>
        (await import("./wallet.js")).claimWalletAccount(code, walletOptions),
    };
  }

  /** A wallet account's claim: once paid, saves its key and connects. Waits up
   * to 45 seconds for a payment on its way, as runtime_connect does. */
  async function claimWallet(code: string): Promise<[string, boolean?]> {
    const until = Date.now() + 45_000;
    for (;;) {
      const claim: WalletClaim = await wallet().claim(code);
      if (claim.status === "paid") {
        // The website issues the key once: a save that fails must not lose it.
        let unsaved: string | undefined;
        try {
          await saveWalletConnection(env, claim.apiKey, claim.orgId);
        } catch (error) {
          unsaved = (error as Error).message;
        }
        const said = await connected(claim.apiKey, "a wallet account");
        return [
          unsaved === undefined
            ? said
            : `${said}\nThe key could not be saved (${unsaved}), and it is issued only once: keep it secret and safe now, as RUNTIME_API_KEY: ${claim.apiKey}`,
        ];
      }
      if (claim.status === "expired" || claim.status === "failed")
        return [
          `The top-up ${claim.status}: nothing was credited. Open a new one with runtime_wallet_open.`,
          true,
        ];
      // A top-up that never reached Stripe has no address: waiting cannot help.
      if (claim.topup?.status === "open" && !claim.topup.networks.length)
        return [claim.next ?? "This top-up has no address to pay to yet.", true];
      if (Date.now() + 10_000 > until)
        return [
          claim.status === "pending"
            ? "The payment has arrived and is being confirmed. Call runtime_wallet_claim again in a minute."
            : "Not paid yet. Once the transfer has gone through, call runtime_wallet_claim again with the same claim code.",
        ];
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }

  /** Starts forwarding with this key and tells the client its tools changed. */
  async function connected(found: string, agentName?: string) {
    key = found;
    pending = undefined;
    await post(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "runtime-connect",
        method: "initialize",
        params: initialize ?? {},
      }),
    );
    await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    return `Connected${agentName ? ` as ${agentName}` : ""}. Runtime's tools are available now: list the tools again, then start with runtime_sandboxes_create.`;
  }

  /** Not connected yet: answer the client here, with the tools that connect. */
  async function connectMode(message: Record<string, unknown>, id: unknown) {
    const method = message.method;
    const reply = (result: unknown) => write({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      initialize = (message.params as Record<string, unknown> | undefined) ?? {};
      return reply({
        protocolVersion: (initialize.protocolVersion as string | undefined) ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "runtime-cloud", version: VERSION },
        instructions: CONNECT_INSTRUCTIONS,
      });
    }
    if (typeof method === "string" && method.startsWith("notifications/")) return;
    if (method === "ping") return reply({});
    if (method === "tools/list")
      return reply({ tools: [connectTool, walletOpenTool, walletClaimTool] });
    const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (
      method !== "tools/call" ||
      !["runtime_connect", "runtime_wallet_open", "runtime_wallet_claim"].includes(
        params.name as string,
      )
    )
      return write(failure(id, "Runtime is not connected yet: call runtime_connect first."));
    const text = (words: string, isError = false) =>
      reply({ content: [{ type: "text", text: words }], ...(isError ? { isError } : {}) });
    if (params.name !== "runtime_connect") {
      const input = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        if (params.name === "runtime_wallet_open") {
          if (input.acceptTerms !== true)
            return text(
              "Opening an account means agreeing to https://withruntime.com/legal/terms. Call again with acceptTerms: true to agree to them for whoever you act for.",
              true,
            );
          if (typeof input.usd !== "number" || !(input.usd > 0))
            return text("Say how many dollars of credit to buy in usd, such as 20.", true);
          return text(describeOpened(await wallet().open({ usd: input.usd, acceptTerms: true })));
        }
        if (typeof input.claimCode !== "string" || !input.claimCode.trim())
          return text("Give the claimCode runtime_wallet_open answered.", true);
        return text(...(await claimWallet(input.claimCode.trim())));
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    }
    try {
      // A key saved since this server started (a wallet account's claim, a
      // login in a shell) connects without a browser.
      const saved = await resolveCredential(env).catch(() => undefined);
      if (saved) return text(await connected(saved));
      if (!pending) {
        pending = await beginDeviceLogin(env, env.RUNTIME_AGENT_NAME ?? "MCP agent", {
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        if (!env.RUNTIME_NO_BROWSER && !pending.resumed)
          await (options.openBrowser ?? openBrowser)(pending.url).catch(() => undefined);
        return text(
          `Ask the person you work for to open ${pending.url} (it may already be open in their browser), sign in to Runtime, check that it shows the code ${pending.userCode}, and choose Connect agent. Then call runtime_connect again. No person to approve? See this server's instructions to open an account paid in USDC.`,
        );
      }
      const until = Math.min(pending.expiresAt, Date.now() + 45_000);
      while (Date.now() < until) {
        const outcome = await pending.check();
        if (outcome === "expired") break;
        if (outcome !== "pending")
          return text(await connected(await resolveCredential(env), outcome.agentName));
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (Date.now() >= pending.expiresAt) {
        pending = undefined;
        return text("The link expired before it was approved. Call runtime_connect for a new one.");
      }
      return text(
        `Not approved yet. The person you work for should open ${pending.url} and choose Connect agent; then call runtime_connect again.`,
      );
    } catch (error) {
      pending = undefined;
      return write(
        failure(
          id,
          error instanceof Error
            ? error.message
            : "The connection failed. Call runtime_connect again.",
        ),
      );
    }
  }

  async function handle(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const first: unknown = Array.isArray(message) ? (message as unknown[])[0] : message;
    const id = (first as { id?: unknown } | undefined)?.id;
    const isRequest = id !== undefined && (first as { method?: unknown }).method !== undefined;
    if (key === undefined && first && typeof first === "object")
      return connectMode(first as Record<string, unknown>, id);
    return forward(line, id, isRequest);
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const task = handle(line).finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
        newline = buffer.indexOf("\n");
      }
    });
    const finish = () => void Promise.allSettled([...inFlight]).then(() => resolve());
    /* A signal ends the bridge at once: stop reading, give a reply already on
       its way half a second to be written, and return. The client that sent
       it has stopped listening; waiting on a long tool call, or on stdin it
       left open, only makes it wait for us or kill us. */
    const stop = () => {
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
      process.stdin.destroy();
      void Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((settle) => setTimeout(settle, 500)),
      ]).then(() => resolve());
    };
    process.stdin.once("end", finish);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function openBrowser(url: string) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await promisify(execFile)(command, args, { timeout: 10_000 });
}
