import { describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import {
  App,
  CompatibilityError,
  Environment,
  EnvironmentAppsService,
  EnvironmentObjectsService,
  ModalClient,
  NotFoundError,
} from "../../src/modal/index.js";

/* What modal 0.11.1 added over 0.11.0 for sandboxes: name lookup of a
   terminated sandbox (includeTerminated), Environments, App.info and a
   VolumeFS version option. The first is served on Runtime; the rest refuse
   before any request, naming Runtime's way. Before, includeTerminated and
   version were refused as unknown options and the rest were undefined. */

type Native = {
  id: string;
  state: string;
  info: { labels: Record<string, string>; createdAt: string; endedAt: string | null };
};
function world(sandboxes: Native[]) {
  const requests: string[] = [];
  const process = {
    id: "proc-1",
    wait: () => new Promise(() => undefined),
    refresh: async () => ({ state: "exited", exitCode: 0 }),
    write: async () => undefined,
    output: async function* () {},
    outputBytes: async function* () {},
  };
  const runtime = {
    sandboxes: {
      list: async () => {
        requests.push("list");
        return sandboxes;
      },
      get: async (id: string) => {
        requests.push(`get ${id}`);
        const found = sandboxes.find((s) => s.id === id)!;
        return { ...found, processes: { get: async () => process } };
      },
    },
    volumes: {
      list: async () => {
        requests.push("volumes");
        return { data: [] };
      },
    },
  };
  return { modal: new ModalClient({ client: runtime as unknown as Runtime }), requests };
}
const box = (id: string, state: string, endedAt: string | null, name = "job"): Native => ({
  id,
  state,
  info: {
    labels: {
      "compat.provider": "modal",
      "modal.app": "app",
      "modal.name": name,
      "modal.entrypoint": "proc-1",
    },
    createdAt: "2026-10-16T00:00:00.000Z",
    endedAt,
  },
});

describe("modal 0.11.1", () => {
  test("reports the version it implements", () => {
    expect(world([]).modal.version()).toBe("0.11.1");
  });

  test("includeTerminated finds the sandbox that stopped last when none of the name runs", async () => {
    const { modal } = world([
      box("old", "stopped", "2026-10-16T01:00:00.000Z"),
      box("last", "stopped", "2026-10-16T03:00:00.000Z"),
      box("other", "stopped", "2026-10-16T05:00:00.000Z", "other"),
      box("middle", "stopped", "2026-10-16T02:00:00.000Z"),
    ]);
    await expect(modal.sandboxes.fromName("app", "job")).rejects.toBeInstanceOf(NotFoundError);
    const found = await modal.sandboxes.fromName("app", "job", { includeTerminated: true });
    expect(found.sandboxId).toBe("last");
    const experimental = await modal.sandboxes.experimentalFromName("app", "job", {
      includeTerminated: true,
    });
    expect(experimental.sandboxId).toBe("last");
    await expect(
      modal.sandboxes.fromName("app", "none", { includeTerminated: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a running sandbox of the name still wins over a terminated one", async () => {
    const { modal } = world([
      box("stopped", "stopped", "2026-10-16T09:00:00.000Z"),
      box("running", "running", null),
    ]);
    const found = await modal.sandboxes.fromName("app", "job", { includeTerminated: true });
    expect(found.sandboxId).toBe("running");
  });

  test("a VolumeFS version is refused before any request", async () => {
    const { modal, requests } = world([]);
    await expect(modal.volumes.fromName("data", { version: 2 })).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    expect(requests).toEqual([]);
  });

  test("Environments and App.info refuse, naming Runtime's way", async () => {
    const { modal, requests } = world([]);
    await expect(modal.environments.fromName("prod")).rejects.toThrow(/client\.apps\.fromName/);
    expect(() => modal.environments.objects).toThrow(CompatibilityError);
    for (const refused of [Environment, EnvironmentAppsService, EnvironmentObjectsService])
      expect(() => refused()).toThrow(/no Modal environments/);
    await expect(new App("app", "app").info()).rejects.toThrow(/client\.sandboxes\.list/);
    expect(requests).toEqual([]);
  });
});
