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
  const pendingFile = join(directory, `${name}.pending.json`);
  const accountsFile = join(directory, `${name}.accounts.json`);
  return {
    async read(): Promise<SavedConnection | null> {
      const text = await readPrivate(file, 4096, "saved connection");
      if (text === null) return null;
      let saved: SavedConnection;
      try {
        saved = JSON.parse(text) as SavedConnection;
      } catch {
        throw new Error("Runtime's saved connection is invalid. Connect again.");
      }
      if (
        saved.version !== 1 ||
        saved.apiOrigin !== origins.api ||
        saved.authOrigin !== origins.auth ||
        typeof saved.key !== "string" ||
        !/^rtcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/.test(saved.key) ||
        typeof saved.connectionId !== "string" ||
        typeof saved.orgId !== "string" ||
        typeof saved.agentName !== "string" ||
        (saved.orgName !== undefined && typeof saved.orgName !== "string")
      )
        throw new Error("Runtime's saved connection is invalid. Connect again.");
      return saved;
    },
    /** Save the connection in use. One for another account moves to the
     * saved accounts, so connecting a second account never loses the first
     * (ARCHITECTURE.md section 3.9); one for the same account is replaced. */
    async save(connection: SavedConnection) {
      if (connection.apiOrigin !== origins.api || connection.authOrigin !== origins.auth)
        throw new Error("Connection origins do not match.");
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
        const list = JSON.parse(text) as SavedConnection[];
        return Array.isArray(list)
          ? list.filter(
              (one) =>
                one &&
                one.version === 1 &&
                one.apiOrigin === origins.api &&
                one.authOrigin === origins.auth &&
                typeof one.key === "string" &&
                /^rtcloud_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/.test(one.key) &&
                typeof one.orgId === "string",
            )
          : [];
      } catch {
        return [];
      }
    },
    /** Use another saved account's connection, by account id or name. The one
     * in use moves to the saved accounts. Null when none matches. */
    async use(which: string): Promise<SavedConnection | null> {
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
    },
    async remove() {
      await removePrivate(file);
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
