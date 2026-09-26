package com.withruntime;

import java.time.Duration;
import java.util.Map;

/** {@code runtime.sandboxes()}: create, find and list sandboxes. */
public final class Sandboxes {
  private final Transport t;

  Sandboxes(Transport transport) {
    this.t = transport;
  }

  /** Creates a sandbox on the free trial (while it lasts) and waits until it runs. */
  public Sandbox create() {
    return create(new CreateSandbox());
  }

  /**
   * Creates a sandbox and, unless {@link CreateSandbox#noWait()}, waits until it is running. When
   * every trial slot or the account's quota is taken, it waits for one to free, up to the
   * client's waitForCapacity (two minutes by default).
   */
  public Sandbox create(CreateSandbox options) {
    Duration room = options.waitForCapacity != null ? options.waitForCapacity : t.waitForCapacity;
    Map<String, Object> info =
        t.object(
            new Transport.Call("POST", "/v1/sandboxes")
                .body(options.toMap())
                .waitSeconds(options.noWait ? 0 : 60)
                .key(options.idempotencyKey)
                .room(room.isNegative() ? Duration.ZERO : room));
    Sandbox sandbox = new Sandbox(t, info);
    if (!options.noWait && !"running".equals(sandbox.state())) {
      sandbox.waitFor("running", Duration.ofSeconds(60));
      if (!"running".equals(sandbox.state()))
        throw new RuntimeCloudException(
            "Sandbox " + sandbox.id() + " is " + sandbox.state() + ", not running.",
            "start_failed",
            "Read it with runtime.sandboxes().get(id); stopReason says why.");
    }
    return sandbox;
  }

  /**
   * The sandbox named {@code name}, ready to use: running as it is, woken if paused, restarted if
   * stopped and persistent, or created with {@code options} when no sandbox has the name.
   * {@code info().reused()} says which.
   */
  public Sandbox getOrCreate(String name, CreateSandbox options) {
    return create(options.name(name).set("getOrCreate", true));
  }

  /** Reconnects to a sandbox by id. */
  public Sandbox get(String id) {
    return new Sandbox(t, t.object(new Transport.Call("GET", "/v1/sandboxes/" + Transport.segment(id))));
  }

  /** The first page of live sandboxes, oldest first. Iterating the page walks every one. */
  public Page<Sandbox> list() {
    return list(new ListSandboxes());
  }

  public Page<Sandbox> list(ListSandboxes filter) {
    return Page.read(t, call(filter, null), info -> new Sandbox(t, info), cursor -> call(filter, cursor));
  }

  private static Transport.Call call(ListSandboxes filter, String cursor) {
    Transport.Call call = new Transport.Call("GET", "/v1/sandboxes");
    for (String state : filter.states) call.query("state", state);
    if (filter.includeStopped) call.query("includeStopped", "true");
    filter.labels.forEach((key, value) -> call.query("label", key + ":" + value));
    call.query("name", filter.name).query("limit", filter.limit).query("cursor", cursor);
    return call;
  }
}
