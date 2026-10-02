import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { apiOrigin, missingKey } from "./transport.js";

export type SavedConnection = {
  version: 1;
  apiOrigin: string;
  authOrigin: string;
  key: string;
  connectionId: string;
  orgId: string;
  agentName: string;
  /** The account's name when it was saved, for `runtime account`. */
  orgName?: string;
};
/** How many other accounts' connections one machine keeps beside the one in use. */
const SAVED_ACCOUNTS = 20;
export function connectionOrigins(env: NodeJS.ProcessEnv) {
  return {
    api: apiOrigin(env.RUNTIME_API_URL ?? "https://api.withruntime.com"),
    auth: apiOrigin(env.RUNTIME_AUTH_URL ?? "https://withruntime.com"),
  };
}
/** Browser-issued production credentials must only reach the production API.
 * CLI and MCP share this boundary, including resumed device requests. */
export function checkBrowserOrigins(origins: ReturnType<typeof connectionOrigins>) {
  const local = (origin: string) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  if (!(
    (origins.auth === "https://withruntime.com" && origins.api === "https://api.withruntime.com") ||
    (local(origins.auth) && local(origins.api))
  ))
    throw new Error(
      "Browser login supports Runtime's production endpoints or local test endpoints. Check RUNTIME_AUTH_URL and RUNTIME_API_URL.",
    );
}
function defaultDirectory(env: NodeJS.ProcessEnv) {
  const root = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (!isAbsolute(root)) throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  return join(root, "runtime-cloud");
}
/** Private user storage, outside project files. Nothing reading this module
 * returns a secret to CLI output. Store names bind credentials to both origins. */
