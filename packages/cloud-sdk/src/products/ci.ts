/** CI/CD: each push and pull request of a connected GitHub repository is
 * checked in sandboxes, as the plan its config writes. The runner writes the
 * checks, their jobs and logs; these read them. In a private beta. */
import { RuntimeError } from "../errors.js";
import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";

export type CiCheckState = "queued" | "running" | "passed" | "failed" | "cancelled";
export type CiJobState =
  "queued" | "running" | "passed" | "failed" | "flaky" | "cached" | "cancelled" | "skipped";
/** A GitHub repository connected for checks. */
export type CiRepository = {
  id: string;
  name: string | null;
  labels: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  error: { code: string; message: string } | null;
  /** owner/name on GitHub. */
  repository: string;
  /** The branch whose pushes are checked as landed. */
  productionBranch: string;
  /** Where in the repository its checks are written: a `runtime.yml`, or a `cloudbuild.yaml` or `buildspec.yml`, run as Cloud Build or CodeBuild runs it. */
  configPath: string;
  /** The organization's installation of Runtime's GitHub App it is read through. */
  installation: number;
  /** GitHub's id for it, learned from its first event. */
  githubRepositoryId: number | null;
  /** The GitHub Apps (`<app-slug>[bot]`, lowercase, sorted) whose pushes run
   * as the code of someone who can write. */
  trustedApps: string[];
  /** Whether a red production branch's culprit is undone by a pull request
   * CI/CD opens: off until `setUndo` turns it on. */
  undoCulprits: boolean;
  state: "connected" | "disconnected";
};
export type ConnectCiRepository = {
  repository: string;
  productionBranch?: string;
  configPath?: string;
  installation?: number;
  /** Trusted from the connect on, in the same request: a connection trusts
   * no App until told, so one made again names them here. */
  trustedApps?: string[];
  name?: string;
  labels?: Record<string, string>;
};
export type ListCiRepositories = {
  limit?: number;
  cursor?: string;
  name?: string;
  /** key:value, each one the repository must have. */
  label?: string[];
  state?: CiRepository["state"][];
};
/** One check: a commit of a connected repository, run as its plan of jobs. */
export type CiCheck = {
  id: string;
  repositoryId: string;
  /** owner/name on GitHub. */
  repository: string;
  commit: string;
  branch: string | null;
  event: "push" | "pull_request" | "merge_group" | "rerun";
  pullRequest: number | null;
  baseCommit: string | null;
  /** The GitHub login that pushed, opened or re-ran it. */
  actor: string | null;
  /** The repository's writers' code. A fork's pull request is not, and runs
   * nothing; a writer can open it again from a branch of the repository. */
  trusted: boolean;
  /** Queued for a writer's approval: nothing of it runs. */
  waiting: boolean;
  approvedBy: string | null;
  approvedAt: number | null;
  /** Writers' code on the production branch, or a merge group. */
  landed: boolean;
  state: CiCheckState;
  /** Why it ended. */
  reason: string | null;
  /** How many of its jobs are in each state. */
  counts: Partial<Record<CiJobState, number>>;
  /** Where its machines came from and how soon; null until the runner says. */
  machines: CiMachines | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
};
/** Where a check's machines came from and how soon: woken from its pull
 * request's own, left paused by its last check (reused), or from the warm
 * pool (pooled); copies of batch forks (forked, in `forks` calls); made from
 * the warm snapshot (created); left paused for its next push (kept); the
 * first machine's, the first ask's whole and the first test's milliseconds;
 * and its wait in the account's line. */
