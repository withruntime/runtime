package com.withruntime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

/**
 * {@code runtime.apps()} and {@code runtime.functions()}: copies of one server that wake on
 * demand, behind one URL. Create one, then {@link #deploy} an image or a build; an App can keep
 * copies awake, a Function keeps none. The same verbs serve both, at /v1/apps and /v1/functions.
 *
 * <p>In private beta: an account outside the beta is refused with {@link
 * RuntimeCloudException.PermissionDenied}, code product_in_beta (403).
 */
public final class Apps {
  /** States a wait for live or deleted ends at, answering with the record's error. */
  private static final Set<String> SETTLED = Set.of("failed", "deleted", "live");

  /** States a deploy ends in. */
  private static final Set<String> ENDED = Set.of("live", "failed", "superseded");

  private final Transport t;
  private final String base;

  Apps(Transport transport, String plural) {
    this.t = transport;
    this.base = "/v1/" + plural;
  }

  private String path(String id, String rest) {
    return base + "/" + Transport.segment(id) + rest;
  }

  /** Creates one waiting for its first version. */
  public App create(CreateApp input) {
    return new App(t.object(new Transport.Call("POST", base).body(input.toMap()).key(input.idempotencyKey)));
  }

  public App get(String id) {
    return get(id, null, null);
  }

  /**
   * Reads one; with waitFor, the server holds the answer until that state, up to timeoutSeconds
   * (1 to 60, default 30). Check the returned state: a wait that ran out answers as it is.
   */
  public App get(String id, String waitFor, Integer timeoutSeconds) {
    return new App(t.object(getCall(id, waitFor, timeoutSeconds)));
  }

  private Transport.Call getCall(String id, String waitFor, Integer timeoutSeconds) {
    return new Transport.Call("GET", path(id, "")).query("waitFor", waitFor).query("timeoutSeconds", timeoutSeconds);
  }

  /** The first page; the default states are waiting, live and failed. */
  public Page<App> list() {
    return list(null);
  }

  public Page<App> list(ListResources filter) {
    return ListResources.read(t, base, filter, App::new);
  }

  public App update(String id, UpdateApp input) {
    return new App(t.object(new Transport.Call("POST", path(id, ":update")).body(input.toMap()).key(input.idempotencyKey)));
  }

  /** Starts deleting it and returns at once. */
  public App delete(String id) {
    return new App(t.object(new Transport.Call("DELETE", path(id, ""))));
  }

  /**
   * Deletes it and waits until it is deleted, under one deadline and one idempotency key, made
   * before the call unless given: a timed-out delete is retried safely with that same key.
   */
  public App delete(String id, WaitOptions options) {
    WaitOptions wait = options == null ? new WaitOptions() : options;
    String key = wait.idempotencyKey != null ? wait.idempotencyKey : UUID.randomUUID().toString();
    return Following.run(wait, key, f -> follow(id, "deleted", f, new App(t.object(f.bound(new Transport.Call("DELETE", path(id, "")))))));
  }

  /**
   * Waits for live or deleted, following the resource's state, not a deploy's: an older live
   * version can outlive a failed rollout of a newer one. Ending in another settled state (failed,
   * deleted or live) throws with the record's error, or unexpected_state.
   */
  public App wait(String id, String target) {
    return wait(id, target, null);
  }

  public App wait(String id, String target, WaitOptions options) {
    return Following.run(options, null, f -> follow(id, target, f, null));
  }

  private App follow(String id, String target, Following f, App initial) {
    App record = initial != null ? initial : new App(t.object(f.bound(getCall(id, null, null))));
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
      record = new App(t.object(f.bound(getCall(id, null, null))));
    }
  }

  /** Starts a deploy of an image or a build beside the live version, and returns at once. */
  public AppDeploy deploy(String id, DeployApp input) {
    return new AppDeploy(t.object(new Transport.Call("POST", path(id, "/deploys")).body(input.toMap()).key(input.idempotencyKey)));
  }

  /**
   * Deploys and waits until the deploy is live, failed or superseded, with its URL and version or
   * its failure (code, hint, lastOutput). A failed deploy returns, it does not throw: the old
   * version keeps serving. One idempotency key covers the write and the wait.
   */
  public AppDeploy deploy(String id, DeployApp input, WaitOptions options) {
    WaitOptions wait = options == null ? new WaitOptions() : options;
    return writeDeploy(id, "/deploys", input.toMap(), input.idempotencyKey != null ? input.idempotencyKey : wait.idempotencyKey, wait);
  }

  public AppDeploy getDeploy(String id, String deployId) {
    return getDeploy(id, deployId, null, null);
  }

  /**
   * Reads one deploy; with waitFor, the server follows it up to timeoutSeconds (1 to 60). Live,
   * failed or superseded also end that wait; one that ran out answers its pending state.
   */
  public AppDeploy getDeploy(String id, String deployId, String waitFor, Integer timeoutSeconds) {
    return new AppDeploy(t.object(deployCall(id, deployId, waitFor, timeoutSeconds)));
  }

  private Transport.Call deployCall(String id, String deployId, String waitFor, Integer timeoutSeconds) {
    return new Transport.Call("GET", path(id, "/deploys/" + Transport.segment(deployId)))
        .query("waitFor", waitFor)
        .query("timeoutSeconds", timeoutSeconds);
  }

  /** Resumes waiting for a deploy by its id, after a process restart, without another version. */
  public AppDeploy waitDeploy(String id, String deployId) {
    return waitDeploy(id, deployId, null);
  }

  public AppDeploy waitDeploy(String id, String deployId, WaitOptions options) {
    return Following.run(options, options == null ? null : options.idempotencyKey,
        f -> followDeploy(id, new AppDeploy(t.object(f.bound(deployCall(id, deployId, null, null)))), f));
  }

  /** Returns to the previous version without a build, and returns the deploy at once. */
  public AppDeploy rollback(String id) {
    return new AppDeploy(t.object(new Transport.Call("POST", path(id, "/rollback")).body(Map.of())));
  }

  /** Rolls back and waits as {@link #deploy(String, DeployApp, WaitOptions)} does. */
  public AppDeploy rollback(String id, WaitOptions options) {
    WaitOptions wait = options == null ? new WaitOptions() : options;
    return writeDeploy(id, "/rollback", Map.of(), wait.idempotencyKey, wait);
  }

  private AppDeploy writeDeploy(String id, String verb, Map<String, Object> body, String given, WaitOptions wait) {
    String key = given != null ? given : UUID.randomUUID().toString();
    return Following.run(wait, key, f -> followDeploy(id, new AppDeploy(t.object(f.bound(new Transport.Call("POST", path(id, verb)).body(body)))), f));
  }

  private AppDeploy followDeploy(String id, AppDeploy record, Following f) {
    while (!ENDED.contains(record.state())) {
      record = new AppDeploy(t.object(f.bound(deployCall(id, record.id(), "live", 60))));
      if (!ENDED.contains(record.state())) f.pause();
    }
    return record;
  }

  /** Every version, the live and previous ones marked. */
  public List<AppVersion> versions(String id) {
    return items(t.json(new Transport.Call("GET", path(id, "/versions"))), AppVersion::new);
  }

  /** Every copy, with its version, region, state and when that state began. */
  public List<AppCopy> copies(String id) {
    return items(t.json(new Transport.Call("GET", path(id, "/copies"))), AppCopy::new);
  }

  private static <T> List<T> items(Object answer, Function<Map<String, Object>, T> make) {
    List<T> out = new ArrayList<>();
    if (answer instanceof List<?> list) for (Object item : list) out.add(make.apply(JsonObject.map(item)));
    return out;
  }
}
