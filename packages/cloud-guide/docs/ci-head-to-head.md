---
launch: actions
---

# CI head to head: GitHub, Runtime, Blacksmith and Namespace

We timed the test jobs of six public projects on GitHub's hosted runners and
on Runtime, on 23 October 2026. The projects use Node.js, Rust, Python, Go,
Java and a TypeScript monorepo. Each column says how it was measured. Nothing
here is estimated.

## What we found

| Job                          | Where   | Cache | Runs | Time to start | Total, median | Total, range     | Cost per run                        |
| ---------------------------- | ------- | ----- | ---- | ------------- | ------------- | ---------------- | ----------------------------------- |
| express, Node.js 24          | GitHub  | cold  | 25   | 2 s           | 24 s          | 20 to 56 s       | {{github-4core-minute}}             |
|                              | Runtime | cold  | 4    | 1.0 s         | 19.9 s        | 19.4 to 21.2 s   | {{=$4 cost:runtime:4x16x20x80x1}}   |
|                              | Runtime | warm  | 4    | 0.7 s         | 9.8 s         | 9.7 to 10.1 s    | {{=$4 cost:runtime:4x16x10x40x1}}   |
| ripgrep, test (pinned)       | GitHub  | cold  | 23   | 2 s           | 70 s          | 49 to 231 s      | {{=$3 2 * github-4core-minute}}     |
|                              | Runtime | cold  | 4    | 0.8 s         | 56.1 s        | 53.4 to 66.4 s   | {{=$4 cost:runtime:4x16x57x228x1}}  |
|                              | Runtime | warm  | 4    | 0.8 s         | 22.3 s        | 21.6 to 22.7 s   | {{=$4 cost:runtime:4x16x23x92x1}}   |
| requests, Python 3.12        | GitHub  | warm  | 23   | 3 s           | 103 s         | 96 to 134 s      | {{=$3 2 * github-4core-minute}}     |
|                              | Runtime | cold  | 4    | 0.7 s         | 93.5 s        | 92.4 to 94.8 s   | {{=$4 cost:runtime:4x16x94x376x1}}  |
|                              | Runtime | warm  | 4    | 0.7 s         | 83.4 s        | 83.3 to 83.5 s   | {{=$4 cost:runtime:4x16x84x336x1}}  |
| gin, Go 1.27                 | GitHub  | warm  | 26   | 2 s           | 69 s          | 54 to 124 s      | {{=$3 2 * github-4core-minute}}     |
|                              | Runtime | cold  | 4    | 1.1 s         | 38.3 s        | 37.7 to 39.8 s   | {{=$4 cost:runtime:4x16x39x156x1}}  |
|                              | Runtime | warm  | 4    | 0.9 s         | 7.9 s         | 7.2 to 8.0 s     | {{=$4 cost:runtime:4x16x8x32x1}}    |
| gson, Java 17 with Maven     | GitHub  | warm  | 24   | 10.5 s        | 99.5 s        | 73 to 777 s      | {{=$3 2 * github-4core-minute}}     |
|                              | Runtime | cold  | 4    | 1.1 s         | 72.4 s        | 69.8 to 76.1 s   | {{=$4 cost:runtime:4x16x73x292x1}}  |
|                              | Runtime | warm  | 4    | 0.8 s         | 41.8 s        | 40.3 to 43.3 s   | {{=$4 cost:runtime:4x16x42x168x1}}  |
| vite, pnpm monorepo, Node 24 | GitHub  | warm  | 22   | 3 s           | 148.5 s       | 120 to 249 s     | {{=$3 3 * github-4core-minute}}     |
|                              | Runtime | warm  | 4    | 1.2 s         | 133.0 s       | 128.2 to 149.6 s | {{=$4 cost:runtime:4x16x133x532x1}} |

GitHub's "warm" rows are jobs whose workflow restores a cache
(`actions/cache`, `setup-java`'s or `pnpm/setup`'s), so they are set
against Runtime's warm runs first.

- **Warm, Runtime was ahead on every job.** A warm job starts from a disk
  snapshot. The snapshot comes from a run of a commit three commits back.
  A pull request's job starts from what main's last run left: gin's job
  took 7.9 seconds where GitHub's took 69, gson's 41.8 where GitHub's took
  99.5, express's 9.8 where GitHub's took 24.
- **Cold, Runtime was quicker on five jobs** than GitHub was. This holds even
  against GitHub's warm runs for requests, gin and gson. Runtime was also
  steadier. GitHub's slowest runs took up to nearly eight times its median
  (777 seconds for gson). Runtime's slowest cold run was at most 10.3 seconds
  over its median.
- **A run cost a quarter or less of GitHub's list price.** A warm express run
  cost a twentieth of it. A warm gin run cost nearly a fiftieth. Runtime bills
  by the second, at {{cpu-rate}} per vCPU-hour and {{memory-rate}} per GiB-hour
  of memory. GitHub bills its 4-core Linux runner {{github-4core-minute}} a
  minute. Each job is rounded up to a whole minute. GitHub runs a public
  repository's jobs on its standard runner for free. The price here is what a
  private repository pays.
