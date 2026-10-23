---
launch: ci
---

# CI/CD

Connect a GitHub repository and every push and pull request is checked on
machines of your own account, each check reported to GitHub as one check run.
There's no runner to set up and no config file to write: Runtime finds the
steps of the repository. Each check starts from a warm machine that already
holds your dependencies, so a pull request runs only its tests, never the
install. Our own repository's pull requests ({{ci-ours-test-files}} test
files) took {{ci-ours-pull-request}} here, where they took {{ci-ours-before}} before, and
{{ci-ours-again}} checked again: {{ci-ours-saved}} back on every one.

## Connect a repository

Install Runtime's GitHub App on the GitHub account that holds the repository:
`POST /v1/repositories/github:install` answers a link to open in a browser
within 15 minutes. Then connect the repository with a full key, since every
push runs its code for the whole account:

```bash no-run
curl https://api.withruntime.com/v1/ci/repositories \
  -H "authorization: Bearer $RUNTIME_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"repository": "acme/web", "productionBranch": "main"}'
```

Or from an SDK, or the CLI:

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

| Field              | What it is                                                                    |
| ------------------ | ----------------------------------------------------------------------------- |
| `repository`       | `owner/name` on GitHub. Required.                                             |
| `productionBranch` | The branch whose pushes are checked as landed. Default `main`.                |
| `configPath`       | Where the repository's checks are written. Default `runtime.yml`.             |
| `installation`     | The installation of Runtime's GitHub App to read it through. Default: newest. |
| `trustedApps`      | GitHub Apps whose pushes run as your own code (see below). Default: none.     |

Or with the CLI:

```bash no-run
runtime ci repos connect acme/web --branch main --trust my-bot[bot]
```

`GET /v1/ci/repositories` (`runtime ci repos ls`) lists the connected
repositories, oldest first, with the Apps each trusts. `DELETE
/v1/ci/repositories/{id}` (`runtime ci repos disconnect acme/web`)
disconnects one: its checks still going are cancelled. The checks keep
running while the key that connected the repository stays full.

A repository is the account's, not one key's: it connects once per account.
Any key an owner or admin made lists every connected repository, whichever
key connected it, and any full key of theirs changes or disconnects one.
Another key lists only the repositories its own agent connected.

From then on these start a check:

- a push to any branch (tags and deletes start nothing);
- a pull request opened, reopened, pushed to or marked ready for review;
- a re-run asked for on GitHub.

A newer push to the same branch or pull request supersedes a check still
going, and its machines are freed at once: the newer commit carries the
older one. On the production branch, once newer pushes have kept it without
a verdict for 20 minutes, the check running then is kept and finishes, so
merges faster than a check never leave the branch unjudged.

## Whose code runs

A check runs only code from the repository's own people:

- a push by someone GitHub says can write to the repository;
- a push by a GitHub App the repository trusts (see below);
- a pull request from one of the repository's own branches, once one of
  the above pushed its head commit.

Everything else waits unrun, with a `runtime` check run on GitHub that
says why. This covers a fork's pull request, a push by someone who can only
read, and a push by an App the repository does not trust. A waiting check
never passes branch protection. A repository holds at most 20 waiting
checks, and one waiting longer than 7 days ends.

## Trust your own automation's App

When your own automation pushes through a GitHub App (a bot that opens
pull requests, say), list that App in the repository's `trustedApps`. Its
pushes then run as the code of someone who can write.

```bash no-run
curl -X POST "https://api.withruntime.com/v1/ci/repositories/${REPOSITORY_ID}:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: trust-my-bot" \
  -d '{"trustedApps": ["my-bot[bot]"]}'
```

The CLI adds or removes Apps and keeps the rest:

```bash no-run
runtime ci repos trust acme/web 'my-bot[bot]'
runtime ci repos untrust acme/web 'my-bot[bot]'
```

- Name each App by its login, `<app-slug>[bot]`, as GitHub shows its
  pushes. Letter case does not matter: the list keeps logins in lowercase.
- A repository trusts at most 10 Apps.
- Each update replaces the whole list. `[]` trusts none.
- Only a full key that an owner or admin made sets the list, the same rule
  as connecting.
- The trusted Apps belong to the connection. A repository disconnected and
  connected again trusts none until you list them again, or name them in
  the connect's `trustedApps`.
- Listing an App also runs that App's pushes of the production branch
  that are waiting now, newest first, while the account's `check` limit
  has room. One that still waits is replaced by the branch's next push,
  which now runs. Another branch's push is checked by its pull request, so
  a check of one still waiting ends.
- A pull request's check that waits does not run on the listing alone (who
  sent a pull request need not have pushed its code): the next push of its
  branch checks it.
