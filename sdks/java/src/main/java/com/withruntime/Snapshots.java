package com.withruntime;

/**
 * {@code runtime.snapshots()}. Take one with {@link Sandbox#snapshot}, start from one with
 * {@link CreateSandbox#snapshot}, or do both with {@link Sandbox#fork}.
 */
public final class Snapshots {
  private final Transport t;

  Snapshots(Transport transport) {
    this.t = transport;
  }

  private static String path(String id, String verb) {
    return "/v1/snapshots/" + Transport.segment(id) + verb;
  }

  /** Snapshots a sandbox by id, as it is: the API answers how the sandbox must be. */
  public Snapshot create(String sandboxId, SnapshotOptions options) {
    return new Snapshot(
        t.object(
            new Transport.Call("POST", "/v1/sandboxes/" + Transport.segment(sandboxId) + ":snapshot")
                .body(options.toMap())
                .waitSeconds(10)
                .key(options.idempotencyKey)));
  }

  public Snapshot get(String id) {
    return new Snapshot(t.object(new Transport.Call("GET", path(id, ""))));
  }

  /** The first page of snapshots; any filter may be null. state is capturing, ready, failed or deleting. */
  public Page<Snapshot> list(String sandboxId, String name, String state) {
    return Page.read(t, call(sandboxId, name, state, null), Snapshot::new, cursor -> call(sandboxId, name, state, cursor));
  }

  private static Transport.Call call(String sandboxId, String name, String state, String cursor) {
    return new Transport.Call("GET", "/v1/snapshots").query("sandboxId", sandboxId).query("name", name).query("state", state).query("cursor", cursor);
  }

  public void delete(String id) {
    t.json(new Transport.Call("POST", path(id, ":delete")).body(java.util.Map.of()));
  }

  /** Keeps a snapshot for retentionDays from now. */
  public Snapshot extend(String id, int retentionDays) {
    return new Snapshot(t.object(new Transport.Call("POST", path(id, ":extend")).body(java.util.Map.of("retentionDays", retentionDays))));
  }
}