- **requests' job is mostly its tests' own waiting.** It takes about 80
  seconds on both, so it gains least. 4 of its 635 tests fail on Runtime and
  pass on GitHub. They connect to an address that never responds and expect the
  connection to time out. A sandbox's network accepts the connection first,
  then closes it.

## Blacksmith and Namespace

Neither publishes times for these jobs, so they have no rows above. The table
shows what each publishes for a 4-vCPU, 16 GB Linux runner. We read it on
23 October 2026:

|                | Blacksmith                        | Namespace                                                                                                                                | Runtime                            |
| -------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Price a minute | $0.008, twice its 2-vCPU $0.004   | $0.008 prepaid, $0.012 past a plan's minutes                                                                                             | {{=$4 cost:runtime:4x16x60x240x1}} |
| Billed by      | not stated                        | the minute, at least one                                                                                                                 | the second                         |
| Start          | runners boot in "under 3 seconds" | no figure                                                                                                                                | 0.7 to 1.2 s, the medians above    |
| Speed claim    | "2x faster than GitHub's runners" | a Rust project's Ubuntu job, runner size not stated: 4 min 24 s on GitHub, 2 min 39 s on Namespace, 34 s with a cache hit (10 July 2026) | the table above                    |

At those prices, a job under a minute costs at least $0.008 on Namespace.
express's cold run cost {{=$4 cost:runtime:4x16x20x80x1}} on Runtime.

## How it was measured

**The jobs.** Each job is the project's own GitHub Actions job. Its steps run
as written, at one pinned commit:

- [expressjs/express](https://github.com/expressjs/express) `1c6f1b0`, `ci.yml`, job "Node.js 24 - ubuntu-latest":
  `npm install`, then `npm run test-ci`. No cache: every run is cold.
- [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) `6892bc2`, `ci.yml`, job "test (pinned)", Rust 1.96.0:
  the apt packages its `ci/ubuntu-install-packages` installs, the toolchain,
  both builds, the tests with PCRE2, the shell completion test and the two
  printing tests. No cache: every run is cold.
- [psf/requests](https://github.com/psf/requests) `611c616`, `run-tests.yml`, job "build (3.12, ubuntu-22.04)":
  `make`, then `make ci`. `setup-python` caches pip's downloads, so its runs
  are warm.
- [gin-gonic/gin](https://github.com/gin-gonic/gin) `0f09c3a`, `gin.yml`, job "ubuntu-latest @ Go 1.27":
  Go 1.27 as `setup-go` gives it (1.27.3), then `make test`. `actions/cache`
  restores Go's build and module caches, so its runs are warm.
- [google/gson](https://github.com/google/gson) `828cbe0`, `build.yml`, job "Build on JDK 17 (jdk)":
  Temurin 17 as `setup-java` gives it, Maven 3.9.11, then
  `mvn verify javadoc:jar`. `setup-java` caches Maven's downloads, so its
  runs are warm.
- [vitejs/vite](https://github.com/vitejs/vite) `82e7aa0`, `ci.yml`, job "Build&Test: node-24, ubuntu-latest":
  a pnpm monorepo. `pnpm install`, Playwright's Chromium, `pnpm run build`,
  then `test-unit`, `test-serve`, `test-serve-bundled` and `test-build`.
  `pnpm/setup` caches pnpm's store and `actions/cache` Playwright's browser,
  so its runs are warm. They are set against Runtime's warm runs.

**GitHub.** The projects' own recent successful runs of those jobs, read from
GitHub's API: express 9 to 23 October 2026, ripgrep 20 to 23 October,
requests 3 August to 28 September (its latest), gin 13 to 23 October, gson
15 to 23 October, vite 22 to 23 October. Time to start is the job's
`created_at` to `started_at`, when a runner took it. Total is `created_at` to
`completed_at`. Two jobs from re-run requests are left out, because their
start comes before their creation. A public repository's `ubuntu-latest` job
runs on 4 vCPUs and 16 GB.

**Runtime.** The same steps run from
[`bench.sh`](https://github.com/withruntime/runtime/blob/main/packages/cloud-guide/benchmarks/ci-head-to-head/bench.sh)
in a sandbox the size of `runs-on: runtime-4cpu` (4 whole vCPUs, 16 GiB). The
runs were made on 23 October 2026 with
[`runtime.sh`](https://github.com/withruntime/runtime/blob/main/packages/cloud-guide/benchmarks/ci-head-to-head/runtime.sh).
Time to start runs from the create call to the sandbox's first command. Total
runs from the create call to the job's end. A cold run starts from a fresh
sandbox. A warm run starts from a snapshot of the disk a run of the commit
three before the pinned one left (`bench.sh <job> base`). Its toolchains,
downloads and build caches are in place. The pinned commit's own build or test
results are not. This works as a pull request's job does, starting from what
main's last run left. Cost is the sandbox's price for its total time. It is
billed the way a `runs-on: runtime-4cpu` runner is billed.

**What this does not measure.** Runtime's time to start is the sandbox's time.
It is not a GitHub Actions job's time. A `runs-on: runtime` job also waits for
GitHub to send the job and for its runner to register. These runs do not
include that wait, so the start columns are not compared. The express job's
coverage upload, about a second on GitHub, is not run on Runtime. Runtime's
costs are at each median time, rounded up to a whole second.