export type CiMachines = {
  reused: number;
  pooled: number;
  forked: number;
  forks: number;
  created: number;
  kept: number;
  firstMs: number | null;
  readyMs: number | null;
  firstTestMs: number | null;
  lineMs: number;
};
/** One job of a check's plan: a step, or one part of a step split in parts. */
export type CiJob = {
  id: string;
  checkId: string;
  repositoryId: string;
  name: string;
  part: number;
  parts: number;
  needs: string[];
  command: string;
  cacheKey: string | null;
  state: CiJobState;
  /** The passed job a cached one stands on. */
  cachedFrom: string | null;
  exitCode: number | null;
  reason: string | null;
  /** The sandboxes it ran in. A failure's may be kept paused: wake it, or
   * exec in it, with runtime.sandboxes. */
  sandboxIds: string[];
  /** The ID of the job's own GitHub check run (`runtime / <name>`), created
   * completed when the job ends; null while it runs, for a reused pass, or
   * when GitHub did not accept the run. */
  githubCheckRun: number | null;
  /** Lines of the repository's files that the job's log reports as failing,
   * or as warnings and notices, as its GitHub check run shows them. At most
   * 50, failures first. */
  annotations: CiAnnotation[];
  /** A review step's verdict on the commit; null for a command's job. */
  review: CiReview | null;
  ms: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
};
/** A line of a file that a job's log reports. */
export type CiAnnotation = {
  path: string;
  startLine: number;
  endLine: number;
  /** Present only for a single line. */
  startColumn?: number;
  level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
};
/** What one finding of a review is about. */
export type CiReviewKind =
  | "bug"
  | "missed-case"
  | "data-at-risk"
  | "money-at-risk"
  | "auth-bypass"
  | "privilege-escalation"
  | "secret-exposed"
  | "made-public"
  | "command-injection"
  | "manipulation"
  | "other";
/** One thing a review found in the change. */
export type CiReviewFinding = {
  kind: CiReviewKind;
  file: string;
  /** The line in the new file; 0 for the file as a whole. */
  line: number;
  /** What is wrong, and what it breaks. */
  what: string;
  /** What would put it right. */
  fix: string;
};
/** An agent step's verdict on one commit (`review:` is its short form): it
 * passes only with no findings. */
export type CiReview = {
  verdict: "pass" | "block";
  summary: string;
  findings: CiReviewFinding[];
  /** Things worth a look that do not block. */
  notes: { file: string; line: number; what: string }[];
  /** The Runtime Agent that judged, and the model the step asked for. */
  agent: string;
  model: string | null;
  /** The Claude account a verdict before agent steps ran on. */
  account?: string;
  /** The agent session that gave the verdict. */
  session: string;
  /** True when the diff was too long and its end was not read. */
  cut: boolean;
};
/** A check with its jobs, in plan order. */
export type CiCheckDetail = CiCheck & { jobs: CiJob[] };
/** A cancel's answer to a key that may cancel the check but not read it:
 * its id and state, nothing of its jobs or logs. */
export type CiCancelled = { id: string; state: CiCheckState };
/** A job with the tail of its output: at most 256 KiB, the oldest dropped first. */
export type CiJobDetail = CiJob & { log: string };
export type ListCiChecks = {
  repositoryId?: string;
  state?: CiCheckState[];
  branch?: string;
  /** A full commit SHA. */
  commit?: string;
  pullRequest?: number;
  limit?: number;
  cursor?: string;
};
/** One test file of a repository: its recent time and its last 20 runs. */
export type CiTest = {
  repositoryId: string;
  file: string;
  ms: number;
  /** Since when its failures do not fail a check; null: they do. */
  quarantinedSince: number | null;
  runs: {
    at: number;
    check: string;
    job: string;
    outcome: "passed" | "failed" | "flaky" | "skipped";
    ms: number | null;
    /** false for an approved outsider's run. */
    writers: boolean;
  }[];
  updatedAt: number;
};
export type ListCiTests = { quarantined?: boolean; limit?: number; cursor?: string };
/** One run of a test file: by commit and content key; its first run, its
 * run again alone after a failure, or a repeat (a new test's 20, a flake's
 * proof of 100). */
export type CiTestResult = {
  file: string;
  commit: string;
  key: string;
  passed: boolean;
  attempt: "first" | "again" | "repeat";
  ms: number | null;
  machine: string | null;
  checkId: string;
  jobId: string;
  /** A run of the production branch's own commit. */
  main: boolean;
  message: string | null;
  at: number;
};
export type CiFlakeState = "quarantined" | "gating" | "fixed" | "deleted";
/** A test that passed and failed on the same inputs, one run main's:
 * quarantined at once (it still runs and reports, and blocks nothing), or
 * still gating when the repository protects it; handed to an owner with 48
 * hours to fix it or delete it with a reason; fixed once 100 runs of a main
 * commit in parallel forks all pass. */