- Listing an App vouches only for that App's own pushes, and the pull
  requests of the commits it pushed: never for a fork's or anyone else's.

Every repository's answer carries its `trustedApps`, sorted.

### Errors

| Status | Code                   | When                                                                                                       |
| ------ | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`      | `trustedApps` is not a list of at most 10 `<app-slug>[bot]` logins, or the update names `name` or `labels` |
| 403    | `forbidden`            | The key is not a full key, or no owner or admin made it                                                    |
| 404    | `not_found`            | No such repository this key may change: a narrowed key, or one no owner or admin made                      |
| 409    | `invalid_state`        | The repository is disconnected                                                                             |
| 409    | `idempotency_conflict` | The idempotency key was used with another body                                                             |

## Steps found for you

With no `runtime.yml`, Runtime reads the repository's root:

| Found                                  | Setup                                                  | Steps                                                      |
| -------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `package.json`                         | the lockfile's package manager: bun, pnpm, yarn or npm | the scripts it has, in order: lint, typecheck, test, build |
| `pyproject.toml` or `requirements.txt` | uv, poetry or pip                                      | `ruff check .` when ruff is set up, then `pytest`          |
| `go.mod`                               | `go mod download`, then the tests built                | `go vet ./...`, `go test ./...`                            |
| `Cargo.toml`                           | `cargo fetch`, then the tests built                    | `cargo test --locked`                                      |
| `Dockerfile`                           | none                                                   | `docker build .`                                           |

Setup builds a compiled project's tests once, into the warm snapshot every
check starts from: a check compiles only what its change touched. They are
built, never run (no `TestMain` or `init` runs in setup), and a build that
fails never fails the setup: the steps say what does not build. A
`package.json` project's setup runs its build, lint and typecheck scripts
once the same way (never its tests), so the warm snapshot holds every
cache they leave (turbo's, Next.js's, eslint's, tsc's): a check lints and
type-checks only what its change reaches. A lint script that is `eslint`
alone gets eslint's cache, and a typecheck script that is `tsc`, `tsgo` or
`vue-tsc` alone gets its incremental build info, each keyed by the files'
bytes, so the answer is the one a cold run gives. A bun
project with test files and no `test` script runs `bun test`. A
repository with none of these files ends its check at once, with a run that
says so: add a `runtime.yml` that names the steps.

## runtime.yml

An optional file at the repository's root (or `.runtime.yml`, or the
`configPath` you connected with) says the steps yourself. A check reads it
from the commit it checks, so a pull request that changes its steps is checked
with them. A step that must hold whatever a pull request says is a gate
(`gate: true`, below): it's read from the base's copy, never the pull
request's.

```yaml
machine: 4cpu # 2cpu, 4cpu, 8cpu or 16cpu; 2 GiB of memory per vCPU
setup: bun install --frozen-lockfile # run once, kept as the warm machine
cache: [bun.lock, package.json] # files whose bytes key the warm machine
keep: 8 # machines a pull request keeps for its next push: 0 (default) to 16
steps:
  - name: lint
    run: bun run lint
    inputs: ["src/**"] # what keys its result, with all they read (default: every file)
  - name: test
    run: bun test {files}
    split: { files: "**/*.test.ts" } # parts left out: by recorded times
    needs: [lint]
  - name: review rules
    run: ./check-rules.sh
    gate: true # the base's own; a pull request can't rewrite or drop it
