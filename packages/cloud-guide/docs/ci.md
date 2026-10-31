---
launch: ci
---

# CI/CD

Connect a GitHub repository. Every push and pull request is then checked on machines in your own account. Each check is reported to GitHub as a check run, and each job as a check run of its own, with its failing lines on the pull request's files. You do not set up a runner or write a config file. Runtime finds the steps of the repository. Each check starts from a warm machine that already has your dependencies. So a pull request runs only its tests, never the install. Our own repository's pull requests ({{ci-ours-test-files}} test files) took {{ci-ours-pull-request}} here. They took {{ci-ours-before}} before. Checked again, they took {{ci-ours-again}}. That is {{ci-ours-saved}} saved on every one.

## Connect a repository

Install Runtime's GitHub App on the GitHub account that holds the repository. `POST /v1/repositories/github:install` returns a link to open in a browser within 15 minutes. Then connect the repository with a full key. Every push runs its code for the whole account.

```bash no-run
curl https://api.withruntime.com/v1/ci/repositories \
  -H "authorization: Bearer $RUNTIME_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"repository": "acme/web", "productionBranch": "main"}'
```

Or use an SDK, or the CLI:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const repo = await runtime.ci.repositories.connect({
  repository: "acme/web",
  productionBranch: "main",
  configPath: "runtime.yml",
});
console.log(repo.id, repo.state);
```

```bash no-run
npx withruntime ci connect acme/web --config runtime.yml
npx withruntime ci repos
```

| Field              | What it is                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| `repository`       | `owner/name` on GitHub. Required.                                          |
| `productionBranch` | The branch whose pushes are checked as landed. Default `main`.             |
| `configPath`       | Path of the file that sets the repository's checks. Default `runtime.yml`. |
| `installation`     | The installation of Runtime's GitHub App used to read it. Default: newest. |
| `trustedApps`      | GitHub Apps whose pushes run as your own code (see below). Default: none.  |

Or with the CLI:

```bash no-run
runtime ci repos connect acme/web --branch main --trust my-bot[bot]
```

`GET /v1/ci/repositories` (`runtime ci repos ls`) lists the connected repositories, oldest first. It shows the Apps each one trusts. `DELETE /v1/ci/repositories/{id}` (`runtime ci repos disconnect acme/web`) disconnects one. Its running checks are cancelled. Checks keep running while the key that connected the repository stays full.

A repository belongs to the account, not to one key. It connects once per account. A key that an owner or admin made lists every connected repository, whichever key connected it. Any full key of theirs can change or disconnect one. Any other key lists only the repositories its own agent connected. Listing a repository does not let you read its checks. See "A job" below.

From then on, these start a check:

- a push to any branch (tags and deletes start nothing);
- a pull request opened, reopened, pushed to, marked ready for review or moved to another base branch;
- a group of GitHub's merge queue ([GitHub's merge queue](#githubs-merge-queue));
- a re-run requested on GitHub.

To check only the pull requests into some branches, list them in the production branch's file:

```yaml
pull_requests:
  branches: [main]
```

A pull request into any other branch ends immediately and uses no machine. Its `runtime` run on GitHub reads "Not checked" with the conclusion action required, which never passes a required check. The list is read from the production branch's file, never from the pull request's own, so a pull request cannot skip its own check. When a pull request's base branch changes, it is checked again against the new base. Without the list, every pull request is checked.

A newer push to the same branch or pull request replaces a check still running. Its machines are freed immediately, because the newer commit includes the older one. On the production branch, newer pushes can keep a check from reaching a verdict. Once they have kept it without a verdict for 20 minutes, the check running then is kept and finishes. So merges faster than a check never leave the branch unjudged.

## Whose code runs

A check runs code only from the repository's own people:

- a push by someone GitHub says can write to the repository;
- a push by a GitHub App the repository trusts (see below);
- a pull request from one of the repository's own branches, once one of the above has pushed its head commit;
- a group of GitHub's merge queue that holds only such pull requests ([GitHub's merge queue](#githubs-merge-queue)).

Anything else waits unrun. A `runtime` check run on GitHub says why. This covers a fork's pull request, a push by someone who can only read, and a push by an App the repository does not trust. A waiting check never passes branch protection. A repository holds at most 20 waiting checks. A waiting check that waits longer than 7 days ends.

## Trust your own automation's App

If your own automation pushes through a GitHub App, such as a bot that opens pull requests, list that App in the repository's `trustedApps`. Its pushes then run as code from someone who can write.

```bash no-run
curl -X POST "https://api.withruntime.com/v1/ci/repositories/${REPOSITORY_ID}:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: trust-my-bot" \
  -d '{"trustedApps": ["my-bot[bot]"]}'
```

The CLI adds or removes Apps and keeps the others:

```bash no-run
runtime ci repos trust acme/web 'my-bot[bot]'
runtime ci repos untrust acme/web 'my-bot[bot]'
```

- Name each App by its login, `<app-slug>[bot]`, as GitHub shows its pushes. Letter case does not matter. The list stores logins in lowercase.
- A repository trusts at most 10 Apps.
- Each update replaces the whole list. `[]` trusts none.
- Only a full key that an owner or admin made can set the list. The same rule applies to connecting.
- The trusted Apps belong to the connection. A repository that is disconnected and connected again trusts none until you list them again. Or name them in the connect's `trustedApps`.
- Listing an App also runs that App's waiting pushes to the production branch. They run newest first, while the account's `check` limit has room. A push that still waits is replaced by the branch's next push, which now runs. Another branch's push is checked by its pull request. So a check of one that still waits ends.
- A waiting pull request check does not run on the listing alone. The person who sent the pull request need not have pushed its code. The next push of its branch checks it.
- Listing an App vouches only for that App's own pushes, and for the pull requests of the commits it pushed. It never vouches for a fork's or anyone else's.

Every repository's response includes its `trustedApps`, sorted. The same update sets [`undoCulprits`](#undo-a-failing-production-branch), alone or with them.

### Errors

| Status | Code                   | When                                                                                                       |
| ------ | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`      | `trustedApps` is not a list of at most 10 `<app-slug>[bot]` logins, or the update names `name` or `labels` |
| 403    | `forbidden`            | The key is not a full key, or no owner or admin made it                                                    |
| 404    | `not_found`            | No such repository this key may change: a narrowed key, or one no owner or admin made                      |
| 409    | `invalid_state`        | The repository is disconnected                                                                             |
| 409    | `idempotency_conflict` | The idempotency key was used with another body                                                             |

## Steps found for you

If there is no `runtime.yml` and no other CI's pipeline file ([Move from another CI](#move-from-another-ci)), Runtime reads the repository root:

| Found                                  | Setup                                                  | Steps                                                      |
| -------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `package.json`                         | the lockfile's package manager: bun, pnpm, yarn or npm | the scripts it has, in order: lint, typecheck, test, build |
| `pyproject.toml` or `requirements.txt` | uv, poetry or pip                                      | `ruff check .` when ruff is set up, then `pytest`          |
| `go.mod`                               | `go mod download`, then the tests built                | `go vet ./...`, `go test ./...`                            |
| `Cargo.toml`                           | `cargo fetch`, then the tests built                    | `cargo test --locked`                                      |
| `Dockerfile`                           | none                                                   | `docker build .`                                           |

Setup builds a compiled project's tests once, into the warm snapshot that every check starts from. A check compiles only what its change touched. Setup builds the tests but never runs them. No `TestMain` or `init` runs during setup. A build that fails does not fail setup. The steps say what does not build.

A `package.json` project's setup runs its build, lint and typecheck scripts once, in the same way. It never runs the tests. So the warm snapshot holds every cache they leave: turbo's, Next.js's, eslint's and tsc's. A check lints and type-checks only what its change reaches. If a lint script is only `eslint`, it gets eslint's cache. If a typecheck script is only `tsc`, `tsgo` or `vue-tsc`, it gets its incremental build info. Each cache is keyed by the files' bytes. So the answer matches the one a cold run gives. A bun project with test files and no `test` script runs `bun test`.

A repository with none of these files ends its check immediately. The run says so. Add a `runtime.yml` that names the steps.

## runtime.yml

An optional file at the repository root (`runtime.yml`, `.runtime.yml`, or the `configPath` you connected with) defines the steps yourself. A check reads the file from the commit it checks. So a pull request that changes its steps is checked with those changes. A step that must hold whatever a pull request says is a gate (`gate: true`, below). Its definition is read from the base's copy, never the pull request's.

```yaml
machine: 4cpu # 2cpu, 4cpu (default), 8cpu or 16cpu; 4 GiB of memory per vCPU
setup: bun install --frozen-lockfile # run once, kept as the warm machine
cache: [bun.lock, package.json] # files whose bytes key the warm machine
timeout: 120 # seconds the whole check may take from its start: 10 to 21600 (default 21600)
steps:
  - name: lint
    run: bun run lint
    inputs: ["src/**"] # what keys its result, with all they read (default: every file)
  - name: test
    run: bun test {files}
    split: { files: "**/*.test.ts" } # parts left out: by recorded times
    needs: [lint]
    timeout: 30 # seconds each run may take, each test file apart (default 21600)
  - name: review rules
    run: ./check-rules.sh
    gate: true # the base's own; a pull request can't rewrite or drop it
budgets: # machine seconds steps may take together, cold; the base's own
  tests: { seconds: 20, steps: [lint, test] }
generated: # files a program writes and git does not hold (see Generated files)
  - { paths: [src/catalogue.json], by: scripts/catalogue.ts }
```

