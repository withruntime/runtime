---
launch: builds
---

# Builds

Connect a Git repository and Runtime builds its commits on machines of your
own account: it clones the commit, installs its dependencies with the
lockfile's package manager (bun, pnpm, Yarn or npm), runs your build command
and keeps the log. With a start command, the build ends as your server,
started, checked healthy and saved with its memory: a snapshot you start or
fork sandboxes from.

## Connect a repository

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const repo = await runtime.builds.repositories.connect({
  provider: "github",
  repository: "acme/web",
  deploy: "app:web",
  productionBranch: "main",
  rootDirectory: "apps/web",
  startCommand: "npm start",
  healthPath: "/healthz",
});
const build = await runtime.builds.create({ repositoryId: repo.id, ref: "main" });
for await (const event of runtime.builds.logs(build.id, { follow: true })) {
  if (event.type === "line") console.log(event.text);
  if (event.type === "terminal") console.log(event.state, event.reason);
}
```

```bash no-run
npx withruntime builds repos connect acme/web --deploy web --root apps/web --start "npm start"
npx withruntime builds run <repoId> --ref main
```

- **`provider`** is `github` for a repository on GitHub (`owner/name`) or
  `git` for any HTTPS Git URL. A `git` repository builds a full commit id; a
  GitHub repository builds a branch, a tag or a commit.
- **A private GitHub repository** builds once its owner installs Runtime's
  GitHub App on it: `npx withruntime builds repos install` prints the link,
  open for 15 minutes. With the App installed, every push to the production
  branch builds by itself.
- **`deploy`** names what the repository is built for: `app:<name>`,
  `function:<name>` or `container:<name>`.
- **`installCommand`** and **`buildCommand`** replace the ones chosen from the
  lockfile and `package.json`. **`buildEnv`** holds settings the install and
  the build read, up to 64 and 32 KiB in all. They are not secrets: anyone who
  reads the repository's settings sees them. Names starting `RUNTIME_`, and
  `PORT`, are Runtime's.
- **`startCommand`** runs once the build is done, with `PORT` set (8080 by
  default). The build waits for the server to answer `healthPath` with 200,
  then saves it, memory and all, as the build's `outputSnapshotId`.
- **`previews`** (on by default) builds branches other than the production
  branch too.

## Follow a build

A build is `queued`, then `fetching`, `building`, `deploying` while its server
starts and is saved, and ends `succeeded`, `failed`, `cancelled` or
`superseded`. A failed build's `reason` and its log's `failingStep` say which
step failed, with its last lines.

- `runtime.builds.logs(id)` answers the last 200 lines;
  `{ follow: true }` streams every line as it comes, until the build ends, and
  resumes from a `cursor` after a dropped connection.
- `runtime.builds.cancel(id)` stops a build that has not ended; its builder is
  deleted at once and bills nothing more.
- A build of a `branch` supersedes that branch's older builds not yet ended,
  so a burst of pushes builds the last one. The same branch and commit asked
  for twice is one build.
- `timings` on a finished build splits its time by step, in milliseconds,
  with the whole as `total`.

## Warm builders

A build of the production branch leaves a **warm builder**: a snapshot of its
builder, taken after the install, one per repository and lockfile. The next
build of that repository forks it, receives only the files the new commit
changed, and finds its dependencies already installed. On 6 October 2026 a
Next.js blog built in 7.2 to 9.7 seconds from fork to built this way.

A warm builder changes when the lockfile, the commands, the settings or the
builder's image change: that build installs from scratch and leaves a new
one. Builds of other branches use warm builders and never write one. A warm
builder is kept 14 days after its last use.

## What it costs

A build runs on a builder of 8 vCPUs and 8 GiB, a sandbox of your account,
billed as every sandbox is: active CPU and memory while it runs, at the
[sandbox rates](./pricing#builds). Builds add no price of their own. A warm
builder and a build's saved server are snapshots of your account, billed as
snapshots. Builders count toward the account's sandboxes at once while they
run, and are deleted when their build ends.

## Limits

An account with credit connects 10 repositories and has up to 4 builds not
yet ended at once; a build past that is refused `quota_exceeded`, which
names `build.count`. Builds need credit on the account
([limits](./limits)).