```

- **Steps** run side by side unless one `needs` another; a step whose needs
  failed is skipped. A step may set its own `machine` and `env` (names not
  starting `RUNTIME_`).
- **Limits:** the file is at most 64 KiB, with at most 64 steps; `run` and
  `setup` are at most 8 KiB each. A job runs at most 30 minutes.
- **Errors** fail the check at once, before any machine is made, with one run
  that names the key at fault: `runtime.yml: is over 64 KiB`.

### Gates

A step with `gate: true` is read from the production branch's file as it is
now, never the pull request's own, nor the branch it targets or a pushed
branch's: a change that edits or removes it, on its own commits or on a branch
under them, still meets the production branch's. A check's gates run one after
another on one machine of their own, made from the image, on which none of the
change's code ran: no setup and
none of its files, only the history of the head and of the production branch's
head, which a gate reads as its base (`RUNTIME_CI_BASE`, and
`refs/runtime-ci/commit`, `refs/runtime-ci/base`). So it runs what the
production branch says from its own files, as in
`git show "$RUNTIME_CI_BASE:check-rules.sh" | sh`, and what it judges is
everything since the head met that branch. A push of the production branch
itself is judged against the commit before it. Beside every step's
`RUNTIME_CI_COMMIT`, `RUNTIME_CI_BASE` and `RUNTIME_CI_EVENT`, a gate reads
`RUNTIME_CI_HEAD`, the pull request's head, `RUNTIME_CI_APPROVED_BY`, the
GitHub logins whose latest review approves exactly that head, and
`RUNTIME_CI_REVIEWS_FILE`, a JSON file of the pull request's reviews (each
one's `id`, `user.login`, `state`, `commit_id` and `body`), such as a signed
record a gate checks. A review that approves, asks for changes or comments
with words, or one dismissed, checks the head again. A gate runs
on every commit, is never served an earlier pass, and has no `split`,
`inputs`, `needs` or `machine`; no step needs one.

### Steps that need no machine

A step that only reads the tree and its history needs none of the check's
machines, so it never waits in line for one. Two kinds:

```yaml
steps:
  - name: new code is Rust
    machine: none # a built-in check, run by the runner itself on the files it holds
    inline: { kind: new-files, languages: [ts, py], keep: [sdks], why: "New code is Rust." }
  - name: scan
    machine: light # a command, on the check's one light sandbox
    run: ./scan.sh
```

- **`machine: none`, with `inline:`**, is one of the runner's own checks. It
  runs in the runner at once after the plan, on the commit's files and its
  base's (and the bytes of a file the check reads), and its row passes or
  fails within seconds. `new-files`: the change adds no source file of some
  `languages` outside the `keep` folders (a move, a config file and a test
  beside old files pass). `approval`: a change to the `files`, `trees` (less
  what `exempt` names) or guarded `lines` it names fails until one of its
  `approvers` approves exactly the head on GitHub; with `gate: true` it is
  the base's own. `codeowners`: GitHub's code owners file and an `approval`
  step (`matches`) name the same files. `undoes`: the change sets no file
  back to how its base had it before other changes landed, unless its commit
  messages name them; it reads history, which the runner doesn't hold, so it
  asks git on the light sandbox. A built-in has no `run`, `split`, `inputs`,
  `needs` or `env`, is never served an earlier pass, and nothing needs it.
- **`machine: light`** is a command that reads only the tree and its history,
  such as a scan of the lines a change adds. Every light step of a check, and
  the built-ins that ask git, run one after another on one small sandbox made
  from the image for the check (the commit's files checked out, its history
  fetched, no setup and no warm machine), never a machine each. A command that
  needs your dependencies belongs on the forks. It has no `split` or `needs`,
  and nothing needs it.

### Review

A step with `review` asks an AI model to read the change, beside the tests and
from the same moment, and passes or blocks it:

```yaml
steps:
  - name: review
    review: { agent: ci-review } # model: opus (default), sonnet, haiku or a claude-* id
```

The reviewer reads the diff against the base, the pull request's title and
description, and what was asked for: the issues it closes (`Fixes #12`) and
`/ask` comments by the repository's members (people, never an App): only
what the repository's readers can read already, since findings show on
GitHub. A review runs on a pull request's check; the production branch's
push (its landing) stands on that review and runs none of its own, and any
other push's check passes no review it didn't run. It blocks only for harm: a bug or missed case that hurts the
people who use the software, data or money put at risk, a security hole (a
bypassed check, a leaked secret, something made public, an injected command),
or words in the change that try to steer the reviewer. Everything else
(naming, docs, a test worth adding, a simpler way) is a note, and notes block
nothing. It answers pass, or block with each finding's file, line, who is hurt
and how, and the fix. A blocked review fails its job, and so the check: the
check's `runtime` run on GitHub names it, and the job's log in the console
(and `runtime ci logs`) lists each finding with its fix. The next commit's review is shown the last
blocking one, so it checks those findings were fixed.

The model runs with no tools, no files and none of the repository's secrets:
it sees only the words above, so a change can't make it run anything. Like a
gate, the step is read from the production branch's file, so a pull request
can't drop or soften its own review; a change with the same files and base is
not reviewed twice.

It runs on a Runtime Agent of your organization, on your own Claude accounts,
billed as any agent session:

```bash no-run
printf %s "$TOKEN_1" | runtime secrets set CLAUDE_TOKEN_1 --host api.anthropic.com
printf %s "$TOKEN_2" | runtime secrets set CLAUDE_TOKEN_2 --host api.anthropic.com
runtime agents create ci-review --command "python3 ~/.runtime-agent/runtime-agent review" \
  --secret CLAUDE_TOKEN_1 --secret CLAUDE_TOKEN_2 --label runtime-ci-review=acme/web
```