- **Steps** run side by side unless one `needs` another. A step starts as soon as every step it needs has passed, on the check's machines, without waiting for other steps. A step whose needs failed is skipped. A step may set its own `machine` and `env`. Env names must not start with `RUNTIME_`.
- **What each step reads:** `RUNTIME_CI_COMMIT` is the commit checked. `RUNTIME_CI_EVENT` is `pull_request` or `push`. `RUNTIME_CI_PULL_REQUEST` is the pull request's number. `RUNTIME_CI_BRANCH` is the pull request's head branch, or the branch pushed. `RUNTIME_CI_PRODUCTION_BRANCH` is the repository's production branch. `RUNTIME_CI_BASE` is the commit's first parent. `RUNTIME_CI_SINCE` is the commit the change is since: a pull request's base, or, for a push to the production branch, its newest commit whose check passed. A step that picks its work by what changed, such as `git diff --name-only "$RUNTIME_CI_SINCE"`, reads every commit since one that passed. A variable with no value is unset.
- **Branch steps:** a step with `branch: main` is planned only in checks of a push to that branch, such as end-to-end tests that run after merge. A pull request's check, and a push to any other branch, has no job for it and uses no machine for it. A step that `needs` it must name the same `branch`. A gate cannot have one.
- **Limits:** the file is at most 64 KiB and has at most 64 steps. `run` and `setup` are each at most 8 KiB.
- **Timeouts:** each run of a step is killed when it passes its `timeout:`. For a split step, each file is timed apart. A run is never given more than the check has left. The whole check is cut at its own `timeout:`. That timer starts when the check starts, and it includes time spent waiting for machines. Both limits default to 6 hours, the same as GitHub Actions' own job limit. So a suite that ran there runs here. Every job still waiting or running at the check's timeout fails. Each one says what it was doing, for how long, and where the limit is set, such as `Cut
at the check's 120 s timeout (timeout: in runtime.yml): still running after
95 s: test/slow.test.ts`. A killed run reports its file and time: `t/slow.sh
ran 30 s, past its step's 30 s timeout (the step's timeout: in runtime.yml),
and was killed.` A limit left at its default says so. The check's machines end with it. `runtime ci import` carries a GitHub job's `timeout-minutes` over as its step's `timeout:`.
- **Budgets** keep a suite fast as it grows. A budget's time is the machine time of all files in its split steps, plus all of its whole steps that ran. Each file counts at its run in this check. If a pass of the same files covers it, the file counts at its recorded time instead. This is what the suite takes cold, not only what a change touched. A test that runs 20 times to prove itself counts once. When a budget is exceeded, the check fails as `budget <name>`. The failure gives the time and the slowest files: `budget tests: 23.4 s of machine time cold over its
412 files and steps, over its 20.0 s budget; slowest: test/db.test.ts
3.1 s, …`. A budget is judged only on a check that ran one of its files or steps. The budget is read from the base's file, so a pull request cannot loosen it. Seconds are shown to the millisecond (`0.5`). Each step is in one budget at most, and a file holds up to 16.
- **A job is never silent.** While its files run, or wait behind files that are ending, its log reports progress at least once a minute. For example: `Still running: 35 of 40 ended; 2 running, the longest for 12 s`. A test file with a recorded time runs past three times that time and prints nothing for a minute (or its usual time, if longer). Then it is moved once to another machine. There it runs to its own limit. Quiet never fails a file.
- **Errors** fail the check immediately, before any machine is made. One run names the key at fault: `runtime.yml: is over 64 KiB`.

### Gates

A step with `gate: true` is read from the production branch's file as it is now. It is never read from the pull request's own file. It is also never read from the target branch's file or a pushed branch's file. A change that edits or removes the gate still meets the production branch's version. This holds whether the change is on its own commits or on a branch under them.

A check's gates run one after another. They run on one machine of their own, made from the image. None of the change's code runs on it. The machine has no setup and none of the change's files. It has only the history of the head and of the production branch's head. A gate reads that history as its base (`RUNTIME_CI_BASE`, and `refs/runtime-ci/commit`, `refs/runtime-ci/base`). So it runs what the production branch's own files say, as in `git show "$RUNTIME_CI_BASE:check-rules.sh" | sh`. It judges everything since the head met that branch. A push of the production branch itself is judged against the commit before it.

Along with each step's `RUNTIME_CI_COMMIT`, `RUNTIME_CI_BASE` and `RUNTIME_CI_EVENT`, a gate reads these:

- `RUNTIME_CI_HEAD` is the pull request's head.
- `RUNTIME_CI_APPROVED_BY` lists the GitHub logins whose latest review approves exactly that head.
- `RUNTIME_CI_REVIEWS_FILE` is a JSON file of the pull request's reviews. Each review has `id`, `user.login`, `state`, `commit_id` and `body`. A gate can use it, such as a signed record that it checks.

A review that approves, asks for changes, or comments with words checks the head again. So does a dismissed review. A gate runs on every commit and is never served an earlier pass. It has no `split`, `inputs`, `needs` or `machine`. No step needs one.

### Fix and warnings

Style issues should warn, not block. A step with `fix` runs a command that rewrites files, such as a formatter or a code generator. It runs on the machine of the change as it would land. It fails nothing:

```yaml
steps:
  - name: format
    fix: bun run format # bash -c; no run, split or gate beside it
```

The step runs your command on a copy of the tree. It never runs in the checkout that your other steps use at the same time. So a rewrite never lands under a compile or a test. Every step tests the commit. The copy holds the working tree as it is, including uncommitted files. The checkout's ignored folders (`node_modules`, `target`, ...) are linked in, so your tools are found. The copy is removed afterward. If your command exits with a code other than 0, or leaves files changed, each case is a warning in the check's summary. Changes are compared as git trees before and after, so a change's own edits are not counted. Each warning names up to five of the files. The step passes. The files it rewrote are not kept: whoever pushes next fixes them. The step runs on every commit unless it sets `reuse: true`. So a warning is never hidden behind an earlier pass. It may set `name` (default `fix`), `inputs`, `needs`, `machine` and `env`.

Any step can warn. A line of its output that starts with `::warning` is a warning. This is GitHub Actions' own syntax: `::warning::text`, or `::warning file=a.rs,line=3::text`. The job keeps the warning. Each task keeps at most 10 lines of 300 characters. The check's `runtime` run on GitHub names the job and its first lines under "N warnings, which do not block". The job's row says "passed with N warnings". A warning fails nothing. A step fails only on its exit code. So a lint that should fail only on bugs names those lints, such as `clippy -- -D clippy::correctness`. The other lints warn.

### Steps that need no machine

A step that only reads the tree and its history needs no machine. So it never waits in line for one. There are two kinds:

```yaml
steps:
  - name: new code is Rust
    machine: none # a built-in check, run by the runner itself on the files it holds
    inline: { kind: new-files, languages: [ts, py], keep: [sdks], why: "New code is Rust." }
  - name: scan
    machine: light # a command, on the check's one light sandbox
    run: ./scan.sh
```

- **`machine: none`, with `inline:`** is one of the runner's own checks. It runs in the runner immediately after the plan. It reads the commit's files and its base's, plus the bytes of any file the check reads. Its row passes or fails within seconds. `new-files`: the change adds no source file in some `languages` outside the `keep` folders. A move, a config file, and a test beside old files all pass. `approval`: a change to the `files`, `trees` (except what `exempt` names), or guarded `lines` of one of its `classes` fails. It fails until one of that class's `approvers` approves it on GitHub (see [Required approvals by content](#required-approvals-by-content)). With `gate: true`, the step is the base's own. `codeowners`: GitHub's code owners file and an `approval` step (`matches`) name the same files. `undoes`: the change sets no file back to how its base had it before other changes landed. The exception is when its commit messages name them. This check reads history. The runner does not hold history, so it asks git on the light sandbox. `hot-spots`: the change edits no [hot spot](#hot-spots) and commits no new generated file. It also reads history on the light sandbox. A built-in has no `run`, `split`, `inputs`, `needs` or `env`. It is never served an earlier pass. Nothing needs it.
- **`machine: light`** is a command that reads only the tree and its history, such as a scan of the lines a change adds. All light steps of a check, and the built-ins that ask git, run one after another. They share one small sandbox, made from the image for the check. It has the commit's files checked out and its history fetched. It has no setup and no warm machine. Steps do not each get a machine. A command that needs your dependencies belongs on the forks. A light step has no `split` or `needs`, and nothing needs it.

### Required approvals by content

An `approval` step requires a named person's approval only for the content
they own, such as prices, design tokens, legal text or the words of public
pages. Everything else merges on its other checks. Each class names what it
guards and who approves it:

```yaml
steps:
  - name: approvals
    machine: none
    gate: true # read from the production branch; a pull request can't edit it
    inline:
      kind: approval
      approvers: [founder] # the default for every class
      carry: true # optional: an approval holds while guarded content is unchanged
      compare: merge-base # optional: judge the head from its merge base
      classes:
        - name: prices
          files: ['^config/prices\.json$']
          lines: # only changed lines that match wait, in these files
            - files: ['^site/pages/.+\.tsx$']
              not: ['\.test\.tsx$']
              match: ['\$\s?\d', '(?i)\bper (hour|month)\b']
        - name: design
          approvers: [design-lead]
          trees: ["^ui/tokens/", "^site/styles/"]
          exempt: ['\.test\.tsx?$']
        - name: compliance
          approvers: [founder, counsel]
          trees: ["^legal/"]
```

- **Detection.** A file matched by a class's `files`, or under its `trees`
  and not matched by `exempt`, waits whenever it changes, including when it
  is added or deleted. A file matched by a `lines` rule waits only when an
  added or removed line matches `match`. Patterns are regular expressions
  matched against the file's path.
- **Who approves.** Each class that the change touches needs an approving
  GitHub review from one of its own `approvers`. An approval for one class
  does not cover another. The step passes when every class it touches is
  approved, and its failure lists each class that is still waiting, its
  files, and who can approve it.
- **What an approval covers.** By default, only an approval of exactly the
  pull request's head counts, and each new push needs a new approval. With
  `carry: true`, an approval covers content instead of a commit: a
  reviewer's latest approving review on an earlier head still counts for a
  class when that class's content is the same on the current head (each
  guarded file has the same contents before and after, and each `lines`
  file adds and removes the same guarded lines). A merge of the production
  branch that leaves those lines alone, or a later fix to files no class
  guards, keeps the approval. Any change to guarded content requires a new
  approval. A later review that requests changes, or a dismissed review,
  withdraws that reviewer's approval.
- **What is compared.** By default, a gate compares the head with the
  production branch's head. With `compare: merge-base`, it compares the head
  with where it meets the production branch (their merge base, as GitHub
  reports it), so a head that is behind the production branch is judged only
  by its own changes. If GitHub reports no merge base, the production
  branch's head is used.
- **A step without `classes`** is one class made from its top-level `files`,
  `trees`, `exempt` and `lines`.
- **When it runs again.** A new review starts the check again, so an
  approval given after the step failed is applied without a new push.

### Agent steps

A step with `agent` starts a session of one of your organization's [Runtime Agents](./agents). It starts with the change, at the same time as the tests. The step waits for its verdict: pass, or block with findings. Each step is its own agent, with its own instructions. For example: a reviewer, a check that the docs were updated, or an agent that holds your own rules.

```yaml
steps:
  - name: review
    review: { agent: ci-review } # model: opus, sonnet, haiku or a claude-* id
  - name: docs
    agent:
      agent: docs-check
      inputs: { docs: packages/guide } # its own settings, at most 32
      strict: true # block what can't be read whole; off by default
```

`review:` is the short form of an agent step. `review: { agent: ci-review }` means `agent: { agent: ci-review }`. Its step is named `review` unless you name it.

**What the agent is told.** The session's first word is a JSON header: `{"runtimeCheck": 1, "task", "parts", "model", "inputs", "schema"}`. The next `parts` words are the change. They hold the diff against the base, with 10 lines of context. They also hold what the repository's members asked for. Only words that members wrote are read. Members are owners, members, collaborators and people, never an App. These words are the pull request's title and description when its author is a member. They also include the issues it closes (`Fixes #12`) that a member opened, and members' `/ask` comments. Findings show on GitHub. So the agent is told only what the repository's readers can already read.

