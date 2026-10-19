package com.withruntime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * {@code runtime.containers()}: one OCI image's process on its own microVM, billed at the sandbox
 * rates, at /v1/containers. It never sleeps unless asked; on exit it restarts when it serves a
 * port, else it stops.
 *
 * <p>In private beta: an account outside the beta is refused with {@link
 * RuntimeCloudException.PermissionDenied}, code product_in_beta (403).
 */
public final class Containers {
  /** States a wait ends at, answering with the record's error. */
  private static final Set<String> SETTLED = Set.of("failed", "deleted");

  private final Transport t;

  Containers(Transport transport) {
    this.t = transport;
  }

  private static String path(String id, String rest) {
    return "/v1/containers/" + Transport.segment(id) + rest;
  }

  /** Runs one copy of the image and returns at once. */
  public Container create(Create input) {
    return new Container(t.object(new Transport.Call("POST", "/v1/containers").body(input.toMap()).key(input.idempotencyKey)));
  }

  public Container get(String id) {
    return get(id, null, null);
  }

  /**
   * Reads one; with waitFor, the server holds the answer until that state, up to timeoutSeconds
   * (1 to 60, default 30). Check the returned state: a wait that ran out answers as it is.
   */
  public Container get(String id, String waitFor, Integer timeoutSeconds) {
    return new Container(t.object(getCall(id, waitFor, timeoutSeconds)));
  }

  private Transport.Call getCall(String id, String waitFor, Integer timeoutSeconds) {
    return new Transport.Call("GET", path(id, "")).query("waitFor", waitFor).query("timeoutSeconds", timeoutSeconds);
  }

  /** The first page; the default states are all but deleting and deleted. */
  public Page<Container> list() {
    return list(null);
  }

  public Page<Container> list(ListResources filter) {
    return ListResources.read(t, "/v1/containers", filter, Container::new);
  }

  /** Renames it or replaces its labels; nothing else changes. */
  public Container update(String id, Update input) {
    return new Container(t.object(new Transport.Call("POST", path(id, ":update")).body(input.toMap()).key(input.idempotencyKey)));
  }

  /** Starts deleting it, which stops its process, and returns at once. */
  public Container delete(String id) {
    return new Container(t.object(new Transport.Call("DELETE", path(id, ""))));
  }

  /**
   * Deletes it and waits until it is deleted, under one deadline and one idempotency key, made
   * before the call unless given: a timed-out delete is retried safely with that same key.
   */
  public Container delete(String id, WaitOptions options) {
    WaitOptions wait = options == null ? new WaitOptions() : options;
    String key = wait.idempotencyKey != null ? wait.idempotencyKey : UUID.randomUUID().toString();
    return Following.run(wait, key, f -> follow(id, "deleted", f, new Container(t.object(f.bound(new Transport.Call("DELETE", path(id, "")))))));
  }

  /** Waits for target (running, say); reaching failed or deleted first throws with its error. */
  public Container wait(String id, String target) {
    return wait(id, target, null);
  }

  public Container wait(String id, String target, WaitOptions options) {
    return Following.run(options, null, f -> follow(id, target, f, null));
  }

  private Container follow(String id, String target, Following f, Container initial) {
    Container record = initial != null ? initial : new Container(t.object(f.bound(getCall(id, null, null))));
    while (true) {
      if (target.equals(record.state())) return record;
      if (SETTLED.contains(record.state())) {
        JsonObject error = record.error();
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("id", id);
        details.put("state", record.state());
        details.put("target", target);
        details.put("resource", record.raw());
        throw new RuntimeCloudException(
            error != null && error.getString("message") != null
                ? error.getString("message")
                : "Expected " + target + ", but " + id + " reached " + record.state() + ".",
            error != null && error.getString("code") != null ? error.getString("code") : "unexpected_state",
            0,
            "Read the resource and inspect its error before starting another change.",
            null,
            details,
            f.key,
            null,
            null);
      }
      f.pause();
      record = new Container(t.object(f.bound(getCall(id, null, null))));
    }
  }

  /** A container: one OCI image's process on its own microVM. */
  public static final class Container extends JsonObject {
    Container(Map<String, Object> raw) {
      super(raw);
    }

