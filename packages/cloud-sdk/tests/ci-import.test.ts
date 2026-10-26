import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { cacheFiles, importCi, installsOnly, matrixCells } from "../src/ci-import";
import { run } from "../src/cli";

/* `runtime ci import`: a team's GitHub Actions workflows and CircleCI config
   as the runtime.yml CI/CD reads, everything not carried over said in a
   note. The workflows here are cut from real repositories' (expressjs/express,
   fastify/fastify, CircleCI's own demos), whose converted files the checks
   runner's own runtime.yml parser read and planned (pull request's proof). */

type Written = {
  name: string;
  run: string;
  needs?: string[];
  env?: Record<string, string>;
  machine?: string;
};
/** The steps of a written runtime.yml, as many as the test names. */
const steps = <T extends Written[]>(yaml: string | null) =>
  (parse(yaml!) as { steps: Written[] }).steps as T;

const EXPRESS = `
name: ci
on:
  push:
    branches: [master]
  pull_request:
env:
  FORCE_COLOR: 1
jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0ad4b8fadaa221de15dcec353f45205ec38ea70b
      - uses: actions/setup-node@v4
        with: { node-version: lts/* }
      - run: npm install --ignore-scripts --include=dev
      - run: npm run lint
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [18, 20, 22]
    services:
      redis:
        image: redis:7
        ports: ["6379:6379"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "\${{ matrix.node-version }}" }
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: npm-\${{ hashFiles('**/package-lock.json', 'package.json') }}
      - run: npm install
      - name: Run tests
        run: npm run test-ci
        env:
          TOKEN: \${{ secrets.COVERALLS_TOKEN }}
          COMMIT: \${{ github.sha }}
      - uses: actions/upload-artifact@v4
  coverage:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: |
          cd coverage
          lcov --summary lcov.info
      - run: echo done
`;

test("an Actions workflow's jobs are steps: installs in setup, caches as files, needs kept", () => {
  const made = importCi([{ path: ".github/workflows/ci.yml", text: EXPRESS }]);
  expect(made.steps).toEqual(["Lint", "test", "coverage"]);
  const doc = parse(made.yaml!);
  expect(doc.setup).toBe("npm install --ignore-scripts --include=dev\nnpm install");
  expect(doc.cache).toEqual(["**/package-lock.json", "package.json"]);
  const [lint, tests, coverage] = steps<[Written, Written, Written]>(made.yaml);
  expect(lint).toEqual({ name: "Lint", run: "set -e\nnpm run lint", env: { FORCE_COLOR: "1" } });
  // The service starts with Docker on the host's network, as GitHub mapped it.
  expect(tests.run).toContain("docker run -d --name redis --network host redis:7");
  // A secret is never written into the file; the commit is Runtime's.
  expect(tests.run).toContain(`export COMMIT="\${RUNTIME_CI_COMMIT}"`);
  expect(made.yaml).not.toContain("secrets.");
  expect(coverage.needs).toEqual(["test"]);
  // Each of GitHub's steps ran in its own shell: a cd stays in its own.
  expect(coverage.run).toBe(
    "set -e\n(\n  cd coverage\n  lcov --summary lcov.info\n)\n(\n  echo done\n)",
  );
  expect(made.notes).toEqual(
    expect.arrayContaining([
      expect.stringContaining("windows-latest is left out: Runtime machines are Linux"),
      expect.stringContaining("matrix cells that differ only in a tool's version run once"),
      expect.stringContaining("secret COVERALLS_TOKEN is not carried"),
      expect.stringContaining("action actions/upload-artifact is not carried"),
      expect.stringContaining("actions/setup-node is not needed"),
    ]),
  );
  // Every note is a comment on top of the file.
  for (const n of made.notes) expect(made.yaml).toContain(`#  - ${n}`);
});

test("a matrix a command reads is one step a cell, named by what differs", () => {
  const made = importCi([
    {
      path: ".github/workflows/compat.yml",
      text: `
on: [pull_request]
jobs:
  pino:
    name: Pino compatibility
    runs-on: ubuntu-latest
    strategy:
      matrix:
        pino: ["^9", "^10"]
        include:
          - pino: "^10"
            extra: --strict
    steps:
      - run: npm install --no-save pino@\${{ matrix.pino }}
      - run: npm run unit \${{ matrix.extra }}
  release:
    needs: [pino]
    runs-on: ubuntu-latest
    steps:
      - run: ./release.sh
`,
    },
  ]);
  expect(made.steps).toEqual(["Pino compatibility 9", "Pino compatibility 10 --strict", "release"]);
  const [nine, ten, release] = steps<[Written, Written, Written]>(made.yaml);
  // An install of one cell's own package stays in its step.
  expect(nine.run).toContain("npm install --no-save pino@^9");
  expect(ten.run).toContain("npm run unit --strict");
  expect(release.needs).toEqual(["Pino compatibility 9", "Pino compatibility 10 --strict"]);
});