**What it returns.** It ends the session with `done`. Its result is a JSON object that matches `schema`: `{"verdict": "pass", "summary", "findings": [],
"notes"}`, or `"block"`, with each finding's `kind`, `file`, `line` (in the new file), `what` (who is hurt and how) and `fix`. Only findings block. Notes never do. A blocked step fails its job, and so the check. The check's `runtime` run on GitHub names it. The job's log in the console (and `runtime ci logs`) lists each finding with its fix. The next commit's session is shown the last blocking one. So it can check that those were fixed. An agent that cannot give a verdict yet returns `{"later": "why", "until": <seconds since 1970>}`. This happens when every account in its pool is out of usage. The job waits and says so on GitHub. Running out of usage never fails a check. A session that ends with no verdict is asked again. After four tries, the job fails with the reason.

**What CI/CD guarantees, whatever the agent:**

- The step is read from the production branch's file, as a [gate](#gates) is. So a pull request cannot drop or soften its own agent step. It also cannot point the step at another agent.
- A change with the same files and base is not asked twice. A step runs on a pull request's check. The production branch's push (its landing) relies on that verdict. It runs no agent step of its own. Any other push's check passes no agent step it did not run.
- The diff an agent reads is at most 400 kB. Lock and generated files come last. A file over 1 MB, or one with binary bytes, is named but not shown. A cut diff is still asked about, and the verdict says it was cut. With `strict: true`, nothing unread passes. A change with any file not shown is blocked, and the block says so. No agent is asked. Lock and generated files count. So do compiled code and archives: `.so`, `.node`, `.wasm`, `.jar`, `.zip`. A checksum or a minified script counts too. Only images, fonts, audio and video may go unshown.
- Only an agent whose definition an owner or admin last set is asked. This applies whether the owner or admin used their own key or one serving them. A change to the definition by anyone else makes the step fail. That includes a pull request's author. The step fails with the reason until an owner or admin sets it again. No key other than the session's own can run commands or reach files in an agent step's sandbox. So no one can write a verdict for it.
- A step's agent acts on nothing, because the change it reads may try to steer it. The agent runs the `review` or `judge` template's harness. The harness asks Claude once. It has no tools: no shell, no files, and no network of its own. It runs from the stock image. It has no `from`, `env`, `mcp` or `volumes`, and no shared memory. Its only egress secret is its pool of Claude accounts. Its session starts no subagent. A step checks its agent's `instructions`, model and inputs. An agent that runs another command, or reaches more, fails the step, and the step says so.