export function connectionStore(env: NodeJS.ProcessEnv, directory = defaultDirectory(env)) {
  const origins = connectionOrigins(env);
  const name = createHash("sha256").update(`${origins.auth}\n${origins.api}`).digest("hex");
  const file = join(directory, `${name}.json`);
  async function privateDirectory(create: boolean) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      )
        throw new Error("Runtime's credential directory must be private to your user.");
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    return true;
  }
  /** One private file in the private directory: its text, or null. */
  async function readPrivate(path: string, limit: number, label: string) {
    if (!(await privateDirectory(false))) return null;
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Could not safely open Runtime's ${label}.`);
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > limit ||
        (process.platform !== "win32" &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      )
        throw new Error(`Runtime's ${label} must be private to your user.`);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }
  async function writePrivate(path: string, text: string) {
    await privateDirectory(true);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  async function removePrivate(path: string) {
    if (await privateDirectory(false))
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
  const lockFile = join(directory, `${name}.lock`);
  /** ARCHITECTURE.md section 3.9: concurrent CLI processes keep each account's
   * connection. Serialize the entire read/modify/write, not only each rename.
   * Never steal a lock: stale cleanup can otherwise delete a new live lock. */
  async function updateAccounts<T>(update: () => Promise<T>): Promise<T> {
    await privateDirectory(true);
    const until = performance.now() + 10_000;
    let handle;
    for (;;) {
      try {
        handle = await open(lockFile, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const text = await readPrivate(lockFile, 1024, "credential update lock");
      let pid: unknown;
      try {
        pid = (JSON.parse(text ?? "null") as { pid?: unknown } | null)?.pid;
      } catch {
        // The holder may not have finished writing its process id yet.
      }
      if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            throw new Error(
              `A previous Runtime credential update was interrupted. Remove ${lockFile} and retry.`,
            );
        }
      }
      if (performance.now() >= until)
        throw new Error(
          `Another Runtime command is updating saved accounts. Retry when it finishes. If no command is running, remove ${lockFile} and retry.`,
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return await update();
    } finally {
      try {
        await handle.close();
      } finally {
        await unlink(lockFile);
      }
    }
  }
  const pendingFile = join(directory, `${name}.pending.json`);
  const accountsFile = join(directory, `${name}.accounts.json`);
  /** Active and archived connections must satisfy the same contract: switching
   * accounts cannot publish a credential the next command refuses to read. */
  function validConnection(value: unknown): value is SavedConnection {
    if (value === null || typeof value !== "object") return false;
    const saved = value as Partial<SavedConnection>;
    return (
      saved.version === 1 &&
      saved.apiOrigin === origins.api &&
      saved.authOrigin === origins.auth &&
      typeof saved.key === "string" &&
      /^rtcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/.test(saved.key) &&
      typeof saved.connectionId === "string" &&
      typeof saved.orgId === "string" &&
      typeof saved.agentName === "string" &&
      (saved.orgName === undefined || typeof saved.orgName === "string")
    );
  }
  return {
    async read(): Promise<SavedConnection | null> {
      const text = await readPrivate(file, 4096, "saved connection");
      if (text === null) return null;
      let saved: unknown;
      try {
        saved = JSON.parse(text) as unknown;
      } catch {
        throw new Error("Runtime's saved connection is invalid. Connect again.");
      }
      if (!validConnection(saved))
        throw new Error("Runtime's saved connection is invalid. Connect again.");
      return saved;
    },
    /** Save the connection in use. One for another account moves to the
     * saved accounts, so connecting a second account never loses the first
     * (ARCHITECTURE.md section 3.9); one for the same account is replaced. */
    async save(connection: SavedConnection) {
      if (connection.apiOrigin !== origins.api || connection.authOrigin !== origins.auth)
        throw new Error("Connection origins do not match.");
      return updateAccounts(async () => {
        const previous = await this.read().catch(() => null);
        if (previous && previous.orgId !== connection.orgId) {
          const others = (await this.others()).filter(
            (one) => one.orgId !== previous.orgId && one.orgId !== connection.orgId,
          );
          await writePrivate(
            accountsFile,
            JSON.stringify([previous, ...others].slice(0, SAVED_ACCOUNTS)),
          );
        }
        await writePrivate(file, JSON.stringify(connection));
      });
    },
    /** The other accounts this machine has connected, newest first. */
    async others(): Promise<SavedConnection[]> {
      let text: string | null;
      try {
        text = await readPrivate(accountsFile, 64 * 1024, "saved accounts");
      } catch {
        return [];
      }
      if (text === null) return [];
      try {
        const list: unknown = JSON.parse(text);
        return Array.isArray(list) ? list.filter(validConnection) : [];
      } catch {
        return [];
      }
    },
    /** Use another saved account's connection, by account id or name. The one
     * in use moves to the saved accounts. Null when none matches. */
    async use(which: string): Promise<SavedConnection | null> {
      return updateAccounts(async () => {
        const others = await this.others();
        const wanted = which.trim().toLowerCase();
        const chosen =
          others.find((one) => one.orgId === which) ??
          others.find((one) => one.orgName?.toLowerCase() === wanted) ??
          null;
        if (!chosen) return null;
        const current = await this.read().catch(() => null);
        const rest = others.filter((one) => one.orgId !== chosen.orgId);
        await writePrivate(
          accountsFile,
          JSON.stringify((current ? [current, ...rest] : rest).slice(0, SAVED_ACCOUNTS)),
        );
        await writePrivate(file, JSON.stringify(chosen));
        return chosen;
      });
    },
    /** Forget the expected credential after a remote revoke or refusal. A
     * concurrent login may have saved another connection during that request. */
    async remove(expectedKey?: string) {
      await updateAccounts(async () => {
        if (expectedKey !== undefined && (await this.read())?.key !== expectedKey) return;
        await removePrivate(file);
      });
    },
    /** A browser approval that was started and not yet answered, so a command
     * that was stopped while it waited picks up the same link and code rather
     * than asking the person to approve a new one. Unreadable or stale ones
     * read as none. */
    async readPending(): Promise<PendingConnection | null> {
      let text: string | null;
      try {
        text = await readPrivate(pendingFile, 8192, "pending connection");
      } catch {
        return null;
      }
      if (text === null) return null;
      try {
        const pending = JSON.parse(text) as PendingConnection;
        if (
          pending.version !== 1 ||
          pending.apiOrigin !== origins.api ||
          pending.authOrigin !== origins.auth ||
          typeof pending.privateKey !== "string" ||
          typeof pending.deviceCode !== "string" ||
          typeof pending.url !== "string" ||
          typeof pending.userCode !== "string" ||
          typeof pending.agentName !== "string" ||
          typeof pending.expiresAt !== "number" ||
          pending.expiresAt <= Date.now()
        )
          return null;
        return pending;
      } catch {
        return null;
      }
    },
    async savePending(pending: PendingConnection) {
      await writePrivate(pendingFile, JSON.stringify(pending));
    },
    async removePending() {
      await removePrivate(pendingFile);
    },
  };
}
/** What `readPending` keeps: the private half of the key pair the approved
 * key is encrypted to, and the request it answers. */
export type PendingConnection = {
  version: 1;
  apiOrigin: string;
  authOrigin: string;
  privateKey: string;
  deviceCode: string;
  url: string;
  userCode: string;
  agentName: string;
  expiresAt: number;
};
export async function resolveCredential(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.RUNTIME_API_KEY) {
    if (/\s/.test(env.RUNTIME_API_KEY)) throw new Error("RUNTIME_API_KEY is invalid.");
    return env.RUNTIME_API_KEY;
  }
  const saved = await connectionStore(env).read();
  if (!saved) throw notConnected();
  return saved.key;
}

/** No key in the environment and none saved on this machine. */
export const notConnected = missingKey;
