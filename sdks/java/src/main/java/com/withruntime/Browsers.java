package com.withruntime;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/**
 * {@code runtime.browsers()}: a task in plain words, done by an agent that browses in a sandbox
 * with Chromium, at /v1/browsers/runs.
 *
 * <pre>{@code
 * Browsers.Run run = runtime.browsers().run(new Browsers.RunInput("Find the price of the cheapest plan on withruntime.com"));
 * System.out.println(run.state() + " " + (run.output() != null ? run.output() : run.error()));
 * }</pre>
 *
 * <p>The model's key is your egress secret: ANTHROPIC_API_KEY for claude- models (the default,
 * claude-sonnet-5-5), OPENAI_API_KEY for gpt- and o-series, GEMINI_API_KEY for gemini-. A run is
 * billed as its sandbox's time, at the sandbox rates; the model's use is on your key.
 *
 * <p>In private beta: an account outside the beta is refused with {@link
 * RuntimeCloudException.PermissionDenied}, code product_in_beta (403).
 */
public final class Browsers {
  /** Each read of a run's steps waits up to this long on the server for one. */
  static final int STEPS_WAIT_SECONDS = 30;

  private static final Set<String> ENDED = Set.of("done", "failed", "stopped");

  private final Runs runs;

  Browsers(Transport transport) {
    this.runs = new Runs(transport);
  }

  /** Starts, reads, follows and stops runs. */
  public Runs runs() {
    return runs;
  }

  /** Does the task in a browser and returns the run once it has ended: output once done, error once failed. */
  public Run run(RunInput input) {
    return runs.waitFor(runs.create(input).id());
  }

  /** {@code runtime.browsers().runs()}. */
  public static final class Runs {
    private final Transport t;

    Runs(Transport transport) {
      this.t = transport;
    }

    private static String path(String id, String rest) {
      return "/v1/browsers/runs/" + Transport.segment(id) + rest;
    }

    /** Starts a run and returns it at once (state queued). */
    public Run create(RunInput input) {
      return new Run(t.object(new Transport.Call("POST", "/v1/browsers/runs").body(input.toMap()).key(input.idempotencyKey)));
    }

    public Run get(String id) {
      return new Run(t.object(new Transport.Call("GET", path(id, ""))));
    }

    /** The first page of runs, newest first; iterating walks every page. */
    public Page<Run> list(Integer limit) {
      return Page.read(
          t,
          new Transport.Call("GET", "/v1/browsers/runs").query("limit", limit),
          Run::new,
          cursor -> new Transport.Call("GET", "/v1/browsers/runs").query("limit", limit).query("cursor", cursor));
    }

    /**
     * One page of its steps after seq {@code after}. With {@code waitSeconds} (up to 30) the server
     * holds the answer for a step; frames false leaves each step's page out.
     */
    public Steps steps(String id, long after, boolean frames, Integer waitSeconds) {
      Transport.Call call = new Transport.Call("GET", path(id, "/steps")).query("after", after);
      if (!frames) call.query("frames", false);
      if (waitSeconds != null && waitSeconds > 0) {
        Duration room = Duration.ofSeconds(waitSeconds + 15L);
        call.query("wait", waitSeconds).timeout(t.timeout.compareTo(room) >= 0 ? t.timeout : room);
        return new Steps(JsonObject.map(t.poll(call)));
      }
      return new Steps(t.object(call));
    }

    /**
     * Calls each with every step after {@code after}, as each comes, until the run ends: its
     * recording. Each read waits on the server, not a timer. A false from each stops it.
     */
    public void follow(String id, long after, boolean frames, Predicate<Step> each) {
      while (true) {
        Steps page = steps(id, after, frames, STEPS_WAIT_SECONDS);
        for (Step step : page.data()) if (!each.test(step)) return;
        after = page.after();
        if (page.ended() && page.data().isEmpty()) return;
      }
    }

    /** Stops it; its sandbox is deleted and its steps are kept. */
    public Run stop(String id) {
      return new Run(t.object(new Transport.Call("POST", path(id, ":stop")).body(new LinkedHashMap<>())));
    }

    /** The run once it has ended (done, failed or stopped); a failed run is returned, not thrown: read error. */
    public Run waitFor(String id) {
      Run run = get(id);
      if (ENDED.contains(run.state())) return run;
      follow(id, 0, false, step -> true);
      return get(id);
    }
  }

  /** A run's fields: the task is required; the API's defaults fill in the rest. */
  public static final class RunInput extends Params<RunInput> {
    /** @param task what to do, in plain words; at most 16 KiB */
    public RunInput(String task) {
      set("task", task);
    }

    /** Opened before the agent's first step. */
    public RunInput startUrl(String startUrl) {
      return set("startUrl", startUrl);
    }

    /** A claude-, gpt-, o1, o3, o4 or gemini- model; claude-sonnet-5-5 unless set. */
    public RunInput model(String model) {
      return set("model", model);
    }

    /** 1 to 200; 30 unless set. */
    public RunInput maxSteps(int maxSteps) {
      return set("maxSteps", maxSteps);
    }

    /** Only these domains are opened (example.com, *.example.com). */
    public RunInput allowedDomains(String... domains) {
      return set("allowedDomains", List.of(domains));
    }

    public RunInput labels(Map<String, String> labels) {
      return set("labels", new LinkedHashMap<>(labels));
    }
  }

  /** A run. */
  public static final class Run extends JsonObject {
    Run(Map<String, Object> raw) {
      super(raw);
    }

    public String id() {
      return getString("id");
    }

    /** queued, running, done, failed or stopped. */
    public String state() {
      return getString("state");
    }

    public String task() {
      return getString("task");
    }

    public String model() {
      return getString("model");
    }

    /** The agent's answer, once done. */
    public String output() {
      return getString("output");
    }

    /** Why it failed, and what to do. */
    public String error() {
      return getString("error");
    }

    public long steps() {
      return getLong("steps", 0);
    }

    /** The page the browser ended on. */
    public String url() {
      return getString("url");
    }

    public String sandboxId() {
      return getString("sandboxId");
    }
  }

  /** One step: the page the agent saw and what it did. */
  public static final class Step extends JsonObject {
    Step(Map<String, Object> raw) {
      super(raw);
    }

    /** 0 is the page before the first step; the last is the page at the end. */
    public long n() {
      return getLong("n", 0);
    }

    public String url() {
      return getString("url");
    }

    public String title() {
      return getString("title");
    }

    public String goal() {
      return getString("goal");
    }

    /** The page as a base64 JPEG; null when asked without frames. */
    public String frame() {
      return getString("frame");
    }

    /** Its place in the run's log: pass as after. */
    public long seq() {
      return getLong("seq", 0);
    }
  }

  /** One page of a run's steps. */
  public static final class Steps extends JsonObject {
    Steps(Map<String, Object> raw) {
      super(raw);
    }

    public List<Step> data() {
      return getObjects("data", Step::new);
    }

    /** Pass as after for the steps that follow. */
    public long after() {
      return getLong("after", 0);
    }

    /** The run has ended: no step comes after the last. */
    public boolean ended() {
      return getBoolean("ended");
    }
  }
}