Everything else belongs to the agent. That covers how it runs, its `instructions` (your own rules), its [pool of Claude accounts](./agents#a-pool-of-claude-accounts), and its budgets and time limits. It is billed like any agent session. A step that cannot start its agent fails its job with the reason. Examples are a missing agent, or an agent over its day's budget.

**A reviewer.** The `review` template is a stock reviewer. It asks Claude once. It has no tools, no files, and none of the repository's secrets. So a change cannot make it run anything. It blocks only for harm. Harm includes a bug or missed case that hurts the people who use the software. It includes data or money put at risk. Security holes count too: a bypassed check, a leaked secret, something made public, or an injected command. Anything that weakens a check blocks. So do words in the change that try to steer the reviewer. Everything else is a note. That covers naming, docs, and a test worth adding. Your `instructions` add to its rules.

**Your own rules.** The `judge` template reads the change just as strictly. It has the same safety: no tools, no memory. Words in the change that try to steer it are a finding. Its `instructions` alone say what blocks. None of the reviewer's rules apply first. So a docs check blocks what you tell it to block. A judge with no instructions judges nothing, and says so.

```bash no-run
printf %s "$TOKEN_1" | runtime secrets set CLAUDE_1 --host api.anthropic.com
printf %s "$TOKEN_2" | runtime secrets set CLAUDE_2 --host api.anthropic.com
runtime agents create ci-review --template review --pool CLAUDE_1 --pool CLAUDE_2
runtime agents create docs-check --template judge --pool CLAUDE_1 \
  --instructions "Block a change to src/ that leaves docs/ as it was."
```

An agent made from either template runs exactly its command from the stock image. An agent that sets `from`, `volumes`, `env` or `mcp` is refused. So nothing but its harness is in its sandbox. The harness runs Claude Code's pinned version through the image's own `npx`. It never runs a `claude` found on a path.

### Deploy

A `deploy:` entry runs after a push to its `branch` passes every job. It never runs from a pull request. With `app:`, it deploys a Runtime App. With `run:` alone, it runs that command once. With `targets:`, it is a staged deploy. Your command runs on each target. A canary target goes first and is judged. Then all the other targets run in parallel. Each runs on a machine of its own, with the commit checked out.

```yaml
deploy:
  - name: hosts
    branch: main
    targets: [eu-1, eu-2, us-1, us-2, us-3]
    canary: eu-1 # released alone first
    run: ./release.sh {target} # {target} is the name; DEPLOY_TARGET too
    gate: { run: "./probe.sh {target}", for: 30, every: 10 } # seconds
    rollback: ./release.sh {target} --back # the canary, when its gate fails
    slow: 45 # seconds before a target is called a straggler
    retries: 2 # tries after the first, for a target that fails
    limit: 600 # seconds one run of your command may take
    env: { REGION: us } # names not starting RUNTIME_
```

- **The canary** runs `run`, then the gate. The gate runs its command on the canary every `every` seconds, for `for` seconds (30 and 5 unless you say; `for: 0` is one probe). A probe that exits non-zero fails the gate immediately. Then `rollback` runs on the canary. No other target is touched. The deploy fails with the probe's last line. A canary whose `run` fails stops the deploy the same way, but with no rollback. A release script is expected to undo its own failure.
- **The rest** run immediately. A target that is still on its first try `slow` seconds after the rest began is a **straggler**. A target that fails is a straggler too. A straggler is named on the check. It runs alone and is tried again up to `retries` times. The other targets never wait for it. The stage says `all` and `live` when every other target has released. It reports each straggler's end when it comes. The deploy fails, and names the stragglers, only if a target is still on the old release after its last try.
- **The stopwatch** writes one line per stage. The line appears on the check's run and in the job's log, such as the one below. `merged` is when the check began.

  ```
  deploy hosts: merged → checked 38.2 s → canary 29.8 s → all 41.0 s → live 109.0 s after the merge
  ```

- **Where it runs:** only for a trusted check of a push to the repository's production branch. It runs once every other job has passed. A pull request, a push to any other branch, and a check that is not trusted deploy nothing. The job says why. Like a gate, the `deploy:` entries are read from the commit before the push, never from the commit itself. A change to them takes effect from the next push. No pull request can change what a deploy runs.
- **Not set up:** a command that exits 78 changed nothing. Its last line says what is missing. The deploy is then skipped, and the job says so. It is never reported as live.
- **Limits:** at most 64 targets. A target's name may contain letters, digits and `_ . -`. The machine has your `setup`'s tools, the commit's files, and every `RUNTIME_CI_*` variable a step has. Put nothing secret in the file.

### A check's machines

Every machine a check runs on starts from the warm snapshot for that check alone. It can start on any server with room. It is deleted when the check ends, whether the check passed, failed or was cancelled. Nothing waits between checks. No machine stays paused for a pull request's next push or for the next check. So nothing is billed after a check ends. No push's verdict depends on what an earlier push left on a machine. Each push starts fresh. Its build caches come from the [build cache](#rust-build-cache), not from a kept machine. A `runtime.yml` that still sets `keep:` or `pool:` is still accepted. Both settings are read and do nothing.

A step's short tasks never wait behind a long one on the same machine. A job whose last runs each used under 2 GiB, and either under a vCPU or 15 seconds at the 99th percentile, runs in a slot of its own beside the machine's other task. A build that holds the machine for minutes does not delay it. It never runs beside a task that needs most of the machine's memory (`heavy`). A light task that fails runs again with the machine to itself, as its first run. So does a step that runs once (a build, lint, types) and failed while a light task ran beside it. A test file that failed while a light task ran beside it runs its repeat with the machine to itself. If the repeat passes, the file is reported flaky, as for any other flake. A task that failed with no light task beside it is handled as before.

### Split test files

A step with `split` runs each of its files as a task of its own. Files are dealt across parts by how long each took before, longest first. `{files}` in `run` becomes the part's files. `parts` sets how many parts (1 to 64). If left out, Runtime chooses about 20 seconds of tests per part. It uses up to 16 parts, and no more than the machines a check runs at the same time. Each part is a job of its own in the console and the API, such as `test (2/4)`.

Only the files a change can make fail will run. Runtime reads what each test file reads from the repository. That includes its imports (TypeScript and JavaScript, Python, Go packages, Rust crates). It also includes the files and folders its code names, the scripts it runs, and its package's test setup. A file whose reads the change leaves alone keeps the pass it had on the production branch or an earlier push. It runs on no machine (see [Passed before](#passed-before)). A part with nothing left to run passes immediately, on no machine.

## Move from another CI

Connect the repository. Nothing else changes. If the repository has no `runtime.yml`, each check runs the pipeline file of the CI you use now, as that file is written:

| CI         | File                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CircleCI   | `.circleci/config.yml`                                                                                                                                   |
| GitLab CI  | `.gitlab-ci.yml`, with the files its `include: local:` names                                                                                             |
| Buildkite  | `.buildkite/pipeline.yml`, or `buildkite.yml`                                                                                                            |
| Harness CI | the first pipeline under `.harness/` (`pipeline:` and its `stages:`), among the first 16 YAML files: those in a `pipelines/` folder, then the shallowest |

```bash no-run
npx withruntime ci connect acme/web   # the next push is checked from .gitlab-ci.yml
```

Each job of the pipeline is a step of the check, on a machine of its own. A matrix cell and each copy of a parallel job are one step each. A job waits for the jobs it waits for there: CircleCI's `requires`, GitLab's earlier stages or `needs`, Buildkite's `wait` and `depends_on`, and Harness's earlier stages. A job runs in its image: `docker:` in CircleCI, `image:` in GitLab, the docker plugin in Buildkite, and each step's `image` in Harness. One container is kept for the whole job, so what one step installs is there for the next. The checkout is at its own path, and at CircleCI's `working_directory`. The container runs as root, with the image's `HOME`. Its services run beside it: CircleCI's other `docker:` images, GitLab's `services:`, and Harness's `Background` steps. They listen on `localhost` and are also reached by their names and aliases. A job starts once each port its services expose accepts connections, after 60 seconds at most. Every image is pulled once into the warm machine, so a check's jobs start with them in place.

What carries over:

| From                                                                                                                                             | On Runtime                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variables in the file: `environment:`, `variables:` (with `inherit:`), `env:`, `envVariables`                                                    | set for the job; GitLab's job variables are given to its services too                                                                                                                              |
| The CI's own variables                                                                                                                           | `CI`, `CIRCLE_SHA1`, `CIRCLE_BRANCH`, `CI_COMMIT_SHA`, `CI_COMMIT_REF_SLUG`, `CI_PIPELINE_SOURCE`, `BUILDKITE_COMMIT`, `BUILDKITE_BRANCH`, `DRONE_COMMIT_SHA`, and others, from the commit checked |
| CircleCI `commands:`, parameters, executors, `pre-steps` and `post-steps`, `when` steps                                                          | inlined, `<< parameters.x >>`, `<< pipeline.git.branch >>` and `<< matrix.x >>` filled in                                                                                                          |
| CircleCI orbs `circleci/node`, `circleci/python`, `circleci/go` and `circleci/ruby`, and orbs defined in the file                                | their commands, executors and jobs                                                                                                                                                                 |
| GitLab `include: local:`, `extends:`, `default:`, anchors, `!reference`                                                                          | merged as GitLab merges them                                                                                                                                                                       |
| GitLab `rules:`, `only:`, `except:`, `workflow: rules:`; Buildkite `if:` and `branches:`; Harness `when: condition:`; CircleCI branch `filters:` | judged on the machine when the job starts. A job they rule out passes and says why                                                                                                                 |
| `parallelism:` / `parallel:`, and `circleci tests glob`, `circleci tests split`                                                                  | one step for each copy, told its index (`CIRCLE_NODE_INDEX`, `CI_NODE_INDEX`, `BUILDKITE_PARALLEL_JOB`)                                                                                            |
| Buildkite's docker-compose plugin (`run:`, `build:`, `config:`)                                                                                  | `docker compose run` of the service                                                                                                                                                                |
| `buildkite-agent annotate` and `meta-data`                                                                                                       | printed to the log, and kept within the step                                                                                                                                                       |
| `after_script`, `when: always`, `allow_failure`, `soft_fail`                                                                                     | as there                                                                                                                                                                                           |
| `timeout:`, `timeout_in_minutes`, `resource_class`, GitLab's `saas-linux-*` tags                                                                 | the step's `timeout:` and machine                                                                                                                                                                  |
| CircleCI's `{{ checksum "…" }}` and GitLab's `cache: key: files:`                                                                                | `cache:`: the files that key the warm machine                                                                                                                                                      |

A pull request's check runs a GitLab job when its rules allow it in a branch pipeline or in a merge request pipeline. The job gets the variables of the pipeline that allowed it: `CI_COMMIT_BRANCH` in a branch pipeline, and `CI_MERGE_REQUEST_IID` in a merge request pipeline. A push to a branch is a branch pipeline. Every step also gets `RUNTIME_CI_PULL_REQUEST`, the pull request's number, which is unset on a push.

The following do not run. Each one is reported in a `::warning::` line at the start of its job. The warnings appear in the check's summary on GitHub and in the job's log. A check never fails because of them:

- **Jobs that need something a check does not have.** These are macOS and Windows jobs, manual jobs, approval holds and `block` steps, and the jobs after them. Deploys do not run either. These are CircleCI `deploy:` steps, GitLab jobs with an `environment:`, Harness Deployment stages, and triggers of other pipelines. Jobs, stages and steps with a name that contains a word starting with "deploy" (such as `deploy-prod` or `Deploy to production`) do not run either. Each one passes and says why. To deploy from CI/CD, use [`deploy:`](#deploy) in a `runtime.yml`.
- **Secrets and settings kept by the other CI.** These are CircleCI contexts and project variables, GitLab CI/CD variables, Buildkite agent hooks, and Harness secrets. The warning names each variable that the scripts read and the file does not set. In the job, these variables are empty.
- **Files passed between jobs.** These are workspaces, artifacts and `buildkite-agent artifact download`. A job that reads files another job built has to build them itself. Test results and artifacts are not uploaded. The job's log is kept.
- **Orbs and plugins from a registry.** Other orbs' commands, and Buildkite plugins other than docker and docker-compose, are named and skipped. GitLab includes from templates, other projects, components and URLs are named and not read. Copy what they define into the repository.
- **Scheduled pipelines.** CircleCI scheduled workflows do not run. `rules: changes:` is treated as matching, because a check already runs only what the change reaches.

A pipeline file is read within the same limits as a `runtime.yml`: at most 64 jobs, counting each matrix cell and parallel copy. Each file it includes is at most 512 KiB. Read in full, with aliases, CircleCI commands and parameters, and GitLab `extends:` and `!reference` filled in, a pipeline is at most 500,000 values. A value is a mapping, a list or a scalar, and each 64 bytes of text counts as one more. Text filled in from parameters or matrix values is at most 512 KiB. A file past a limit fails the check before any machine is made, and the error names the limit.

To take over the pipeline yourself, write a `runtime.yml`. A repository with one is checked from that file only. `runtime ci import` writes a GitHub Actions workflow or a CircleCI config as a `runtime.yml`. It needs no key and sends nothing. To keep a GitHub Actions workflow as it is, change one line, `runs-on: runtime` ([GitHub Actions](./actions)).

```bash no-run
npx withruntime ci import            # print it
npx withruntime ci import --write    # write runtime.yml
```

What the import carries over from GitHub Actions:

| From                                                                                                 | To                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A job                                                                                                | a step, run on its own machine                                                      |
| `needs:`                                                                                             | `needs:`                                                                            |
| A `strategy.matrix`, with `include` and `exclude`                                                    | a step for each Linux cell; cells that differ only in a tool's version are one step |
| `run:` steps, each in a shell of its own                                                             | one script, each in a subshell, with `set -e`                                       |
| `npm ci`, `pip install -r …`, `go mod download` and other installs of the project's own dependencies | `setup:`, run once and kept in the warm machine                                     |
| `actions/cache` keys' `hashFiles(…)`                                                                 | `cache:`                                                                            |
| `env:`                                                                                               | `env:`; a step's own as `export` lines in its subshell                              |
| `services:`                                                                                          | `docker run -d` at the start of the step                                            |
| `working-directory:`                                                                                 | a `cd`                                                                              |
| `${{ matrix.* }}`, `${{ github.sha }}`, `${{ github.ref_name }}`, `${{ env.* }}`                     | filled in, or `$RUNTIME_CI_COMMIT` and `$RUNTIME_CI_BRANCH`                         |

The import never carries over the following. Each one is named in a note at the top of the file and in the command's output. Secrets: `${{ secrets.* }}`. A value that needs a secret is left out. Nothing secret is written into the file. Marketplace actions and orbs, other than checkout, setup and cache. A `# was:` line marks where each one was. Uploads and workspaces. `if:` conditions. macOS and Windows jobs. Scheduled workflows and approval holds. `actions/checkout` and the `setup-*` actions need no step. A machine has the commit checked out, with Node, Bun, Python, git and a C compiler. Install anything else in `setup`. A service started by `docker run` has no health check. Wait for it in the step, as its health check did.

## Move from Google Cloud Build or AWS CodeBuild

CI/CD runs a `cloudbuild.yaml` or a `buildspec.yml` as it is. Make the file the repository's config path:

```bash no-run
npx withruntime ci connect acme/web --config cloudbuild.yaml
npx withruntime ci connect acme/api --config buildspec.yml
```

Or name it from one line of `runtime.yml`, next to steps of your own. `substitutions` gives what a Cloud Build trigger gives. `env` sets a buildspec's variables:

```yaml
steps:
  - cloudbuild: cloudbuild.yaml
    substitutions: { PROJECT_ID: acme-prod, _REGION: us-central1 }
  - buildspec: buildspec.yml
    env: { STAGE: test }
    needs: [cloudbuild]
```

A step that names a file takes `name`, `needs`, `timeout` and `machine` too. A file is found by its name, `cloudbuild.*` or `buildspec.*`, or else by its shape, so any path works. A repository is never switched by a file it merely holds: a `cloudbuild.yaml` that deploys keeps deploying from Cloud Build until you name it.

**Cloud Build.** Each step runs as a container of its image on the check machine's Docker, as Cloud Build runs it:

- The commit is `/workspace`. `dir` is under it. Every step shares the Docker socket, `/builder/home` and the `cloudbuild` network. So `gcr.io/cloud-builders/docker` builds, and one step reaches another's container by name.
- A step waits for every step before it, or for the ids in its `waitFor`. With `waitFor: ['-']` it starts immediately. Steps that wait for nothing run at the same time. Each output line is prefixed `Step #N - "id":`, as on Cloud Build.
- `args`, `entrypoint`, `env`, `script` (with its `#!`, or `sh`), `automapSubstitutions`, `volumes`, `timeout`, `allowFailure` and `allowExitCodes` work as on Cloud Build.
- Substitutions are Cloud Build's. `$_NAME` and `${_NAME}` come from `substitutions`, and `runtime.yml`'s values override the file's. `$$` is a literal `$`. The built-ins come from the commit: `COMMIT_SHA`, `SHORT_SHA`, `BRANCH_NAME`, `REPO_NAME` and the rest. `PROJECT_ID` comes from `runtime.yml`, else `GOOGLE_CLOUD_PROJECT`. With `options.dynamicSubstitutions`, bash expansions such as `${SHORT_SHA:0:4}` work. As on Cloud Build, any other `$NAME` fails the check before it starts, unless `substitutionOption` is `ALLOW_LOOSE`. A `_NAME` that only a trigger gives fails the same way, and the error names the line to add.
- `images` are pushed once every step passed. `artifacts.objects` are uploaded with the Google Cloud CLI. A pull request's check pushes and uploads nothing.
- The build's `timeout` applies; it defaults to 10 minutes, as on Cloud Build. `options.machineType` picks the machine: `E2_HIGHCPU_8` is `8cpu`, `E2_HIGHCPU_32` is `16cpu`, and the default is `4cpu`. `options.diskSizeGb` sets the disk. Every step's image is pulled in `setup`, so it is kept in the warm machine.

**CodeBuild.** The phases run on the check machine as root (or `run-as`), as CodeBuild runs them:

- Every command runs in one bash shell. A `cd` or an `export` holds for the commands and phases after it. `version: 0.1` runs each command in a shell of its own.
- A phase stops at its first failing command and runs its `finally`. `install` and `pre_build` stop the build when they fail. `post_build` runs after a failed `build` too, with `CODEBUILD_BUILD_SUCCEEDING=0`. `on-failure: CONTINUE` goes on to the next phase.
- `env.variables` and CodeBuild's own variables are set: `CODEBUILD_RESOLVED_SOURCE_VERSION`, `CODEBUILD_SRC_DIR`, `CODEBUILD_WEBHOOK_HEAD_REF`, `CODEBUILD_BUILD_SUCCEEDING` and the rest.
- `install.runtime-versions` installs `nodejs`, `python`, `golang`, `java` (Corretto) and `dotnet` from their makers' releases, checked by digest. `docker` is already there. Each is installed once in `setup` and kept in the warm machine.
- `cache.paths` is kept the same way. The setup also runs the install phase, so a check starts with what it left, such as `node_modules` or `~/.m2`. A change to the buildspec or to a lockfile sets the warm machine up again.
- `batch` runs a step for each build. `build-list` builds run at the same time. `build-graph` builds keep their `depend-on` order. `build-matrix` builds run for each value and buildspec. A build's `buildspec` may name another file. `compute-type` picks the machine: `SMALL` is `2cpu`, `MEDIUM` is `4cpu`, `LARGE` is `8cpu`, and `XLARGE` is `16cpu`.
- `artifacts.files` are found as CodeBuild finds them. A build whose patterns match nothing fails, as on CodeBuild.

**What does not carry over.** Each item fails the check with the file and key named, or appears as a `note:` line at the top of the job's log:

- CI/CD machines have no Google Cloud service account and no AWS service role. A Cloud Build step that calls Google Cloud fails immediately, before its image is pulled, unless the machine has `GOOGLE_APPLICATION_CREDENTIALS`. That covers the Cloud SDK images and a `docker push` to `gcr.io` or `*.pkg.dev`. When the machine has it, the credentials file is mounted in every step. A CodeBuild command that calls `aws` and fails says the machine has no AWS credentials.
- Secrets are not read from Google Secret Manager (`secretEnv`), AWS Parameter Store, or AWS Secrets Manager. A Cloud Build step with `secretEnv` fails with the secret named. A buildspec with `parameter-store` or `secrets-manager` fails before it runs.
- CI/CD stores no build artifacts. CodeBuild artifacts are found but not uploaded. Cloud Build's Maven, Python, npm and Go packages are not uploaded. Upload them from a step.
- CodeBuild `reports` and `exported-variables` are not kept. Neither is Cloud Build's `logsBucket`, private `pool` or provenance. `build-fanout` is refused. Use a `runtime.yml` step with `split:`, which spreads test files across machines by their times.
- Arm compute types run on x86_64 machines. A `buildspec` runs on CI/CD's Ubuntu machine with Docker, not on CodeBuild's image.

## A warm start

A push to the production branch runs `setup` once on a new machine. That machine is kept as a warm snapshot. The snapshot is keyed to the machine size, the setup command, and the bytes of every file the `cache` patterns match. A later check with the same key forks the snapshot. It receives only the files that differ from its commit. Nothing is cloned or installed again. No GitHub token reaches the machine. If the difference is more than 300 files or 64 MiB, the files are fetched instead. A read-only token is used for that fetch, and it is revoked before any of the repository's commands run. Only a push to the production branch seeds a warm snapshot. A pull request never does, even one from a fork's branch named `main`. A small public repository, {{ci-small-repo}}, took {{ci-small-cold}} for its first check. A pull request took {{ci-small-pull-request}} this way ({{ci-measured-on}}).

When a check's key has no warm snapshot yet, the check sets up over your repository's newest warm snapshot of the same machine. Its setup or a `cache` file changed. So only the changed parts run again. A change that breaks the setup fails its own check. If every step installs what its commit needs itself, set `steps_install: true`. Examples are `npm ci`, `bun install --frozen-lockfile`, or a build tool that fetches its own dependencies. With that setting, a change of the `cache` files alone forks the warm snapshot as it is. Its first job starts in seconds. Meanwhile, the production branch's push builds the new warm snapshot in the background. A change of `setup` itself is still set up in its check. A check that runs its setup starts its first job on that machine as soon as the setup ends. Machines for the rest of its work start from a copy of it.

A check starts each of its machines from the warm snapshot together. Each one starts in 1 to 6 seconds. Machines spread across the servers that hold the snapshot. When those servers have no room, a machine starts on any other server with room. The snapshot is copied there. A check asks for more than one machine only when its work takes longer than about 20 seconds on one. Then it takes them all before its tests start.

Warm snapshots appear in your account's snapshot list. Their storage is billed like any snapshot. CI/CD keeps only what a check can still use. That is the newest warm snapshot for the production branch's current key, plus up to two before it. When a push changes the setup, the machine size, or a `cache` file, the branch gets a new key. The old key's warm snapshots are deleted an hour later. A check that copies its machine deletes the copy when it ends. A copy left by a check that ended any other way is deleted within minutes.

Warm snapshots never fill your account's snapshot storage. A move to a new commit first deletes what earlier moves left past the two commits kept. Then it makes only as many servers' copies as fit under three quarters of your account's snapshot storage limit. The limits page lists that limit. The last quarter stays free for the checks' forks and for what else you keep. Each fork keeps a snapshot while its copies start. With no room, the warm snapshot stays at its commit, and the check's log says why. A fork refused at your account's snapshot storage limit is never waited for. Its machines are made from the warm snapshot, which keeps nothing.

## Passed before

Each test file of a split, and each other step, has a key. The key covers the machine, the warm key, its command, its env, and the contents of every file it reads. A test file reads itself and everything it reads. A step reads its `inputs` and everything they read. It also reads the files its `run` names and everything they read. If it names no `inputs`, it reads every file. A step that only builds its `inputs` says `compiles: true`. Examples are a compiler, its lints, or its doc tests. Such a step reads what compiling them reads. For Rust, that means its sources and manifests, its path dependencies, Cargo's and the toolchain's files at the root, and what it includes (`include_str!`, `include_bytes!`, `#[path]`). It also reads a path that a macro or attribute may read while it compiles, such as `sqlx::migrate!("migrations")` or `#[template(path = "page.html")]`. It never reads a path the code only names, such as a test's fixture, a constant, or a `[package.metadata]` list. The program reads those when it runs, so they key the crate's tests and not its build. It never reads the root's other files, such as a README. It never reads what a script a crate ships imports. Only that crate's tests run those scripts. `env::var("RUNTIME_CI_BASE")` is read when the program runs, so it does not key the build. `env!` and `option_env!` are read by the compiler, so they do. A crate's tests read its own `tests/`, `benches/` and `examples/` files. They never read those of the crates it depends on. What runs while a crate compiles is read whole. That covers its build script and any procedural macro. It also covers every script they run and what those import, plus the commits of the check they read. A step whose code reads what its check is against (`RUNTIME_CI_BASE`, to pick its work since its base) is keyed in a pull request. The key uses those files at its base and at its head. It also uses any file the change deletes. So pull requests that leave its files alone share its key. A key that passed before stands in for it. A pass on the production branch stands in for any check of the repository. A pull request's pass stands for any pull request of the repository, if its author has write access. An approved outside contributor's pass stands only in that pull request. A pull request's pass never stands for the production branch. A key that passed before is not run again. A job whose every file passed before is `cached` in the console and the API. It runs on no machine. On GitHub, it counts toward the check's one `runtime` run. A job's log names each file that passed before and the job it passed in.

A pull request's check runs only what its change can reach. Each test file
and step is also keyed at the pull request's base, by the base's own files;
one whose key is the same at the base and at the head reads exactly what the
base holds, so the change cannot affect it, and the production branch's own
check runs it. This holds even while the production branch's check of that
base is still running: a pull request never runs again what landed before it.
A file the change deletes keeps everything that read it at the base. A step
that a running step `needs` keeps all its targets, and a gate or an agent
step is always run. What is left is listed on one job, `left to main`,
which is `skipped` in the console and the API and passes the check; because
of it, the production branch never stands on that check's whole pass and
runs those targets itself. `left to main` and `nothing reached` are the names
of jobs CI/CD adds itself: a config that gives either name to a step or
deploy is rejected.

Nothing is left to the production branch when the pull request changes its
config file or a file in `cache:`. A file that `setup` reads, such as a script
it runs, counts only when the check's machines are set up from the pull
request's own files. When a warm snapshot of the same `setup` and `cache:` is
ready, the check's machines are forks of it, set up from the production
branch's files, and the change's own copy of that file never runs on them.

### Test only what a pull request touches

By default, a pull request runs every test its change reaches, in every package and crate that reads it. To land pull requests sooner, set `tests: touched` in the production branch's file:

```yaml
pull_requests:
  tests: touched
```

A pull request into the production branch then runs only the tests of the packages and crates that hold its changed files. A package is the folder of the nearest `package.json` above a file, and a crate the folder of the nearest `Cargo.toml`. A file in neither belongs to its top-level folder. A step with `inputs` runs when the pull request changes one of its inputs. A step without `inputs` or `split` reads every file, so it runs as before, and so does a step with `reuse: false`. The other tests the change reaches are listed on the `left to main` job. The production branch's check runs them after the pull request merges.

A pull request runs every test its change reaches when it changes any of these files, because they configure every package:

- a file at the repository's root, other than Markdown;
- a file under any folder whose name starts with a dot;
- a lockfile or toolchain file in any folder (`Cargo.lock`, `rust-toolchain.toml`, `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`);
- the config file itself.

A step whose `run` names a file the pull request changes runs all its targets that the change reaches. This also applies when the changed file is one the named file reads, such as the script a split step runs its test files with. A split step also runs all its reached targets when the pull request changes a `generated:` program.

A failure that a pull request's check did not run appears in the production branch's check after the merge. Turn on [undo](#undo-a-failing-production-branch) with this setting: CI/CD then finds the commit that broke the branch and reverts it by itself. The default, `tests: reached`, runs every test a change reaches before it merges.

### Generated files

A file that your setup or a step writes from the repository's own sources, such as a generated client, a docs catalogue or a schema dump, is best built where it is used and listed in `.gitignore`, not committed. List it under `generated:` with the program that writes it. A test that imports it is then keyed by that program and by everything the program reads:

```yaml
generated:
  - paths: [src/catalogue.json, src/legal.json]
    by: scripts/catalogue.ts
setup: |
  bun install --frozen-lockfile
  bun scripts/catalogue.ts
```

A change to a source that the program reads runs those tests again instead of reusing their earlier pass. Each path and `by` is a file's path from the repository's root, with no pattern. A file holds up to 32 entries of up to 32 paths each. Without an entry, a test that imports a file git does not hold is keyed without it, so a change to its sources alone can reuse a pass of the old contents.

## Hot spots

A hot spot is a place in a file that many changes edit: the line under a changelog's newest date, the end of an index that every migration appends to, or a generated file that every change to its sources writes again. Any two pull requests that are open at the same time and both edit it conflict there, so one of them must be merged again and checked again. The `hot-spots` built-in fails a pull request that edits one:

```yaml
steps:
  - name: hot spots
    inline: { kind: hot-spots } # optional: merges: 64, most: 5
```

The place of an edit is found from the lines around it, not from its line number, which every edit above it moves. It is the nearest line above the edit and the nearest line below it that are unique in the file and have at least three letters or digits, or the file's start or end, within 20 lines. Each of the production branch's last `merges` first-parent commits (default 64) that edited the file is read the same way. An edit that meets more than `most` of them (default 5) on either side fails the step. The failure names the file, the line, the place (`below "## 25 October 2026"`) and how many of the merges edited there. A file that the change adds or deletes passes, because deleting a file is how a hot file goes away. On Runtime's own repository, over a week of 1,100 merges, six places took 6 to 20 of every 64 merges, and no other place took more than 4.

The step also fails a pull request that adds a file that `.gitattributes` marks `linguist-generated` or gives a merge driver (`merge=` other than `binary`), and one that adds a line to `.gitattributes` that gives any file a merge driver. A file that needs a merge driver is a file that most changes edit. To fix a hot spot, give each change a file of its own (for example, one file per changelog entry, combined when the project builds), or build the file where it is used ([generated files](#generated-files)). The step reads the history that the check fetches, 64 commits from each tip. A shallower history measures what it holds, and the step reports how many merges it read.

## Rust build cache

In a repository with a `Cargo.lock`, every check machine compiles through CI/CD's build cache. Cargo runs rustc through `runtime-build-cache` (`RUSTC_WRAPPER`). The wrapper keeps what each compile made. It restores that output when the same compile is requested again. This works on any machine of any check in the repository. A crate is compiled once. Every later check, pull request, and machine gets its output instead.

- **What makes a compile the same:** these must match. The toolchain (`rustc -vV`). The folder it runs in. Every argument: target, flags, features, and profile. The variables cargo sets for the crate. The bytes of every crate it is compiled against. Those crates carry their own dependencies' hashes. The native libraries it links. Every source file rustc read. Every variable `env!` read, kept as a hash and never as its value. Every file and variable the crate's build script names with `cargo:rerun-if-changed` and `cargo:rerun-if-env-changed`. For a binary, test, or proc macro, the linker's version too. Change any of them, and it compiles again.
- **Any folder:** paths count by their place in the build, not by the machine's folders. The repository, the target folder, `CARGO_HOME` and `RUSTUP_HOME` are each keyed by name. So a crate compiled in `/workspace/app` is found from `/home/runner/work/app/app`. The registry can be anywhere. Restored output names this machine's folders, so cargo treats it as fresh. A crate that reads its own folder with `env!("CARGO_MANIFEST_DIR")`, such as a test that finds its files, is found only in the same folder. So is every crate built on it. A build script's `OUT_DIR` counts by name. Our engines' test build: 736 compiles on 4 vCPU. From nothing, it took 215 s. In another folder, from the cache, it took 82 s. 576 were found. The rest stand on a crate that reads its own folder. Measured 23 October 2026.
- **Why a compile missed:** set `RUNTIME_BUILD_CACHE_EXPLAIN=1`. Each compile's key is then written field by field to `explain/<crate>-<key>` in the cache's folder (`/workspace/.runtime-build-cache` on a check's machine). Compare two machines' files to see what differed.
- **Where it is kept:** on each machine. A warm snapshot carries it to every check. It is also kept in the repository's store. The store is one sandbox of your account. It is named `build-cache-<key>-<id>` and labelled `runtime-ci-build-cache`. The first check that needs it makes it (2 vCPU, 2 GiB, a 32 GiB disk). The store is served through a preview. So it moves at most a preview's daily bytes and rate. A repository whose checks move more can set `build_cache: { shards: N }` in `runtime.yml`, up to 16. Its store is then N such sandboxes. Each keeps the entries whose keys fall to it. That gives N times the room, bytes a day, and speed. It also wakes N sandboxes for every check. CI/CD records which sandboxes it made, using a secret of its own. It uses only those. Another sandbox that takes the name or the label is never part of the store. Neither is one that a laptop or another CI's first compile made. Nor is a store from before CI/CD kept this record. Your checks compile into a new store once. An old store that no check wakes is deleted after 14 days paused. Or delete it yourself. Stores pause when no check uses them, and are billed like any sandbox. If you delete one, the next check makes a new, empty one in its place. A changed count finds nothing kept under the old count until it is compiled again. When a disk fills, the least used entries go first. A store belongs to one repository. Nothing in it is shared with another repository or account.
- **Who reads what:** a push to the production branch writes the repository's entries. A pull request reads those entries and its own. It writes only its own entries. It never sees another pull request's entries. A pull request from a fork reads no store at all. The production branch's compiles can hold values from its secrets (`option_env!`). Each check's machines get a grant that says so. CI/CD signs the grant, and the store checks it. A setup reads the production branch's entries alone. It writes them only for a push to the production branch. That is its own code, as its steps are. A gate runs without the cache. So nothing a pull request's code wrote reaches a setup or a gate. The grant is kept in a file that only its user can read. It is never in a step's command.
- **On your private network:** check machines reach the store through its private previews. If your organization's private network is on, a repository can have them reach the store there first. They reach it by each sandbox's id, through the previews behind it:

  ```yaml
  build_cache:
    private_network: true
  ```

  It is off by default. A check's compiles open many connections at the same time. Those count toward the same private network limits as your own sandboxes' connections to each other. When the private network refuses one, that machine uses the sandbox's preview for a minute.

- **From any machine:** a laptop or another CI's Linux x86-64 machine reads the same store with one line. Download the wrapper once with your key. Its SHA-256 is in the `x-content-sha256` header. Then build as usual:

  ```sh
  curl -fsSo ~/.cargo/bin/runtime-build-cache \
    -H "Authorization: Bearer $RUNTIME_API_KEY" \
    https://api.withruntime.com/v1/ci/build-cache/wrapper
  chmod +x ~/.cargo/bin/runtime-build-cache
  RUSTC_WRAPPER=runtime-build-cache cargo test
  ```

  Or set it once in `~/.cargo/config.toml` (`[build] rustc-wrapper =
"runtime-build-cache"`). Use `RUNTIME_API_KEY` as the key, or the key that `npx withruntime login` keeps. The repository is found from the folder's git `origin`. `RUNTIME_BUILD_CACHE_REPOSITORY` names it directly. The store belongs to your account. The first compile makes it when none exists. Such a machine reads what your production branch's checks compiled. It writes its own layer, named by its key. No check, pull request, or other key reads what it wrote. An agent's own key (one a key made) also downloads the wrapper. A production branch's push on another CI writes the branch's entries when `RUNTIME_BUILD_CACHE_WRITE=main` is set. The machine keeps its local cache in `~/.cache/runtime-build-cache` (`RUNTIME_BUILD_CACHE_DIR`). When the store cannot be reached, compiles run as they would without it. `RUNTIME_BUILD_CACHE_SESSION=off` keeps the cache to the machine's own folder.

- **Its room on a machine:** the machine's folder holds at most 15% of the disk. The entries used longest ago go first. It never fills the last quarter, which is at least 4 GiB. That quarter is for the build.
- **Turning it off:** set `RUSTC_WRAPPER: ""` in a step's `env`. Or use your own wrapper, such as sccache, which takes its place. A wrapper that your cargo config names (`build.rustc-wrapper` in a `.cargo/config.toml`) is left alone. The cache then stays off.
- **What it can't see:** files that a proc macro reads without telling rustc or the crate's build script. Name such files with `cargo:rerun-if-changed` in a build script, as sqlx asks for its migrations. Or turn the cache off for that step.
- **Any file, by its hash:** a step can keep a file it built in the same store. A later step or check can read it back. `runtime-build-cache put <file>...` stores each file under its own SHA-256. It prints `<sha256> <bytes> <file>`. `runtime-build-cache get <sha256> <file>` writes the file back. It fails unless the bytes hash to that key. So the reader trusts the key it was given, never the store. Each file is 1 GiB at most. Files are written where the check's compiles are. The production branch and your repository's writers write to the layer that every check reads. A pull request from anyone else writes to a layer only it reads.

`runtime-build-cache build` builds a workspace once for every crate's check. It builds the test binaries (`cargo test --workspace --no-run`), the lints, and the doc tests of the libraries that have any. `runtime-build-cache test` then checks one crate as a task of a split. It checks the format and runs the crate's own test binaries from that one build. So a task compiles nothing the build made. It only runs tests. A crate with a workspace of its own is checked whole from its folder. That covers format, lints, tests, and doc tests. A format difference, and every style lint, warns. These appear as `::warning::` lines in the check's summary: a count first, by lint, then the first few. They fail nothing. Clippy runs with `-D clippy::correctness -D clippy::suspicious -D unused_must_use`, never `-D warnings`. So only what is wrong fails the crate, not how it is written:

```yaml
steps:
  - name: crates build
    run: /workspace/.runtime-build-cache/runtime-build-cache build
  - name: crates
    run: /workspace/.runtime-build-cache/runtime-build-cache test {files}
    split: { files: "crates/*/Cargo.toml" }
    needs: [crates build]
```

A build on a clean tree keeps its commit in `target/.built-at`. A later build on that target folder looks only at the files that differ from that commit. Put the build in your `setup` too, so every fork starts with it:

```yaml
setup: |
  /workspace/.runtime-build-cache/runtime-build-cache build
```

Lints are kept the same way compiles are. Clippy's version, its `CLIPPY_ARGS`, and every `clippy.toml` it looks for are part of the key. What it printed is printed again. Until 23 October 2026, each crate's task built it alone (`-p <name>`). Cargo then gives each dependency only that crate's features. So the tasks of our 82-crate workspace held 13 feature sets of tokio. They compiled the same dependencies again and again. `runtime-build-cache warm <Cargo.toml>...` builds what those manifests' tasks will need. It runs nothing. It builds the workspace's one test build for its members. For a crate with a workspace of its own, it builds lints and test binaries.

## Flaky tests

Every run of every test file is kept, keyed by commit and content. A failed file runs again alone. It runs on another machine when one is free. A file that both passed and failed under the same key is flaky. The job says it passed with flaky tests and names them. It never passes silently.

- **Proven on the production branch.** Only a run of a commit pushed to the production branch proves a flake. A pull request's own flaky run still fails its check. A change cannot quiet a test it touches.
- **Quarantined immediately.** The test still runs and reports in every check. Its failures no longer fail a check. Files matched by `quarantine: {
protected: [...] }` stay gating. So does the last test of an area (`quarantine: { areas: {...} }`). More than 3 flaky files in one job still fail it. `quarantine: false` turns all of this off.
- **Handed to an owner.** The owner comes from your `CODEOWNERS` file, using the last matching rule. If no rule matches, the owner is the author of the pull request that last changed the file. The owner has 48 hours to fix the test or delete it with a reason. After 48 hours, it shows as overdue.
- **Ended by 100 passes.** At the production branch's next commit after a change to the file, the test runs 100 times in parallel forks. When all 100 pass, it is fixed and gates again. One failure keeps it quarantined. The old `quarantine: { clean_runs: N }` setting is no longer accepted. Remove it. Otherwise every check fails with an error that names it.
- **New and changed tests run 20 times.** A pull request's new or changed test file runs 20 times in parallel forks. One failure fails the check. So a flaky test is caught before it lands.
- **No timing bars.** Every check command gets `RUNTIME_CI_TIMING=skip`. When it is set, skip assertions on speed or latency. Those belong on the hosts you measure on, not in a check.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const open = await runtime.ci.flakes.list();
for (const flake of open.data) {
  console.log(flake.file, flake.state, flake.owner?.login, flake.overdue);
  const { runs, failures } = await runtime.ci.flakes.get(flake.id);
  console.log(
    runs.length,
    failures.map((f) => f.jobId),
  );
}
```

```bash no-run
npx withruntime ci flakes                       # open flaky tests and their owners
npx withruntime ci flake <flakeId>              # its proof, owner and runs
npx withruntime ci flake hand <flakeId> octocat # hand it to someone else
npx withruntime ci flake prove <flakeId>        # its 100 runs at the next commit
npx withruntime ci flake delete <flakeId> --reason "covered by e2e"
```

## Failures main already has

A pull request's check can judge only what the pull request breaks. When your production branch is red, every pull request would fail on the same broken tests. That includes the pull requests that fix them.

Turn it on for a split test step with `over_main: true`:

```yaml
steps:
  - name: test
    run: bun test {files}
    split: { files: "**/*.test.ts" }
    over_main: true
```

When this is on, a part of that step that fails on a pull request is named as main's failure. It is named that way only when every test file that failed there also failed on your production branch's own check. That check must be at the pull request's base or a newer commit of the branch. The newest of those checks that ran the file decides. When every failed job is main's, the check still fails. Its title is "Failed only where main fails too". It names each such job and the commit where main failed it. This is never a pass. So no branch rule, auto-merge, or merge queue merges a change past main's failures. Check it again once main passes. When the pull request breaks something of its own, the check names those failures first. It names main's failures apart from them. Anything else belongs to the change, as it always did:

- **Only your production branch turns it on.** `over_main` counts only when the production branch's own file has the same step with the same setting. A pull request cannot add it. It also cannot keep it on a step the pull request changed.
- **Test files only.** Only a split step that is reused can use it. It is judged file by file. A step run whole is never main's. Its exit names no file. So a new failure beside main's would look the same. [Gates](#gates), [agent steps](#agent-steps), deploys, and steps with `reuse: false` are never main's either.
- **One more failing file: it fails.** A test file that passes on the production branch and fails on the pull request always belongs to the change.
- **Main's verdict unknown: it fails.** If main's check of the base is still running, never ran the file, or does not exist, the pull request fails.
- **The same failure.** A part that ran past its time limit, or could not start, fails the check. The files it never finished may belong to the change.
- **Fixes are named.** When a job or test file that main fails passes on the pull request, the check's run says the change fixes it.

Your production branch's own checks are never judged this way. Main stays red until a fix lands. Nothing it gates releases before then.

## Main is checked after merges, in batches

A merge never waits for a check. Your production branch's checks run as a pipeline. One check sets up at a time. The next check starts on the newest commit as soon as the one before begins its tests. So a verdict comes every setup's length, not every whole check's length. Nothing cancels a check once it starts, however many merges land meanwhile. Merges that land while one sets up wait together for the next check. That check covers every one of them. A pass covers every commit up to the one it checked. A release only moves forward. An older check that passes late never moves it back. A branch whose config has `deploy:` entries runs one check at a time. So its deploys go out in commit order.

Overlapping checks of main never run the same job twice. A newer check may plan a job whose files an older check of main is running right now. The key is the same: the same bytes of everything it reads. The newer check waits for that run instead of starting its own. When the older run ends, the newer check uses what passed. It runs only what did not pass. So several checks at the same time cost about one check, plus what each newer commit changed. A job waits at most 20 minutes before it runs its files itself.

## GitHub's merge queue

Turn on GitHub's merge queue for your production branch, and require the `runtime` check in the branch's rule. Set the queue's merge method to **Merge commit**. Each group that GitHub makes is then checked as one commit: your production branch with the queued pull requests merged in. The `runtime` check run is posted on the group's commit, and GitHub merges the group when it passes. When GitHub drops a group, because a pull request left the queue or one ahead of it did, its check is cancelled immediately and its machines are deleted. GitHub's merge of a group whose check passed is checked as your production branch's push, as every merge is.

A group's check starts from your production branch's warm machine. Each job that passed before on the same files is not run again, whether it passed in the pull request's own check or in your production branch's ([passed before](#passed-before)). A group of one pull request holds the same files as that pull request's own check, whose files are its merge into the same base. So when the pull request passed on the newest production branch, and that branch's check of its base passed, its group runs no job again. Only the jobs whose files the group changed run, such as the jobs that read the files of a pull request ahead of it.

A group runs only code from the repository's own people, as a pull request does ([whose code runs](#whose-code-runs)). CI/CD reads from GitHub the commits the group stacked on its base. Each one must merge a pull request's head, and each head must be a commit that a check of a pull request from one of the repository's own branches ran as code from the repository's own people. The last one must be the pull request that GitHub names in the group's branch (`gh-readonly-queue/main/pr-<number>-<commit>`). Otherwise the group waits unrun. Its `runtime` check run concludes `action_required` and says why. A group made by squash or rebase always waits this way, because none of its commits is a head that a check ran. The group's base must also be known to hold only such code: a commit of your production branch that CI/CD checked as a push, or a group that runs. Until it is, or until a head the group merged has been checked, the group waits and GitHub is told nothing. It starts as soon as that is known, in whatever order GitHub's events arrive. A group that waits for room under your account's `check` count starts when another check ends. So before you turn on the merge queue, let CI/CD check your production branch's newest commit, which any push or merge does. A fork's pull request never runs through the merge queue. To merge one, push its commit to a branch of the repository and queue that pull request.

Runtime's GitHub App reads the merge queue with the **Merge queues** permission. If your installation predates it, an owner of the GitHub account accepts the new permission once, on the installation's settings page on GitHub.

In the console, the API, the SDKs and the CLI, a group's check has the event `merge_group`. Its `branch` is the group's branch, its `pullRequest` is the pull request GitHub names, and its `baseCommit` is the commit the group was merged onto. To list a repository's merge queue checks, filter by `event`:

```bash no-run
curl "https://api.withruntime.com/v1/ci/checks?repositoryId=${REPOSITORY_ID}&event=merge_group" \
  -H "authorization: Bearer $RUNTIME_API_KEY"
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const groups = await runtime.ci.checks.list({ event: ["merge_group"], limit: 20 });
for (const check of groups.data) console.log(check.branch, check.pullRequest, check.state);
```

```bash no-run
npx withruntime ci checks --event merge_group
```

## Undo a failing production branch

Turn this on, and a failing production branch fixes itself. When main's check fails, CI/CD runs the failing jobs again on the commits since main last passed. It runs at most 64 in parallel. Each round narrows the range. So 240 commits take two rounds. CI/CD names the first commit where they fail, if the commit before it passes them. Then it opens a pull request in your repository. That pull request reverts only that commit and keeps the rest. The revert merges by itself once its own check passes. The author of the culprit commit is told why on their pull request. The message includes a link to the failing check.

It is off until an owner or admin turns it on for the repository. Use the CI/CD page of the console, the command `runtime ci repos undo owner/name on`, or the API:

```bash no-run
curl -X POST "https://api.withruntime.com/v1/ci/repositories/${REPOSITORY_ID}:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: undo-culprits-on" \
  -d '{"undoCulprits": true}'
```

In the SDKs, the call is `ci.repositories.setUndo(id, true)` (TypeScript and Java), `ci.repositories.set_undo(id, True)` (Python and Ruby), and `CI.Repositories.SetUndo(ctx, id, true)` (Go). Every repository's response includes `undoCulprits`.

Nothing is reverted when the evidence is unclear. That covers a failure that passes when run again. It also covers a failure that main's last pass also fails. And a failure that passes again on a later commit. A commit that added a database migration is never reverted. A file that a later commit changed again is not reverted either. A person fixes those cases.

## What GitHub shows

Each check has a check run named `runtime`. A branch rule requires this run. It shows as in progress while the check runs. Then it shows the conclusion. The run links to the check in the console, where every job and its log appear. A failed check's run names each failed job. It shows the job's log's last line and a link to that job. A pull request's run also names the jobs that failed the same way on your production branch. These are listed apart from its own jobs ([failures main already has](#failures-main-already-has)).

Each job also has a check run of its own, named `runtime / <job>`: for example `runtime / lint`, or `runtime / test (2/4)` for the second of four parts of a split step. Each cell of a matrix is a step, so each has its own run too. A job's run appears when the job ends, already completed, and shows:

- the job's conclusion: success, failure, timed out, skipped (a job whose `needs` did not pass), or cancelled;
- when the job started and how long it took;
- its exit code, and a link to the job and its log in the console;
- annotations: the lines of your files that the job's log reports. They are marked on the run's page and on the pull request's changed files, as GitHub Actions marks them.

GitHub is never sent what a job's log says. Anyone who can read the repository can read its check runs, and anyone at all on a public repository. A log can hold what its steps print, such as a secret from the job's environment. So a job's run holds no log text and no words taken from the log. Each annotation gives its file, line, level and a tool's fixed code (such as `error[E0308]`, `TS2322` or `AssertionError`), and links to the console for what the log says there. The console and the API show the log and each annotation's message to your account's members only. A review step's findings stay in the console too: its run says only whether it passed.

Annotations are read from GitHub Actions workflow commands (`::error file=src/app.ts,line=12::message`, `::warning` and `::notice`), Rust compiler errors and warnings and test panics, TypeScript (`tsc`) errors, `path:line:column: message` lines from compilers and linters, ESLint's default output, failed JavaScript tests (Bun, Jest, Vitest and Node) at their first stack frame in your repository, Python tracebacks, and Go test failures. Only paths of files in the checked commit are annotated, never a dependency's. A failed test file with no line recognized in its output is annotated on its first line. A job's run carries at most 50 annotations, failures first. A job that passed shows only its warnings and notices.

A branch rule requires `runtime`, never a job's run: the jobs of a check change with what each change reaches. A job reused from an earlier pass ([passed before](#passed-before)) has no run of its own. The `runtime` run says how much time reused passes saved. **Re-run** on any of a check's runs on GitHub checks the commit again. Jobs whose passes still stand are reused, so only the others run again.

Each job in the API has `githubCheckRun`, the ID of its run, and `annotations`, the lines its run marks, with what the log says of each: `path`, `startLine`, `endLine`, `startColumn` (single lines only), `level` (`notice`, `warning` or `failure`), `message` and `title`. `runtime ci logs <jobId>` prints them after the log, and the job's page in the console lists them, each opening the file at that line on GitHub.

GitHub is told about a check only when its state changes, and about each job once, when it ends. So a check of 40 jobs uses at most 42 calls of your installation's hourly GitHub budget, not hundreds. A job's run is created only while more than half of the hour's budget is left. Job runs never slow a check's reads of your repository or hold back its `runtime` run. A job's run that the budget held back is not created later. The `runtime` run, the console and the API still show that job. GitHub is told what CI/CD's own record says. CI/CD never reads a check back from GitHub. Every read of GitHub is conditional. A read that has not changed costs nothing from the budget. When the budget runs low, telling GitHub waits first. So the rest of the hour goes to checking. A verdict never waits on GitHub's view. GitHub hears the end once the hour resets. Your checks, jobs, and logs are always current in the console, the API, the SDKs, and the CLI.

## Read checks, jobs and logs

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const page = await runtime.ci.checks.list({ state: ["failed"], limit: 10 });
for (const check of page.data) {
  console.log(check.repository, check.commit.slice(0, 12), check.state, check.counts);
  const { jobs } = await runtime.ci.checks.get(check.id);
  for (const job of jobs.filter((j) => j.state === "failed")) {
    const { log, sandboxIds } = await runtime.ci.jobs.get(job.id);
    console.log(job.name, job.exitCode, log.slice(-2000), sandboxIds);
  }
}
```

```bash no-run
npx withruntime ci checks --commit $(git rev-parse HEAD)
npx withruntime ci check <checkId>
npx withruntime ci cancel <checkId>
npx withruntime ci rerun <checkId>
npx withruntime ci logs <jobId>
npx withruntime ci tests <repoId> --quarantined
```

- **Checks** list newest first, filtered by `repositoryId`, `branch`,
  `commit` (a full SHA), `pullRequest` or `state` (`queued`, `running`,
  `passed`, `failed`, `cancelled`). `waiting` is true for a check that waits
  for a writer's approval. `counts` holds how many of its jobs are in each
  state. `machines` says how many machines it ran on and how soon:
  `created` (each from the warm snapshot), `firstMs` to its first machine,
  `firstTestMs` to its first test, and `lineMs` waiting in the account's
  line. `reused`, `pooled`, `forked`, `forks` and `kept` are 0 for every check
  since 23 October 2026 (older checks woke or kept machines between checks).
- **Where a check's machines come from.** First the ones it is done with
  from its earlier steps, then the rest all started from the warm snapshot
  at once, on any server with room; every one is deleted when the check ends
  ([A check's machines](#a-checks-machines)). An
  account's checks start at most 2 machines a second (100 at once) and hold
  at most 256, counted across all of them (a `runtime-ci` run by hand counts
  its own): past that, or when a region has no room, a check waits in line with
  the reason on its jobs. It never fails for want of room, a gate's machine
  neither. A check takes its machines whole: while the account has room for
  all a check asks, past what the checks ahead of it wait for, it takes them
  at once. Short of room, one check of the account takes machines at a time,
  and the others wait in line holding none, so no two checks each hold part
  of what they need and wait on each other. A check
  starts once it has all it asked for, or, when no more came for 20 seconds,
  on those it has, and then runs on those alone. A check with little work
  left goes first: at most 5 minutes of machine time in all, no task over 2
  minutes, by each test file's recorded time (counted once for each time it
  runs) and each other step's 99th-percentile time. A check with any test
  file or step that has no recorded time does not count as short.
  It takes whatever room is free rather than all at once, and the account's
  other checks, a push to the production branch included, each hand it a
  machine as soon as their running task ends, so a short job never waits
  behind a long one. Then a push to the production
  branch, then the checks already running, then a pull request
  whose merge waits on its check, then the newest. It holds as many machines
  as it has jobs ready, up to the account's 256.
- **Cancel a check** that is queued or running with
  `POST /v1/ci/checks/{id}:cancel` (`runtime.ci.checks.cancel(id)`): its
  running jobs are cancelled and its queued ones skipped, its machines are
  let go within seconds, and GitHub shows its check run as cancelled. A check
  that has ended is answered as it is, so a second cancel is no error. An
  account-wide key, or an owner's or admin's full key, cancels any of the
  account's checks, and any other key those of repositories its own agent
  connected. A key that cancels a check it does not read (below) is answered
  with the check's `id` and `state` alone, nothing of its jobs or logs.
- **Run a check again** with `POST /v1/ci/checks/{id}:rerun`
  (`runtime.ci.checks.rerun(id)`), as GitHub's Re-run does, from code: a new
  check of the same commit, and for a pull request, of its head as it would
  land now, on its base branch's newest commit. GitHub shows it as the
  commit's newest `runtime` run. It is trusted only as the commit's last check
  was, so it never runs an outside contributor's code that waits for a
  writer's approval, and a check of that commit still going is answered as it
  is. The same keys may as cancel, and it takes a key that may create
  sandboxes.
- **A job** is `queued`, `running`, `passed`, `failed`, `flaky` (its only
  failures were in quarantined files), `cached` (its content key passed
  before, in `cachedFrom`), `cancelled` or `skipped`. Its `log` is its output,
  at most the last 256 KiB. A failed file's output is kept whole when it is
  short; when it is long, the log keeps its first error, every line that says
  a test failed (`panicked`, `FAILED`, `error[`) with the lines around it,
  and its end, in the order written, saying how many lines each gap holds.
  A key an owner or admin made account-wide, and a read-only (`read:*`)
  key, reads every check, job, log, test file and flake of the account,
  whichever key connected the repository; any other key reads those of
  repositories its own agent connected. A read of one repository the key
  lists but may not read (an owner's key that is not account-wide, say) is
  refused with 403 and the repository's name, never answered with an empty page, and a check or job
  it may not read answers 404 naming the repositories it lists and reads
  nothing of. To read them all, switch the key to account-wide on the
  API keys page (an owner or admin, signed in); `GET /v1/keys` shows each
  key's reach.
- **A failed job's sandbox may be kept paused.** Its `sandboxIds` are your
  own sandboxes: wake one and look around where it failed with
  `runtime sandboxes wake <id>` and `runtime sandboxes shell <id>`, or the
  sandbox API.
- **Test files** keep their recent time, which splits a step's files into
  even parts, and their last 20 outcomes. A file whose failures no longer
  fail a check is quarantined since `quarantinedSince`.

## Follow a release

For a repository whose releases CI/CD runs, each step of a release is kept as it is taken. Each step is one line. The lines cover a migration's copy test, when it begins and when it passes or fails (with the migration). They also cover its apply, each deploy ref moved, and each server's canary and release. They include the website's deploy and promote. And every wait, with its reason. The console's **CI/CD → Releases** shows each release's steps as they happen. The newest come first. A waiting step shows in red. The API, the SDKs, and the MCP tool show the same steps.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const steps = await runtime.ci.releases.list({ commit: "a6049bf5a", limit: 100 });
for (const step of steps.data.reverse()) {
  console.log(new Date(step.at).toISOString(), step.source, step.host ?? "", step.line);
}
```

```bash no-run
npx withruntime ci releases --commit a6049bf5a
```

A step's `source` is who took it: `mover`, or the deploy target that walked it. `host` is the server it ran on, or null. A step never holds a release up. A step that cannot be kept is logged, and the release goes on.

## API

| Route                             | What it does                                              |
| --------------------------------- | --------------------------------------------------------- |
| `POST /v1/ci/repositories`        | Connect a GitHub repository; only a full key connects one |
| `GET /v1/ci/repositories`         | Connected repositories, oldest first                      |
| `DELETE /v1/ci/repositories/{id}` | Disconnect; its checks still going are cancelled          |
| `GET /v1/ci/checks`               | Checks, newest first                                      |
| `GET /v1/ci/checks/{id}`          | A check and its jobs in plan order                        |
| `POST /v1/ci/checks/{id}:cancel`  | Cancel a queued or running check; its machines let go     |
| `POST /v1/ci/checks/{id}:rerun`   | Run a check again: a new check of its commit              |
| `GET /v1/ci/jobs/{id}`            | A job with its log and its sandboxes                      |
| `GET /v1/ci/tests`                | A repository's test files and their quarantine            |
| `GET /v1/ci/flakes`               | Flaky tests, newest first; the open ones unless `state`   |
| `GET /v1/ci/flakes/{id}`          | A flaky test with its runs and the jobs it failed in      |
| `POST /v1/ci/flakes/{id}:update`  | `prove`, hand it to an `owner`, or a `deleteReason`       |
| `GET /v1/ci/releases`             | A release's steps as taken, newest first; by `commit`     |

The MCP tools are `runtime_ci`, with these actions: `checks`, `check`, `job`, `tests`, `flakes`, `flake`, `flake_update`, `releases`, `check_cancel`, `check_rerun`, `repositories`, `connect` and `disconnect`. A key reads only the checks of repositories its own agent connected. This does not apply to an account-wide key or a read-only key.

## Price and limits

A check has no machine to run on when a region is full, or when its machines fail to start. It waits for one and asks again. The pause between asks grows to 2 minutes. Its jobs show "Waiting" and the reason. A check never fails because the platform lacks machines. It runs once machines come. It ends when it is cancelled, when a newer push replaces it, or when its `timeout:` passes. A timeout fails it and says how long it waited.

When machines are short, checks are ordered by their account's lane. Sandboxes work the same way ([waiting in line for room](./limits#waiting-in-line-for-room)). A higher lane's checks are taken first and get machines first. A waiting job says where it stands. For example: `short of room: waiting for room, 1 ahead (pro 1); this lane is free`. An account's waiting checks can hold lower lanes back for three minutes at most in any fifteen minutes. That applies only while the region is short of room for everyone. It does not apply while the account is at its own share. Inside an account, a push to the production branch gets machines before its pull requests.

Every account gets its fair share of the checks running at the same time. This holds however many pull requests another account opens. Each account's first check is taken before any account's next check. While all are taken, a check makes way if its account holds more than its share and the check runs no job. A check runs no job while it waits for machines or between steps. It is taken again in its turn. Its finished jobs are kept. A check of a lower lane makes way for a higher lane's check, whatever it holds.

A check machine is billed at **{{ci-vcpu-minute}} per vCPU-minute**. It has {{ci-gib-per-vcpu}} of memory per vCPU. Billing is by the second ([pricing](./pricing#ci-cd)). The default, `4cpu`, is 4 vCPU and 16 GiB. At {{ci-4vcpu-minute}} a minute, it costs that much per minute. Every machine of a check is deleted when the check ends, whatever happened ([A check's machines](#a-checks-machines)). So nothing is billed between checks. CI/CD opens to an account once Runtime sets its limits ([limits](./limits)).