export type CiFlake = {
  id: string;
  repositoryId: string;
  file: string;
  state: CiFlakeState;
  gates: { why: string; words: string } | null;
  proof: {
    key: string;
    commit: string;
    checkId: string;
    jobId: string;
    failedIn: string[];
    passedIn: string[];
  };
  again: number;
  owner: {
    login: string;
    from: "codeowners" | "last change" | "handed" | null;
    pullRequest: number | null;
    branch: string | null;
  } | null;
  since: number;
  dueAt: number;
  overdue: boolean;
  tried: { blob: string; at: number } | null;
  proveAskedAt: number | null;
  deleteReason: string | null;
  endedAt: number | null;
  endedCheckId: string | null;
  updatedAt: number;
};
/** A flake with its test file's newest 200 runs and each failure's job,
 * whose log `jobs.get` reads. */
export type CiFlakeDetail = CiFlake & {
  runs: CiTestResult[];
  failures: {
    jobId: string;
    checkId: string;
    commit: string;
    message: string | null;
    at: number;
  }[];
};
export type ListCiFlakes = {
  repositoryId?: string;
  state?: CiFlakeState[];
  limit?: number;
  cursor?: string;
};
/** An owner's say: its proof runs again at main's next commit, a new
 * owner, or why its test is deleted. */
export type UpdateCiFlake = { prove?: true; owner?: string; deleteReason?: string };

/** One step a release took, as it took it: a migration's copy test or
 * apply, a deploy ref moved, a server's canary or release, the website's
 * deploy or promote, or a wait with why. */
export type CiReleaseStep = {
  id: number;
  repositoryId: string;
  /** The commit this step of the release is of. */
  commit: string;
  /** Who took it: `mover` (the release on CI/CD's pass) or the deploy
   * target that walks it (`hostd`, `controller`, `settings`, `follower`). */
  source: string;
  /** The server it was on, when it was on one. */
  host: string | null;
  line: string;
  /** Unix milliseconds. */
  at: number;
};
export type ListCiReleaseSteps = {
  repositoryId?: string;
  /** Only this commit's release. */
  commit?: string;
  limit?: number;
  cursor?: string;
};

type Wire<T> = { data: T[]; nextCursor: string | null };

