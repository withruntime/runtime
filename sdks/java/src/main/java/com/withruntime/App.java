package com.withruntime;

import java.util.Map;

/**
 * An App or a Function: copies of one server that wake on demand. A Function is an App that keeps
 * no copy awake ({@link #minCopies()} is 0). Its state is waiting (no version yet), live, failed,
 * deleting or deleted; a deploy is followed by its own record, {@link AppDeploy}.
 */
public final class App extends JsonObject {
  App(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String name() {
    return getString("name");
  }

  /**
   * Its address for life, its name then its account's: https://shop-3f9a1c2e7b04d915-acme1.runtimehost.com/. A
   * rename leaves it as it is; its id's address (https://&lt;id without
   * dashes&gt;.runtimehost.com/) answers too.
   */
  public String url() {
    return getString("url");
  }

  public Map<String, String> labels() {
    return getStringMap("labels");
  }

  /** waiting, live, failed, deleting or deleted. */
  public String state() {
    return getString("state");
  }

  /** Why it failed, with code and message; null when it has not. */
  public JsonObject error() {
    return has("error") ? getObject("error") : null;
  }

  /** The version serving now, or null before the first deploy goes live. */
  public Long liveVersion() {
    return getLong("liveVersion");
  }

  /** The version a rollback returns to, or null. */
  public Long previousVersion() {
    return getLong("previousVersion");
  }

  /**
   * While a copy waits for room in its region: its account's lane, its place in line (1 is next),
   * how many wait ahead by lane ("ahead") and why ("words"). Higher lanes get room first. Null
   * while nothing of it waits.
   */
  public JsonObject line() {
    return has("line") ? getObject("line") : null;
  }

  public int minCopies() {
    return (int) getLong("minCopies", 0);
  }

  public int maxCopies() {
    return (int) getLong("maxCopies", 0);
  }

  /** Requests one copy serves at once. */
  public int concurrency() {
    return (int) getLong("concurrency", 0);
  }

  /** Copies kept ready beyond those serving. */
  public int spares() {
    return (int) getLong("spares", 0);
  }

  /** A Function's: at most how long a copy stays awake after its last request ends, 250 to 5000 ms; 0 for an App. */
  public int sleepAfterMs() {
    return (int) getLong("sleepAfterMs", 0);
  }

  public int vcpu() {
    return (int) getLong("vcpu", 0);
  }

  public int memoryMiB() {
    return (int) getLong("memoryMiB", 0);
  }

  public int port() {
    return (int) getLong("port", 0);
  }

  /** The path that answers 200 when a copy is healthy, or null to check the port accepts. */
  public String healthPath() {
    return getString("healthPath");
  }

  /**
   * Whether Cloudflare's CDN is in front of the App's addresses (its runtimehost.com address and its
   * custom domains). False sends visitors straight to Runtime's routers, with nothing cached.
   */
  public boolean cdn() {
    return !Boolean.FALSE.equals(get("cdn"));
  }

  /** What a new version that got worse after it went live does: alert (the default), rollback or off. */
  public String releaseWatch() {
    return getString("releaseWatch");
  }

  /**
   * How an App's new version goes live: at_once (every copy together) or staged (one copy beside the
   * live version's, then about 10%, 50% and all of them, each stage judged before the next). Null for
   * a Function.
   */
  public String releaseStages() {
    return getString("releaseStages");
  }

  /** Seconds each stage of a staged release runs once its copies serve before it is judged; 0 for a Function. */
  public int releaseSoakSeconds() {
    return (int) getLong("releaseSoakSeconds", 0);
  }

  /**
   * An App's staged release under way, or its last: version, from, state (rolling, back, done, failed
   * or ended), stage, stages, copies, of, soakSeconds, detail, startedAt and updatedAt. Null before
   * its first.
   */
  public JsonObject stagedRelease() {
    return has("stagedRelease") && get("stagedRelease") != null ? getObject("stagedRelease") : null;
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