test("a workflow that runs on neither push nor pull request is skipped, and says so", () => {
  const made = importCi([
    {
      path: ".github/workflows/nightly.yml",
      text: "on:\n  schedule: [{cron: '0 0 * * *'}]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{run: make}]\n",
    },
  ]);
  expect(made.yaml).toBeNull();
  expect(made.notes).toEqual([
    ".github/workflows/nightly.yml: skipped: it runs on neither push nor pull_request",
  ]);
});

const CIRCLE = `
version: 2.1
orbs:
  heroku: circleci/heroku@1.2
commands:
  deps:
    steps:
      - restore_cache:
          keys:
            - v1-deps-{{ checksum "package-lock.json" }}
      - run: npm ci
jobs:
  build:
    docker:
      - image: cimg/node:20.11
      - image: cimg/postgres:16.2
        environment:
          POSTGRES_USER: circle
    resource_class: xlarge
    working_directory: ~/app
    environment:
      NODE_ENV: test
    steps:
      - checkout
      - deps
      - run:
          name: tests
          command: npm test
          environment:
            DATABASE_URL: postgres://circle@localhost/circle
      - run:
          command: cd web && npm run build
          working_directory: ~/app
      - store_test_results:
          path: results
  deploy:
    docker: [{image: cimg/base:stable}]
    steps:
      - checkout
      - heroku/deploy-via-git
workflows:
  main:
    jobs:
      - build
      - hold:
          type: approval
          requires: [build]
      - deploy:
          requires: [build]
`;

test("a CircleCI config's workflow is the steps: commands inlined, services in Docker, requires as needs", () => {
  const made = importCi([{ path: ".circleci/config.yml", text: CIRCLE }]);
  expect(made.steps).toEqual(["build"]);
  const doc = parse(made.yaml!);
  expect(doc.setup).toBe("npm ci");
  expect(doc.cache).toEqual(["package-lock.json"]);
  const [build] = steps<[Written]>(made.yaml);
  expect(build.machine).toBe("8cpu");
  expect(build.env).toEqual({ NODE_ENV: "test" });
  expect(build.run).toContain(
    "docker run -d --name postgres --network host -e POSTGRES_USER='circle' cimg/postgres:16.2",
  );
  expect(build.run).toContain(
    "  export DATABASE_URL='postgres://circle@localhost/circle'\n  npm test",
  );
  // The job's working_directory is where its checkout went: the root here.
  expect(build.run).not.toContain("~/app");
  expect(made.notes).toEqual(
    expect.arrayContaining([
      expect.stringContaining("orbs (heroku) are not carried"),
      expect.stringContaining("hold: an approval hold is not carried"),
      expect.stringContaining("heroku/deploy-via-git (an orb's or unknown step) is not carried"),
      expect.stringContaining("deploy: has no command left to run here; not written"),
      expect.stringContaining("ran in cimg/node:20.11"),
      expect.stringContaining("store_test_results is not carried"),
    ]),
  );
});

test("the parts: a matrix's cells, a cache key's files, a plain install", () => {
  expect(
    matrixCells({ a: [1, 2], b: ["x"], exclude: [{ a: 2 }], include: [{ a: 3, b: "y" }] }),
  ).toEqual([
    { a: "1", b: "x" },
    { a: "3", b: "y" },
  ]);
  expect(matrixCells(undefined)).toEqual([{}]);
  expect(cacheFiles("deps-{{ checksum \"go.sum\" }}-${{ hashFiles('a.lock') }}")).toEqual([
    "a.lock",
    "go.sum",
  ]);
  expect(installsOnly("npm ci")).toBe(true);
  expect(installsOnly("pip install -r requirements.txt")).toBe(true);
  expect(installsOnly("pip install -e .")).toBe(true);
  expect(installsOnly("npm install pino@9")).toBe(false);
  expect(installsOnly("npm install && npm test")).toBe(false);
  expect(installsOnly("npm run install-deps")).toBe(false);
});