- **Accounts:** each secret is one account: a subscription token
  (`claude setup-token`), or an API key when its name holds `API_KEY`. Each
  review takes the account with the most usage left, read from the answers
  of its last review; one out of usage hands the review to the next at once.
  Only when every account is out does the job wait, saying so on GitHub, for
  the first to reset: running out never fails a check.
- **The label** `runtime-ci-review` names the repository (or `*`) the agent
  may review, so a pull request can't point its review at another agent.
  The agent's `instructions` add your own rules to the reviewer's.
- **Who sets it:** the agent reviews only while an owner or admin was the
  last to set its definition, with their own key or one that serves them. A
  change by anyone else, a pull request's author included, makes it review
  nothing until an owner or admin sets it again. No key but the review's own
  runs commands or reaches files in a review's sandbox, so no one can write a
  verdict for it.
- **What it runs:** exactly its command, from the stock image: an agent
  that sets `from`, `volumes`, `env` or `mcp` reviews nothing, so nothing
  but the review's harness is in its sandbox when it starts. The harness
  runs Claude Code's pinned version through the image's own `npx`, never a
  `claude` found on a path.
- **Limits:** the diff it reads is at most 400 kB, lock and generated files
  last; a longer one is cut and the review says so. A review that can't be
  run at all (no such agent, an agent over its day's budget) fails its job
  with the reason. A review's session has 25 minutes to answer once it runs;
  a slower one is stopped and the next free account asked, up to three
  such sessions, each billed; past them the job fails with the reason.
  Waiting for a sandbox, an account or GitHub's rate limits costs nothing
  and fails nothing. A session that answers with no verdict, four times,
  fails the job.

### Deploy

A `deploy:` entry runs after a push of its `branch` has passed every job. It
never runs from a pull request. With `app:` it deploys a Runtime App; with
`run:` alone it runs that command once. With `targets:` it is a staged deploy:
your command runs on each target, a canary first, judged, then all the rest at
once, on a machine of its own with the commit checked out.

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

- **The canary** runs `run`, then the gate: its command on the canary every
  `every` seconds for `for` seconds (30 and 5 unless you say; `for: 0` is one
  probe). A probe that exits non-zero fails the gate at once: `rollback` runs
  on the canary, no other target is touched, and the deploy fails with the
  probe's last line. A canary whose `run` fails stops the deploy the same way,
  with no rollback: a release script is expected to undo its own failure.
- **The rest** run at once. A target still on its first try `slow` seconds
  after they began, or one that fails, is a **straggler**: it is named on the
  check, goes on alone and is tried again up to `retries` times, and the others
  never wait for it. The stage says `all` and `live` when every other target
  has released, and says each straggler's end whenever it comes. The deploy
  fails, naming them, only if a target is on the old release after its last
  try.
- **The stopwatch** is one line per stage on the check's run and the job's
  log, such as the one below. `merged` is when the check began.

  ```
  deploy hosts: merged → checked 38.2 s → canary 29.8 s → all 41.0 s → live 109.0 s after the merge
  ```

- **Where it runs:** only for a trusted check of a push to the repository's
  production branch, once every other job has passed. A pull request, a push
  to any other branch and a check that is not trusted deploy nothing, and the
  job says why. Like a gate, the `deploy:` entries are read from the commit
  before the push, never from the commit itself: a change to them takes
  effect from the next push, and no pull request can change what a deploy
  runs.
- **Not set up:** a command that exits 78 touched nothing and says on its last
  line what is missing. The deploy is then skipped and says so: it is never
  reported as live.
- **Limits:** at most 64 targets; a target's name is letters, digits and
  `_ . -`. The machine has your `setup`'s tools and the commit's files, and
  every `RUNTIME_CI_*` a step has. Put nothing secret in the file.

### A pull request's machines

With `keep:` in `runtime.yml` (1 to 16; none unless it says), a pull
request's check leaves the machines it ran on paused for the pull request's
next push: at most `keep` of them in all, whatever checks left them. The next
push's check
wakes them instead of starting new ones, with its build caches and installed
dependencies as the last push left them, and sends each only what changed.
They are deleted when the pull request merges or closes, and one day after
the push that left them in any case.

- **Cost.** While paused, each is billed as any paused sandbox: its memory
  and disk at {{paused-storage-rate}} per decimal GB per 30-day month
  ([paused storage](./pricing#paused-storage)). A pull request left open with
  no new push pays for its machines until their day is out. Without `keep:`,
  or with `keep: 0`, every machine is deleted when its check ends.
- **What it trades.** A kept machine holds what the last push's steps left,
  files git ignores too: a build cache, installed tools, a hook. So a later
  push's verdict can depend on an earlier push's change even once the pull
  request no longer holds it, which a review of its final diff does not
  show. Turn it on where every writer's earlier pushes can be trusted that
  far; a push to the production branch always starts fresh.
- **What runs on them.** What a push left on a machine, files git ignores
  too, is run only by the same pull request's next push. Only a pull request
  from the repository's own branches, pushed by a writer, keeps machines or
  takes them: never a fork's, nor one a writer approved for someone else
  ([Whose code runs](#whose-code-runs)). A push to the production branch
  never runs on one, and neither does a gate: a check's gates share one
  machine of their own, made from the image. Each machine is claimed for one check before it
  wakes: two checks never run on the same one.

### Split test files

A step with `split` runs each of its files as a task of its own, dealt across
parts by the times each file took before, the longest first; `{files}` in
`run` becomes the part's files. `parts` sets how many (1 to 64); left out,
Runtime chooses about a minute of tests a part, up to 16 and no more than the
machines a check runs at once. Each part is a job of its own in the console
and the API: `test (2/4)`.

Only the files a change can make fail run. Runtime reads what each test file
reads from the repository itself: its imports (TypeScript and JavaScript,
Python, Go packages, Rust crates), the files and folders its code names, the
scripts it runs and its package's test setup. A file whose reads the change
leaves alone keeps the pass it had on the production branch or an earlier
push, and runs on no machine (see [Passed before](#passed-before)). A part
with nothing left to run passes at once, on no machine.

## A warm start

A push to the production branch runs `setup` once on a new machine and keeps
that machine as a warm snapshot, keyed to the machine size, the setup command
and the bytes of every file the `cache` patterns match. A later check with the same key forks the
snapshot and is sent only the files that differ from its commit: nothing is
cloned, nothing is installed again, and no GitHub token ever reaches the
machine. A difference of more than 300 files or 64 MiB is fetched instead,
with a read-only token revoked before any of the repository's commands run.
Only a push to the production branch seeds a warm snapshot, never a pull
request, even one from a fork's branch named `main`. A small public
repository, {{ci-small-repo}}, took {{ci-small-cold}} for its first check and
{{ci-small-pull-request}} for a pull request this way ({{ci-measured-on}}).

A few copies of the warm snapshot are kept paused, ready for the next checks,
and a check wakes one (a wake takes about a tenth of a second): its first test
starts on that one machine at once. It adds more machines only when what it
has to run is longer than about a minute on one, and those start while its
first tests already run. A paused copy holds no server's processors or
memory.

The warm snapshots are in your account's snapshot list, and their storage is
billed as any snapshot's. CI/CD keeps only what a check can still use: the
newest warm snapshot of the production branch's current key and up to two
before it. When a push changes the setup, the machine size or a `cache` file, the
branch has a new key, and the old key's warm snapshots are deleted an hour
later. A check that copies its machine deletes the copy when it ends; a copy
left by a check that ended any other way is deleted within minutes.

## Passed before

Each test file of a split, and each other step, has a key: the machine, the
warm key, its command, its env and the contents of every file it reads. A
test file reads itself and all it reads; a step reads its `inputs` and all
they read, and the files its `run` names and all they read, or every file
when it names no `inputs`. A step whose code reads what its check is against
(`RUNTIME_CI_BASE`, to pick its work since its base) is keyed in a pull
request by those files at its base and at its head, and by any file the change
deletes, so pull requests that leave its files alone share its key. A key that
passed before stands for it: a pass on the production branch for any check of
the repository; a pull request's by someone with write access for any pull
request of the repository; an approved outside contributor's only in that pull
request. A pull request's pass never stands for the production branch. It
isn't run again, and a job whose every file passed before is `cached` in
the console and the API, on no machine; on GitHub it counts toward the
check's one `runtime` run. A job's log names
each file that passed before and the job it passed in.

## Rust build cache

In a repository with a `Cargo.lock`, every check machine compiles through
CI/CD's build cache: cargo runs rustc through `runtime-build-cache`
(`RUSTC_WRAPPER`), which keeps what each compile made and restores it the next
time the same compile is asked for, on any machine of any check of the
repository. A crate is compiled once; every later check, pull request and
machine is handed its output instead.

- **What makes a compile the same:** the toolchain (`rustc -vV`), the folder
  it runs in, every argument (target, flags, features, profile), the
  variables cargo sets for the crate, the bytes of every crate it is
  compiled against (which carry their own dependencies' hashes), the native libraries it links, every
  source file rustc read and every variable `env!` read (kept as a hash,
  never its value), every file and variable the crate's build script names
  with `cargo:rerun-if-changed` and `cargo:rerun-if-env-changed`, and for a
  binary, test or proc macro the linker's version. Change any of them and it compiles
  again.
- **Where it is kept:** on each machine, so a warm snapshot carries it to
  every check, and in the repository's store: one sandbox of your account,
  `build-cache-<key>`, labelled `runtime-ci-build-cache`, made by the first
  check that needs it (2 vCPU, 2 GiB, a 32 GiB disk). It serves through a
  preview, so it moves at most a preview's daily bytes and rate; a repository
  whose checks move more sets `build_cache: { shards: N }` in `runtime.yml`
  (up to 16), and its store is N such sandboxes, `build-cache-<key>-1` and on,
  each keeping the entries whose keys fall to it: N times the room, the
  bytes a day and the speed, and N sandboxes woken for every check. They
  pause when no check uses them and are billed as any sandbox; delete them
  to start the cache empty. A changed count finds nothing kept under the old
  until it is compiled again. The least used entries go first when a disk
  fills. A store belongs to one repository, and nothing in it is shared with
  another repository or account.
- **Who reads what:** a push to the production branch writes the
  repository's entries; a pull request reads them and its own, writes only
  its own, and never sees another pull request's. A pull request from a
  fork reads no store at all: what your production branch compiled can hold
  what its secrets put in (`option_env!`). Each check's machines get a
  grant that says so, signed by CI/CD and checked by the store. A setup reads
  the production branch's entries alone and writes none, and a gate runs
  without the cache, so nothing a pull request's code wrote reaches either.
  The grant is kept in a file on the machine only its user reads, never in a
  step's command.
- **Its room on a machine:** the machine's folder holds at most 15% of the
  disk, the entries used longest ago going first, and never fills the last
  quarter (at least 4 GiB): that is the build's.
- **Turning it off:** set `RUSTC_WRAPPER: ""` in a step's `env`, or your own
  wrapper (sccache, say), which takes its place. A wrapper your cargo config
  names (`build.rustc-wrapper` in a `.cargo/config.toml`) is left alone: the
  cache stays off.
- **What it can't see:** what a proc macro reads without telling rustc or
  the crate's build script. Name such files with
  `cargo:rerun-if-changed` in a build script (as sqlx asks for its
  migrations), or turn the cache off for that step.

`runtime-build-cache test` checks a crate as a task of a split: its format, its
lints with `-D warnings`, its test binaries all at once and its doc tests, as
`-p <name>`, so each crate's compiles are the same on every machine and only
the crates a change reaches run:

```yaml
steps:
  - name: crates
    run: /workspace/.runtime-build-cache/runtime-build-cache test {files}
    split: { files: "crates/*/Cargo.toml" }
    env: { CARGO_PROFILE_DEV_DEBUG: "false", CARGO_PROFILE_TEST_DEBUG: "false" }
```

Debug info off made a one-file change's test build a fifth faster and the
build half the size (a 79-crate build, measured on 21 October 2026).

Lints are kept as compiles are (clippy's version, its `CLIPPY_ARGS` and every
`clippy.toml` it looks for are in the key, and what it printed is printed
again). `runtime-build-cache warm <Cargo.toml>...` builds each crate's lints
and test binaries exactly as its `test` task will, running nothing: put it in
your `setup` so every fork starts with them. A workspace build
(`cargo test --workspace`) is not the same, since cargo unifies a
dependency's features across every crate it builds at once, and a crate's own
`-p` check then compiles its dependencies again. On an 82-crate workspace (4
vCPU, 22 October 2026) one crate's check took 61 s after a workspace build
and 3 s after `warm`, or 8 s with one of its files changed:

```yaml
setup: |
  /workspace/.runtime-build-cache/runtime-build-cache warm $(git ls-files '**/Cargo.toml')
```

## Flaky tests

Every run of every test file is kept by commit and content key. A failed
file runs again alone, on another machine when one is free. A file that
passed and failed under the same key is flaky: the job says it passed with
flaky tests, naming them, never a silent pass.

- **Proven on the production branch.** A flake is proven only by a run of a
  commit pushed to the production branch. A pull request's own flaky run
  still fails its check: a change can't quiet a test it touches.
- **Quarantined at once.** It still runs and reports in every check, and
  its failures no longer fail one. Files matched by `quarantine: {
protected: [...] }` stay gating, and so does the last test of an area
  (`quarantine: { areas: {...} }`). More than 3 flaky files in one job
  still fail it. `quarantine: false` turns it all off.
- **Handed to an owner.** Its owner comes from your `CODEOWNERS` (the last
  matching rule), or else is the author of the pull request that last
  changed the file. The owner has 48 hours to fix it or delete it with a
  reason; past them it shows overdue.
- **Ended by 100 passes.** At the production branch's next commit after a
  change to the file, it runs 100 times in parallel forks. When all 100
  pass, it is fixed and gates again. One failure keeps it quarantined.
  The old `quarantine: { clean_runs: N }` setting is no longer accepted:
  remove it, or every check fails with an error that names it.
- **New and changed tests run 20 times.** A pull request's new or changed
  test file runs 20 times in parallel forks, and one failure fails the
  check, so a flaky test is caught before it lands.
- **No timing bars.** Every check command gets `RUNTIME_CI_TIMING=skip`.
  Skip assertions on speed or latency when it is set: they belong on the
  hosts you measure on, not in a check.

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

A pull request's check can judge only what the pull request breaks. When your
production branch is red, every pull request would otherwise fail on the same
broken tests, including the pull requests that fix them.

Turn it on for a split test step with `over_main: true`:

```yaml
steps:
  - name: test
    run: bun test {files}
    split: { files: "**/*.test.ts" }
    over_main: true
```

Then a part of that step that fails on a pull request is named as main's,
not the change's, when every test file that failed there failed on your
production branch's own check too, at the pull request's base or a newer
commit of the branch. The newest of those checks that ran the file decides.
When every failed job is main's, the check still fails, titled "Failed only
where main fails too", and names each such job with the commit main failed it
at. It is never a pass, so no branch rule, auto-merge or merge queue merges a
change past main's failures: check it again once main passes. When the pull
request breaks something of its own, the check names those failures first and
main's apart. Anything else is the change's, as it always was:

- **Only your production branch turns it on.** `over_main` counts only when
  the production branch's own file has the very same step saying it. A pull
  request can't add it, or keep it on a step it changed.
- **Test files only.** Only a split step that is reused can say it, and it is
  judged file by file. A step run whole is never main's: its exit names
  no file, so a new failure beside main's would look the same. Nor are
  [gates](#gates), [reviews](#review), deploys or steps with `reuse: false`.
- **One more failing file: it fails.** A test file that passes on the
  production branch and fails on the pull request is always the change's.
- **Main's verdict unknown: it fails.** If main's check of the base is still
  running, never ran the file, or there is none, the pull request fails.
- **The same failure.** A part that ran past its time limit or could not start
  fails the check: the files it never finished may be the change's.
- **Fixes are named.** When a job or test file main fails passes on the pull
  request, the check's run says the change fixes it.

Your production branch's own checks are never judged this way: main stays red
until a fix lands, and nothing it gates releases before then.

## What GitHub shows

One check run per check, named `runtime`, the one a branch rule requires. It
shows in progress while the check runs and then its conclusion, linked to the
check in the console, where every job and its log are. A failed check's run
names each job that failed, its log's last line, and a link to that job. A
pull request's run also names the jobs that failed the same way on your
production branch, apart from its own ([failures main already has](#failures-main-already-has)).
There is no run per job: a branch rule requires `runtime`, never a job's name.

GitHub hears a check only when its state changes, so a check of 40 jobs is at most
two calls of your installation's hourly GitHub budget, not hundreds. GitHub is
told what CI/CD's own record says; CI/CD never reads a check back from it.
Every read of GitHub is conditional, so one that has not changed costs nothing
of the budget. When the budget runs low, telling GitHub is the first to wait,
so what is left of the hour goes to checking: a verdict never waits on
GitHub's view, and GitHub hears the end once the hour resets. Your checks, jobs and logs are always current in the console, the
API, the SDKs and the CLI.

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
npx withruntime ci ls --commit $(git rev-parse HEAD)
npx withruntime ci get <checkId>
npx withruntime ci cancel <checkId>
npx withruntime ci logs <jobId>
npx withruntime ci tests <repoId> --quarantined
```

- **Checks** list newest first, filtered by `repositoryId`, `branch`,
  `commit` (a full SHA), `pullRequest` or `state` (`queued`, `running`,
  `passed`, `failed`, `cancelled`). `waiting` is true for a check that waits
  for a writer's approval. `counts` holds how many of its jobs are in each
  state. `machines` says where its machines came from and how soon:
  `reused` (its pull request's own, left paused by its last push), `pooled`
  (the repository's warm pool), `forked` in `forks` batch forks, `created`
  (from the warm snapshot), `kept` for the next push, `firstMs` to its first
  machine, `firstTestMs` to its first test, and `lineMs` waiting in the
  account's line.
- **Where a check's machines come from.** First the ones it is done with
  from its earlier steps, then its pull request's own machines, paused since
  its last push with its build caches warm (all woken on its first ask),
  then the warm pool, then one batch fork of up to 100 copies of a paused
  pool machine, or, with none paused, all started from the warm snapshot at
  once. A pull request's machines are deleted when it merges or closes, or a
  day after its last push ([A pull request's machines](#a-pull-requests-machines)). An
  account's checks start at most 2 machines a second (100 at once) and hold
  at most 256, counted across all of them (a `runtime-ci` run by hand counts
  its own): past that, or when a region has no room, a check waits in line with
  the reason on its jobs. It never fails for want of room, a gate's machine
  neither. A push to the production branch goes first: while its check is
  short of machines, every other check of the account asks for none, gives
  back each machine it has nothing left to run on, and its check takes that
  room within seconds. It holds as many machines as it has jobs ready, up
  to the account's 256.
- **Cancel a check** that is queued or running with
  `POST /v1/ci/checks/{id}:cancel` (`runtime.ci.checks.cancel(id)`): its
  running jobs are cancelled and its queued ones skipped, its machines are
  let go within seconds, and GitHub shows its check run as cancelled. A check
  that has ended is answered as it is, so a second cancel is no error. Any
  key that may change the check's repository may cancel its checks: an
  owner's or admin's full key any of the account's, another key those of
  repositories its own agent connected.
- **A job** is `queued`, `running`, `passed`, `failed`, `flaky` (its only
  failures were in quarantined files), `cached` (its content key passed
  before, in `cachedFrom`), `cancelled` or `skipped`. Its `log` is the tail of
  its output, the last 256 KiB.
- **A failed job's sandbox may be kept paused.** Its `sandboxIds` are your
  own sandboxes: wake one and look around where it failed with
  `runtime sandboxes wake <id>` and `runtime sandboxes shell <id>`, or the
  sandbox API.
- **Test files** keep their recent time, which splits a step's files into
  even parts, and their last 20 outcomes. A file whose failures no longer
  fail a check is quarantined since `quarantinedSince`.

## API

| Route                             | What it does                                              |
| --------------------------------- | --------------------------------------------------------- |
| `POST /v1/ci/repositories`        | Connect a GitHub repository; only a full key connects one |
| `GET /v1/ci/repositories`         | Connected repositories, oldest first                      |
| `DELETE /v1/ci/repositories/{id}` | Disconnect; its checks still going are cancelled          |
| `GET /v1/ci/checks`               | Checks, newest first                                      |
| `GET /v1/ci/checks/{id}`          | A check and its jobs in plan order                        |
| `POST /v1/ci/checks/{id}:cancel`  | Cancel a queued or running check; its machines let go     |
| `GET /v1/ci/jobs/{id}`            | A job with its log and its sandboxes                      |
| `GET /v1/ci/tests`                | A repository's test files and their quarantine            |
| `GET /v1/ci/flakes`               | Flaky tests, newest first; the open ones unless `state`   |
| `GET /v1/ci/flakes/{id}`          | A flaky test with its runs and the jobs it failed in      |
| `POST /v1/ci/flakes/{id}:update`  | `prove`, hand it to an `owner`, or a `deleteReason`       |

The MCP tools are `runtime_ci` with the actions `checks`, `check`, `job`,
`tests`, `flakes`, `flake`, `flake_update`, `check_cancel`, `repositories`,
`connect` and `disconnect`. A key reads only the
checks of repositories its own agent, or one it may see, connected.

## Price and limits

A check with no machine to run on, because a region is full or its
machines failed to start, waits for one and is asked again, after a pause
that grows to 2 minutes; its jobs show "Waiting" with why. It never fails
for it: it runs once machines come, or ends when it is cancelled or a newer
push replaces it.

When machines are short, checks go by their account's lane, as sandboxes
do ([waiting in line for room](./limits#waiting-in-line-for-room)): a
higher lane's checks are taken first and get machines first, and a waiting
job says where it stands, such as
`short of room: waiting for room, 1 ahead (pro 1); this lane is free`. An
account's waiting checks hold lower lanes back for three minutes at most in
any fifteen, and only while the region is short of room for everyone, not
while the account is at its own share. Inside an account, a push of the
production branch gets machines before its pull requests.

A check machine is billed at **{{ci-vcpu-minute}} per vCPU-minute**, with
{{ci-gib-per-vcpu}} of memory per vCPU, by the second
([pricing](./pricing#ci-cd)). Every machine of a check is deleted when the
check ends, whatever happened, except those a pull request's check keeps
paused for its next push ([A pull request's machines](#a-pull-requests-machines)). CI/CD opens to an account once Runtime sets its
limits ([limits](./limits)).
