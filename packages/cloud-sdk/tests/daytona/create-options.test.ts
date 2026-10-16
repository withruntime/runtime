import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError } from "../../src/errors";
import {
  Daytona,
  DaytonaConnectionError,
  DaytonaConnectionTimeoutError,
  DaytonaInvalidArgumentError,
  DaytonaProcessExecutionTimeoutError,
  DaytonaQueueTimeoutError,
  DaytonaSpotEvictedError,
  DaytonaTimeoutError,
  Image,
  NotSupportedError,
} from "../../src/daytona/index";
import { translate } from "../../src/daytona/errors";
import { DropInWorld } from "../drop-in-fake";

/* Options @daytona/sdk 0.223.1 takes that withruntime/daytona accepted and
   then dropped without a word: create's timeout, queueTimeout and kvm,
   pipInstallFromRequirements' pip options, and dockerfileCommands' build
   context. Each now does what Daytona's does, or refuses before anything
   happens. */

let world: DropInWorld;
let daytona: Daytona;
beforeEach(() => {
  world = new DropInWorld();
  daytona = new Daytona({ withruntime: { client: world.client() } });
});
const createOptions = () => world.called("sandboxes.create").at(-1)![1] as Record<string, unknown>;

describe("daytona.create options", () => {
  test("timeout bounds the create in milliseconds; 0 and none leave Runtime's own", async () => {
    await daytona.create({}, { timeout: 90 });
    expect(createOptions()).toEqual({ timeoutMs: 90_000 });
    await daytona.create({}, { timeout: 0 });
    expect(createOptions()).toEqual({});
    await daytona.create();
    expect(createOptions()).toEqual({});
  });

  test("a negative timeout is Daytona's invalid argument, before any request", async () => {
    const error = await daytona.create({}, { timeout: -1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaytonaInvalidArgumentError);
    expect((error as Error).message).toBe("Timeout must be a non-negative number");
    expect(world.called("sandboxes.create")).toEqual([]);
  });

  test("queueTimeout is the wait for room, in minutes, and must be a positive whole number", async () => {
    await daytona.create({ queueTimeout: 3 });
    expect(createOptions()).toMatchObject({ waitForCapacityMs: 180_000 });
    for (const queueTimeout of [0, 1.5, -2]) {
      const error = await daytona.create({ queueTimeout }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DaytonaInvalidArgumentError);
      expect((error as Error).message).toBe("queueTimeout must be a positive integer");
    }
  });

  test("no room within queueTimeout is a DaytonaQueueTimeoutError, which is a DaytonaTimeoutError", async () => {
    const client = world.client();
    const sandboxes = client.sandboxes as unknown as Record<string, unknown>;
    sandboxes.create = async (
      _input: unknown,
      options: { onCapacityWait?: (error: unknown, waitedMs: number) => void },
    ) => {
      const full = () =>
        new RuntimeError({
          message: "No room on any server.",
          code: "no_capacity",
          status: 503,
          hint: "Try again shortly.",
        });
      options.onCapacityWait?.(full(), 1000);
      throw full();
    };
    const error = await new Daytona({ withruntime: { client } })
      .create({ queueTimeout: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaytonaQueueTimeoutError);
    expect(error).toBeInstanceOf(DaytonaTimeoutError);
    expect((error as Error).message).toContain("queueTimeout of 1 minutes");
    expect((error as DaytonaQueueTimeoutError).code).toBe("no_capacity");
  });

  test("a refusal that was not a wait for room passes through as before", async () => {
    const client = world.client();
    (client.sandboxes as unknown as Record<string, unknown>).create = async () => {
      throw new RuntimeError({ message: "Bad.", code: "invalid_request", status: 400 });
    };
    const error = await new Daytona({ withruntime: { client } })
      .create({ queueTimeout: 1 })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(DaytonaQueueTimeoutError);
    expect((error as Error).message).toContain("Bad.");
  });

  test("kvm is refused before anything is created; kvm: false is no request at all", async () => {
    const error = await daytona.create({ kvm: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as NotSupportedError).alternative).toContain("/dev/kvm");
    expect(world.called("sandboxes.create")).toEqual([]);
    await daytona.create({ kvm: false });
    expect(world.called("sandboxes.create")).toHaveLength(1);
  });
});

describe("timeouts as Daytona names them", () => {
  test("a call's own deadline is DaytonaConnectionTimeoutError, and instanceof DaytonaTimeoutError matches it", () => {
    const out = translate(
      new RuntimeError({ message: "Ran past its deadline.", code: "timeout", status: 0 }),
    );
    expect(out).toBeInstanceOf(DaytonaConnectionTimeoutError);
    expect(out).toBeInstanceOf(DaytonaConnectionError);
    expect(out).toBeInstanceOf(DaytonaTimeoutError);
    // Only the base class widens, as in Daytona.
    expect(out).not.toBeInstanceOf(DaytonaProcessExecutionTimeoutError);
    expect(out).not.toBeInstanceOf(DaytonaQueueTimeoutError);
    const lost = translate(
      new RuntimeError({ message: "No answer.", code: "connection_error", status: 0 }),
    );
    expect(lost).toBeInstanceOf(DaytonaConnectionError);
    expect(lost).not.toBeInstanceOf(DaytonaTimeoutError);
  });

  test("DaytonaSpotEvictedError exists for code that names it", () => {
    expect(new DaytonaSpotEvictedError("x").name).toBe("DaytonaSpotEvictedError");
  });
});

describe("Image options", () => {
  test("pipInstallFromRequirements takes pipInstall's options as pip flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daytona-req-"));
    writeFileSync(join(dir, "requirements.txt"), "requests\n");
    const image = Image.debianSlim("3.12").pipInstallFromRequirements(
      join(dir, "requirements.txt"),
      {
        indexUrl: "https://pypi.example/simple",
        extraIndexUrls: ["https://extra.example/simple"],
        findLinks: ["https://links.example"],
        pre: true,
        extraOptions: "--no-cache-dir",
      },
    );
    await daytona.create({ image });
    const { dockerfile } = world.called("images.build")[0]![0] as { dockerfile: string };
    expect(dockerfile).toMatch(
      /RUN python -m pip install -r \/\.requirements\/[0-9a-f]{12}\.txt --index-url https:\/\/pypi\.example\/simple --extra-index-url https:\/\/extra\.example\/simple --find-links https:\/\/links\.example --pre --no-cache-dir/,
    );
  });

  test("dockerfileCommands refuses a context directory, and strictContext without one is Daytona's error", () => {
    expect(() => Image.base("python:3.12").dockerfileCommands(["COPY . /app"], "./ctx")).toThrow(
      NotSupportedError,
    );
    expect(() =>
      Image.base("python:3.12").dockerfileCommands(["RUN true"], undefined, {
        strictContext: true,
      }),
    ).toThrow(DaytonaInvalidArgumentError);
    expect(Image.base("python:3.12").dockerfileCommands(['RUN echo "hi"']).dockerfile).toContain(
      'RUN echo "hi"',
    );
  });
});
