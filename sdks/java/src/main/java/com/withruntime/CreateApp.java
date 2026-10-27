package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A new App's or Function's fields. The three in the constructor are required; the rest have the
 * API's defaults, which this SDK does not override. It starts waiting for its first deploy.
 */
public final class CreateApp extends Params<CreateApp> {
  /**
   * @param maxCopies 1 to the account's App copies at once (its plan's sandboxes at once): the most copies awake at once
   * @param vcpu 1 to 16
   * @param memoryMiB 128 to 65536
   */
  public CreateApp(int maxCopies, int vcpu, int memoryMiB) {
    set("maxCopies", maxCopies);
    set("vcpu", vcpu);
    set("memoryMiB", memoryMiB);
  }

  /** Up to 128 letters, digits, dots, dashes or underscores; alphanumeric first. */
  public CreateApp name(String name) {
    return set("name", name);
  }

  /** At most 32 labels, each value at most 256 characters. */
  public CreateApp labels(Map<String, String> labels) {
    return set("labels", new LinkedHashMap<>(labels));
  }

  @SuppressWarnings("unchecked")
  public CreateApp label(String key, String value) {
    ((Map<String, String>) body.computeIfAbsent("labels", k -> new LinkedHashMap<String, String>())).put(key, value);
    return this;
  }

  /** Copies kept awake; default 0, at most maxCopies. Apps only: a Function refuses it, zero too. */
  public CreateApp minCopies(int minCopies) {
    return set("minCopies", minCopies);
  }

  /** Requests one copy serves at once, 1 to 10000; default 100. */
  public CreateApp concurrency(int concurrency) {
    return set("concurrency", concurrency);
  }

  /** Copies kept ready beyond those serving, 0 to 16; default 2. */
  public CreateApp spares(int spares) {
    return set("spares", spares);
  }

  /**
   * Functions only (an App is refused it): 250 to 5000 ms, default 1000. At most how long a copy stays awake after its
   * last request ends. Awake time with no request in flight is not billed.
   */
  public CreateApp sleepAfterMs(int sleepAfterMs) {
    return set("sleepAfterMs", sleepAfterMs);
  }

  /** The port the server listens on, 1 to 65535; default 8080. */
  public CreateApp port(int port) {
    return set("port", port);
  }

  /** A path answering 200 when healthy; left out, a copy is healthy once its port accepts. */
  public CreateApp healthPath(String path) {
    return set("healthPath", path);
  }

  /**
   * Cloudflare's CDN in front of the App's addresses; default true. False sends visitors straight
   * to Runtime's routers, with nothing cached.
   */
  public CreateApp cdn(boolean cdn) {
    return set("cdn", cdn);
  }

  /**
   * What happens when a new version's errors or speed get clearly worse in its first 15 minutes:
   * "alert" (the default) tells the owners, "rollback" also goes back to the previous version,
   * "off" does neither.
   */
  public CreateApp releaseWatch(String mode) {
    return set("releaseWatch", mode);
  }

  /**
   * Apps only: how a new version goes live. "at_once" (the default) switches every copy together;
   * "staged" starts one copy of it beside the live version's, then about 10%, 50% and all of them,
   * each stage judged on its visitors' errors and speed before the next. A stage that does worse
   * goes back: its copies finish their requests and stop, then the deploy fails with
   * deploy_stage_failed, and the live version never stops serving.
   */
  public CreateApp releaseStages(String stages) {
    return set("releaseStages", stages);
  }

  /** Apps only: 60 to 3600 seconds each stage runs once its copies serve; default 300. */
  public CreateApp releaseSoakSeconds(int seconds) {
    return set("releaseSoakSeconds", seconds);
  }
}