export function ci(t: Transport) {
  const at = (base: string, id: string) => `${base}/${encodeURIComponent(id)}`;
  async function paged<T, Q extends { cursor?: string }>(
    path: string,
    query: Q,
    options: RequestOptions | undefined,
  ): Promise<Page<T>> {
    const page = await t.json<Wire<T>>({ method: "GET", path, query, ...options });
    return new Page(page.data, page.nextCursor, (cursor) =>
      paged<T, Q>(path, { ...query, cursor }, options),
    );
  }
  const setTrustedApps = (id: string, trustedApps: string[], options?: RequestOptions) =>
    t.json<CiRepository>({
      method: "POST",
      path: `${at("/v1/ci/repositories", id)}:update`,
      body: { trustedApps },
      ...options,
    });
  const listRepositories = (query: ListCiRepositories = {}, options?: RequestOptions) =>
    paged<CiRepository, ListCiRepositories>("/v1/ci/repositories", query, options);
  /** A connected repository by its id or its owner/name. */
  const find = async (idOrName: string, options?: RequestOptions) => {
    const all = await (
      await listRepositories({ limit: 100, state: ["connected"] }, options)
    ).toArray(Infinity);
    const wanted = idOrName.toLowerCase();
    return all.find((r) => r.id === wanted || r.repository.toLowerCase() === wanted);
  };
  /** As find, or a not_found that says what this key lists. */
  const needed = async (idOrName: string, options?: RequestOptions) => {
    const repo = await find(idOrName, options);
    if (repo) return repo;
    throw new RuntimeError({
      message: `No connected CI/CD repository ${idOrName} that this key lists.`,
      code: "not_found",
      status: 404,
      hint: "Any key an owner or admin made lists the account's repositories; another key, only those its own agent connected.",
    });
  };
  return {
    repositories: {
      /** Connect a GitHub repository for checks. Only a full key connects
       * one, since every push runs its code for the whole account. */
      connect: (input: ConnectCiRepository, options?: RequestOptions) =>
        t.json<CiRepository>({
          method: "POST",
          path: "/v1/ci/repositories",
          body: input,
          ...options,
        }),
      list: listRepositories,
      find,
      /** Replaces the whole list of trusted Apps; `[]` trusts none. */
      setTrustedApps,
      /** Adds Apps to those it trusts, keeping the rest: `id` is its id or
       * owner/name. */
      trust: async (id: string, apps: string[], options?: RequestOptions) => {
        const repo = await needed(id, options);
        const all = [...new Set([...repo.trustedApps, ...apps.map((a) => a.toLowerCase())])];
        return setTrustedApps(repo.id, all, options);
      },
      /** Takes Apps off those it trusts, keeping the rest. */
      untrust: async (id: string, apps: string[], options?: RequestOptions) => {
        const repo = await needed(id, options);
        const drop = new Set(apps.map((a) => a.toLowerCase()));
        return setTrustedApps(
          repo.id,
          repo.trustedApps.filter((a) => !drop.has(a)),
          options,
        );
      },
      /** Turn on (or off) the undo of a red production branch's culprit:
       * when main's check fails, CI/CD finds the first commit that fails it
       * and opens a pull request reverting it, which lands once its own
       * check passes. Off until set; only an owner's or admin's full key
       * sets it. */
      setUndo: (id: string, on: boolean, options?: RequestOptions) =>
        t.json<CiRepository>({
          method: "POST",
          path: `${at("/v1/ci/repositories", id)}:update`,
          body: { undoCulprits: on },
          ...options,
        }),
      /** Disconnect: its checks still going are cancelled; what ended stays. */
      disconnect: (id: string, options?: RequestOptions) =>
        t.json<CiRepository>({
          method: "DELETE",
          path: at("/v1/ci/repositories", id),
          ...options,
        }),
    },
    checks: {
      /** Checks, newest first. */
      list: (query: ListCiChecks = {}, options?: RequestOptions) =>
        paged<CiCheck, ListCiChecks>("/v1/ci/checks", query, options),
      /** A check with its jobs in plan order. */
      get: (id: string, options?: RequestOptions) =>
        t.json<CiCheckDetail>({ method: "GET", path: at("/v1/ci/checks", id), ...options }),
      /** Cancel a queued or running check: its jobs end and its machines
       * are let go. A check that has ended is answered as it is; to a key
       * that may cancel it but not read it, with its id and state alone. */
      cancel: (id: string, options?: RequestOptions) =>
        t.json<CiCheckDetail | CiCancelled>({
          method: "POST",
          path: `${at("/v1/ci/checks", id)}:cancel`,
          ...options,
        }),
      /** Run a check again, as GitHub's Re-run does: a new check of the
       * same commit (a pull request's as it would land now), trusted only as
       * the commit's last check was. A check still going is answered as it is. */
      rerun: (id: string, options?: RequestOptions) =>
        t.json<CiCheckDetail | CiCancelled>({
          method: "POST",
          path: `${at("/v1/ci/checks", id)}:rerun`,
          ...options,
        }),
    },
    jobs: {
      /** A job with the tail of its log and the sandboxes it ran in. */
      get: (id: string, options?: RequestOptions) =>
        t.json<CiJobDetail>({ method: "GET", path: at("/v1/ci/jobs", id), ...options }),
    },
    tests: {
      /** A repository's test files by name, with their quarantine. */
      list: (repositoryId: string, query: ListCiTests = {}, options?: RequestOptions) =>
        paged<CiTest, ListCiTests & { repositoryId: string }>(
          "/v1/ci/tests",
          { ...query, repositoryId },
          options,
        ),
    },
    releases: {
      /** The steps releases took, newest first, of one repository or one
       * commit: only repositories whose releases CI/CD runs have any. */
      list: (query: ListCiReleaseSteps = {}, options?: RequestOptions) =>
        paged<CiReleaseStep, ListCiReleaseSteps>("/v1/ci/releases", query, options),
    },
    flakes: {
      /** Flaky tests, newest first; `state: ["quarantined", "gating"]`
       * lists the open ones. */
      list: (query: ListCiFlakes = {}, options?: RequestOptions) =>
        paged<CiFlake, ListCiFlakes>("/v1/ci/flakes", query, options),
      /** A flaky test with its runs and its failures' jobs. */
      get: (id: string, options?: RequestOptions) =>
        t.json<CiFlakeDetail>({ method: "GET", path: at("/v1/ci/flakes", id), ...options }),
      /** Ask for its 100 proof runs again, hand it on, or say why its test
       * is deleted. */
      update: (id: string, change: UpdateCiFlake, options?: RequestOptions) =>
        t.json<CiFlakeDetail>({
          method: "POST",
          path: `${at("/v1/ci/flakes", id)}:update`,
          body: change,
          ...options,
        }),
    },
  };
}
