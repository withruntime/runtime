import { resolvePath, type SandboxContext } from "./context.js";
import {
  DaytonaError,
  DaytonaGitAuthFailedError,
  DaytonaGitBranchExistsError,
  DaytonaGitBranchNotFoundError,
  DaytonaGitMergeConflictError,
  DaytonaGitPushRejectedError,
  DaytonaGitRepoNotFoundError,
  guard,
} from "./errors.js";

export interface GitStatus {
  currentBranch: string;
  ahead?: number;
  behind?: number;
  branchPublished?: boolean;
  fileStatus: { name: string; staging: string; worktree: string; extra: string }[];
}
export interface ListBranchResponse {
  branches: string[];
}

/** Credentials reach git through a helper reading the environment, never the
 * command line or the remote URL. */
const HELPER =
  'credential.helper=!f() { echo "username=$GIT_USER"; echo "password=$GIT_PASS"; }; f';

function failure(stderr: string, fallback: string): DaytonaError {
  const message = stderr.trim() || fallback;
  if (/Authentication failed|could not read Username|403/.test(message))
    return new DaytonaGitAuthFailedError(message, 401);
  if (/Repository not found|not found|does not appear to be a git repository/i.test(message))
    return new DaytonaGitRepoNotFoundError(message, 404);
  if (/already exists/.test(message)) return new DaytonaGitBranchExistsError(message, 409);
  if (/did not match any|not a valid|unknown revision|branch .* not found/i.test(message))
    return new DaytonaGitBranchNotFoundError(message, 404);
  if (/rejected|non-fast-forward/.test(message))
    return new DaytonaGitPushRejectedError(message, 409);
  if (/CONFLICT|Merge conflict/.test(message))
    return new DaytonaGitMergeConflictError(message, 409);
  return new DaytonaError(message, 400);
}

/** `sandbox.git`: Daytona's git calls, run with the git in the sandbox. */
export class Git {
  readonly #ctx: SandboxContext;
  constructor(ctx: SandboxContext) {
    this.#ctx = ctx;
  }

  async #git(args: string[], auth?: { username?: string; password?: string }): Promise<string> {
    const runtime = await this.#ctx.live();
    const withAuth = auth?.username !== undefined || auth?.password !== undefined;
    const result = await guard("sandbox", () =>
      runtime.exec(["git", ...(withAuth ? ["-c", HELPER] : []), ...args], {
        timeoutMs: 600_000,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          ...(withAuth ? { GIT_USER: auth.username ?? "git", GIT_PASS: auth.password ?? "" } : {}),
        },
      }),
    );
    if (result.exitCode !== 0) throw failure(result.stderr, `git ${args[0]} failed`);
    return result.stdout;
  }

  async #repo(path: string) {
    await this.#ctx.ensureHome(path);
    return resolvePath(path);
  }

  async clone(
    url: string,
    path: string,
    branch?: string,
    commitId?: string,
    username?: string,
    password?: string,
  ): Promise<void> {
    const target = await this.#repo(path);
    await this.#git(["clone", ...(branch ? ["--branch", branch] : []), "--", url, target], {
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    });
    if (commitId) await this.#git(["-C", target, "checkout", commitId]);
  }

  async add(path: string, files: string[]): Promise<void> {
    await this.#git(["-C", await this.#repo(path), "add", "--", ...files]);
  }

  async branches(path: string): Promise<ListBranchResponse> {
    const out = await this.#git([
      "-C",
      await this.#repo(path),
      "branch",
      "--format=%(refname:short)",
    ]);
    return { branches: out.split("\n").filter(Boolean) };
  }

  async createBranch(path: string, name: string): Promise<void> {
    await this.#git(["-C", await this.#repo(path), "switch", "-c", name]);
  }

  async checkoutBranch(path: string, branch: string): Promise<void> {
    await this.#git(["-C", await this.#repo(path), "checkout", branch]);
  }

  async deleteBranch(path: string, name: string): Promise<void> {
    await this.#git(["-C", await this.#repo(path), "branch", "-D", name]);
  }

  async commit(
    path: string,
    message: string,
    author: string,
    email: string,
    allowEmpty = false,
  ): Promise<{ sha: string }> {
    const repo = await this.#repo(path);
    await this.#git([
      "-C",
      repo,
      "-c",
      `user.name=${author}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "-m",
      message,
      ...(allowEmpty ? ["--allow-empty"] : []),
    ]);
    return { sha: (await this.#git(["-C", repo, "rev-parse", "HEAD"])).trim() };
  }

  async push(path: string, username?: string, password?: string): Promise<void> {
    await this.#git(["-C", await this.#repo(path), "push"], {
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    });
  }

  async pull(path: string, username?: string, password?: string): Promise<void> {
    await this.#git(["-C", await this.#repo(path), "pull"], {
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    });
  }

  async status(path: string): Promise<GitStatus> {
    const out = await this.#git([
      "-C",
      await this.#repo(path),
      "status",
      "--porcelain=v1",
      "--branch",
    ]);
    const [head = "", ...lines] = out.split("\n");
    const branch = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head);
    const counts = branch?.[3] ?? "";
    return {
      currentBranch: branch?.[1] ?? "",
      ahead: Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(counts)?.[1] ?? 0),
      branchPublished: Boolean(branch?.[2]),
      fileStatus: lines.filter(Boolean).map((line) => ({
        name: line.slice(3),
        staging: line[0] ?? " ",
        worktree: line[1] ?? " ",
        extra: "",
      })),
    };
  }
}
