package com.withruntime;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * One workflow ({@link Agents.Workflows}): many sessions in phases, fanned out and pipelined, with
 * limits and a cost cap. Follow its changes, wait for its result, list its steps or stop it.
 *
 * <pre>{@code
 * AgentWorkflow flow = runtime.agents().workflows().run(Map.of("agent", "dev", "phases", List.of(
 *     Map.of("name", "fix", "input", "Fix {{item}}", "each", List.of("a.ts", "b.ts")))));
 * try (EventStream<AgentWorkflow.Info> changes = flow.follow()) {
 *   for (AgentWorkflow.Info now : changes) System.out.println(now.phases());
 * }
 * System.out.println(flow.waitFor().result());
 * }</pre>
 */
public final class AgentWorkflow {
  private static final int LONG_POLL_SECONDS = 30;

  private final Transport t;
  private final String id;
  private Info info;

  AgentWorkflow(Transport transport, Info info) {
    this.t = transport;
    this.id = info.id();
    this.info = info;
  }

  static String path(String id, String verb) {
    return "/v1/agents/workflows/" + Transport.segment(id) + verb;
  }

  public String id() {
    return id;
  }

  /** The workflow as last read. */
  public Info info() {
    return info;
  }

  /** Reads it again. */
  public Info refresh() {
    info = new Info(t.object(new Transport.Call("GET", path(id, ""))));
    return info;
  }

  private Info poll(long after, Transport.Cancellation cancellation) {
    // The server holds the read up to 30 seconds; the call's own deadline is longer than that.
    Duration room = Duration.ofSeconds(LONG_POLL_SECONDS + 15L);
    Transport.Call call =
        new Transport.Call("GET", path(id, ""))
            .query("after", after)
            .query("wait", LONG_POLL_SECONDS)
            .timeout(t.timeout.compareTo(room) >= 0 ? t.timeout : room);
    if (cancellation != null) call.cancellation(cancellation);
    info = new Info(t.object(call));
    return info;
  }

  /** Every change from the start, as it happens; it ends when the workflow has. */
  public EventStream<Info> follow() {
    return follow(0);
  }

  /**
   * Each change after version {@code after}, as it happens: each read waits up to 30 seconds on
   * the server for one. It ends once the workflow has ended. Close it to stop early.
   */
  public EventStream<Info> follow(long after) {
    Transport.Cancellation cancellation = new Transport.Cancellation();
    return new EventStream<>() {
      private long version = after;
      private boolean ended;

      @Override
      Info pull() {
        while (!ended && !isClosed()) {
          Info now;
          try {
            now = poll(version, cancellation);
          } catch (RuntimeCloudException failure) {
            if (isClosed()) return null;
            throw failure;
          }
          ended = now.ended();
          if (now.version() > version) {
            version = now.version();
            return now;
          }
        }
        return null;
      }

      @Override
      public void close() {
        super.close();
        cancellation.cancel();
      }
    };
  }

  /**
   * Waits until it has ended and returns it, its result set; a failed workflow is returned, not
   * thrown. It waits on the server and never polls on a timer.
   */
  public Info waitFor() {
    Info now = refresh();
    while (!now.ended()) now = poll(now.version(), null);
    return now;
  }

  /** Its steps in phase and item order. */
  public Page<Step> steps() {
    return steps(null, null, null);
  }

  /**
   * The page at cursor (null: the first) of its steps in these states (pending, running, done,
   * failed, stopped, skipped; null: all), at most limit (null: the API's default).
   */
  public Page<Step> steps(List<String> states, String cursor, Integer limit) {
    return Page.read(t, stepsCall(states, cursor, limit), Step::new, next -> stepsCall(states, next, limit));
  }

  private Transport.Call stepsCall(List<String> states, String cursor, Integer limit) {
    Transport.Call call = new Transport.Call("GET", path(id, "/steps"));
    if (states != null) for (String state : states) call.query("state", state);
    return call.query("cursor", cursor).query("limit", limit);
  }

  /** Stops it: nothing more starts, and its open sessions are asked to stop. */
  public Info stop() {
    info = new Info(t.object(new Transport.Call("POST", path(id, "/stop")).body(Map.of())));
    return info;
  }

  /** A workflow as the API returns it. */
  public static final class Info extends JsonObject {
    Info(Map<String, Object> raw) {
      super(raw);
    }

    public String id() {
      return getString("id");
    }

    public String name() {
      return getString("name");
    }

    /** running, done, failed or stopped. */
    public String state() {
      return getString("state");
    }

    public boolean ended() {
      return !"running".equals(state());
    }

    /** Why it ended: done, failed, stopped, budget, quota, parent_ended, among others; or null. */
    public String reason() {
      return getString("reason");
    }

    /** One step's result as it is, or a JSON array of the last phase's results; null until it ends. */
    public String result() {
      return getString("result");
    }

    /** The session that ran it, or null for one run through the API. */
    public String parentSessionId() {
      return getString("parentSessionId");
    }

    public JsonObject spec() {
      return getObject("spec");
    }

    public long maxSessions() {
      return getLong("maxSessions", 0);
    }

    public long maxConcurrent() {
      return getLong("maxConcurrent", 0);
    }

    public Double maxDollars() {
      return getDouble("maxDollars");
    }

    /** The sessions it has started. */
    public long started() {
      return getLong("started", 0);
    }

    /** One more on every change. */
    public long version() {
      return getLong("version", 0);
    }

    public Map<String, String> labels() {
      return getStringMap("labels");
    }

    /**
     * Each phase's progress: {@code name}, {@code agentId}, {@code total}, {@code ready} (false while
     * its items are not all known), {@code pending}, {@code running}, {@code done}, {@code failed}.
     */
    public List<JsonObject> phases() {
      return getObjects("phases");
    }

    /** What its sessions have used: {@code dollars}, {@code vcpuSeconds}, {@code gibSeconds}. */
    public JsonObject cost() {
      return getObject("cost");
    }

    public Instant createdAt() {
      return getInstant("createdAt");
    }

    public Instant updatedAt() {
      return getInstant("updatedAt");
    }

    public Instant endedAt() {
      return getInstant("endedAt");
    }
  }

  /** One item of one phase, and the session it started. */
  public static final class Step extends JsonObject {
    Step(Map<String, Object> raw) {
      super(raw);
    }

    public String phase() {
      return getString("phase");
    }

    public long item() {
      return getLong("item", 0);
    }

    public String itemText() {
      return getString("itemText");
    }

    /** pending, running, done, failed, stopped or skipped. */
    public String state() {
      return getString("state");
    }

    public String reason() {
      return getString("reason");
    }

    public String result() {
      return getString("result");
    }

    public String sessionId() {
      return getString("sessionId");
    }
  }
}