    public String id() {
      return getString("id");
    }

    public String name() {
      return getString("name");
    }

    public Map<String, String> labels() {
      return getStringMap("labels");
    }

    /** waiting, running, sleeping, stopped, failed, deleting or deleted. */
    public String state() {
      return getString("state");
    }

    /** Why it failed, with code and message; null when it has not. */
    public JsonObject error() {
      return has("error") ? getObject("error") : null;
    }

    /** The image it runs, pinned to its digest (name@sha256:...). */
    public String image() {
      return getString("image");
    }

    public List<String> entrypoint() {
      return getStrings("entrypoint");
    }

    public List<String> command() {
      return getStrings("command");
    }

    public String workingDir() {
      return getString("workingDir");
    }

    public String user() {
      return getString("user");
    }

    /** The TCP port it serves on, or null when it serves none. */
    public Integer port() {
      Long port = getLong("port");
      return port == null ? null : port.intValue();
    }

    /** The image's exposed ports, as N/tcp or N/udp. */
    public List<String> exposedPorts() {
      return getStrings("exposedPorts");
    }

    /** restart or stop. */
    public String onExit() {
      return getString("onExit");
    }

    public boolean sleep() {
      return getBoolean("sleep");
    }

    public int vcpu() {
      return (int) getLong("vcpu", 0);
    }

    public int memoryMiB() {
      return (int) getLong("memoryMiB", 0);
    }

    /** The environment's names. Values are never answered: they may be secrets. */
    public List<String> envNames() {
      return getStrings("envNames");
    }

    /** Unix milliseconds. */
    public long createdAt() {
      return getLong("createdAt", 0);
    }

    public long updatedAt() {
      return getLong("updatedAt", 0);
    }

    /** Unix milliseconds, or null while it is not deleted. */
    public Long deletedAt() {
      return getLong("deletedAt");
    }
  }

  /**
   * A new container's fields. The three in the constructor are required; the rest have the API's
   * defaults, which this SDK does not override.
   */
  public static final class Create extends Params<Create> {
    /**
     * @param image an OCI image reference; the answer pins its digest
     * @param vcpu 1 to 16
     * @param memoryMiB 128 to 65536
     */
    public Create(String image, int vcpu, int memoryMiB) {
      set("image", image);
      set("vcpu", vcpu);
      set("memoryMiB", memoryMiB);
    }

    /** Up to 128 letters, digits, dots, dashes or underscores; alphanumeric first. */
    public Create name(String name) {
      return set("name", name);
    }

    /** At most 32 labels, each value at most 256 characters. */
    public Create labels(Map<String, String> labels) {
      return set("labels", new LinkedHashMap<>(labels));
    }

    /** Replaces the image's Entrypoint and drops its Cmd. */
    public Create entrypoint(String... entrypoint) {
      return set("entrypoint", List.of(entrypoint));
    }

    /** Replaces the image's Cmd; the effective entrypoint stays. */
    public Create command(String... command) {
      return set("command", List.of(command));
    }

    /** Set over the image's own environment; only the names are read back. */
    public Create env(Map<String, String> env) {
      return set("env", new LinkedHashMap<>(env));
    }

    /** An absolute path; the image's, else /. */
    public Create workingDir(String workingDir) {
      return set("workingDir", workingDir);
    }

    /** The image's user, else root. */
    public Create user(String user) {
      return set("user", user);
    }

    /** 1 to 65535; required when the image exposes several TCP ports. */
    public Create port(int port) {
      return set("port", port);
    }

    /** restart or stop; by default restart when it serves a port, else stop. */
    public Create onExit(String onExit) {
      return set("onExit", onExit);
    }

    /** Sleep when idle; it never does unless set. */
    public Create sleep(boolean sleep) {
      return set("sleep", sleep);
    }
  }

  /** A container's name and labels changed in place. A field left out stays as it is. */
  public static final class Update extends Params<Update> {
    public Update() {}

    /** A new name; null clears it. */
    public Update name(String name) {
      body.put("name", name);
      return this;
    }

    public Update labels(Map<String, String> labels) {
      return set("labels", new LinkedHashMap<>(labels));
    }
  }
}