test("`runtime ci import` prints the file, writes it with --write, and never over one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-import-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), EXPRESS);
  writeFileSync(join(dir, ".github", "workflows", "notes.txt"), "not a workflow");
  // No key: it reads and writes this folder only.
  const env = {};
  const lines: string[] = [];
  const out = {
    json: false,
    write: (t: string) => lines.push(t),
    error: (t: string) => lines.push(`ERR ${t}`),
  };
  expect(await run(["ci", "import", dir], env, out)).toBe(0);
  expect(lines[0]).toStartWith("# Written by `runtime ci import` from .github/workflows/ci.yml.");
  lines.length = 0;
  expect(await run(["ci", "import", dir, "--write"], env, out)).toBe(0);
  expect(lines[0]).toContain("runtime.yml: 3 steps from 1 file, 7 notes");
  expect(readFileSync(join(dir, "runtime.yml"), "utf8")).toContain("name: Lint");
  await expect(run(["ci", "import", dir, "--write"], env, out)).rejects.toThrow(
    "is there already: --force writes over it",
  );
  expect(await run(["ci", "import", dir, "--write", "--force"], env, out)).toBe(0);
  await expect(run(["ci", "import", join(dir, "nothing-here")], env, out)).rejects.toThrow(
    "has neither .github/workflows/*.yml nor .circleci/config.yml",
  );
  // A Cloud Build or CodeBuild config needs no import: it runs as it is.
  const gcb = join(dir, "gcb");
  mkdirSync(gcb);
  writeFileSync(join(gcb, "cloudbuild.yaml"), "steps: [{name: node, args: [npm, test]}]\n");
  await expect(run(["ci", "import", gcb], env, out)).rejects.toThrow(
    "cloudbuild.yaml needs no import: CI/CD runs it as it is. Connect with",
  );
});

test("a value GitHub filled in is filled in by the shell, and its literal text is kept as written", () => {
  const made = importCi([
    {
      path: ".github/workflows/ci.yml",
      text: `
on: push
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$COMMIT|$TAG|$PLAIN"
        env:
          COMMIT: \${{ github.sha }}
          TAG: v-\${{ github.ref_name }}-'$HOME'
          PLAIN: a $b \`c\`
`,
    },
  ]);
  const [t] = steps<[Written]>(made.yaml);
  const out = Bun.spawnSync(["sh", "-c", t.run], {
    env: {
      RUNTIME_CI_COMMIT: "abc123",
      RUNTIME_CI_BRANCH: "main",
      HOME: "/h",
      PATH: process.env.PATH,
    },
  });
  expect(out.stdout.toString().trim()).toBe("abc123|v-main-'$HOME'|a $b `c`");
});

test("an install under a folder, after a cd or with the step's env stays in its step; one at the root goes to setup", () => {
  const made = importCi([
    {
      path: ".github/workflows/ci.yml",
      text: `
on: push
jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm ci
        working-directory: web
      - run: |
          cd api
          npm ci
      - run: npm ci
        env:
          NPM_CONFIG_PRODUCTION: "true"
`,
    },
  ]);
  expect(parse(made.yaml!).setup).toBe("npm ci");
  const [web] = steps<[Written]>(made.yaml);
  expect(web.run).toBe(
    "set -e\n(\n  cd 'web'\n  npm ci\n)\n(\n  cd api\n  npm ci\n)\n(\n  export NPM_CONFIG_PRODUCTION='true'\n  npm ci\n)",
  );
});

test("a job's timeout-minutes is its step's timeout in seconds; none keeps the 6-hour default", () => {
  const made = importCi([
    {
      path: ".github/workflows/ci.yml",
      text: `
on: [push]
jobs:
  suite:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps: [{ run: npm test }]
  plain:
    runs-on: ubuntu-latest
    steps: [{ run: npm run lint }]
  long:
    runs-on: ubuntu-latest
    timeout-minutes: 600
    steps: [{ run: make all }]
  odd:
    runs-on: ubuntu-latest
    timeout-minutes: \${{ inputs.minutes }}
    steps: [{ run: make odd }]
`,
    },
  ]);
  const [suite, plain, long, odd] = steps<(Written & { timeout?: number })[]>(made.yaml);
  // A 90-minute suite runs its 90 minutes, never cut at a default under it.
  expect(suite!.timeout).toBe(5400);
  expect(plain!.timeout).toBeUndefined();
  expect(long!.timeout).toBe(21600);
  expect(odd!.timeout).toBeUndefined();
  expect(made.notes).toEqual(
    expect.arrayContaining([
      expect.stringContaining("asks 600 minutes; a step here runs at most 360, as on GitHub"),
      expect.stringContaining("is not carried; the step has the default 6 hours"),
    ]),
  );
});
