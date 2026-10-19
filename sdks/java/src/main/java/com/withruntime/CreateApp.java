package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A new App's or Function's fields. The three in the constructor are required; the rest have the
 * API's defaults, which this SDK does not override. It starts waiting for its first deploy.
 */
public final class CreateApp extends Params<CreateApp> {
  /**
   * @param maxCopies 1 to 1000: the most copies awake at once
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

  /** The port the server listens on, 1 to 65535; default 8080. */
  public CreateApp port(int port) {
    return set("port", port);
  }

  /** A path answering 200 when healthy; left out, a copy is healthy once its port accepts. */
  public CreateApp healthPath(String path) {
    return set("healthPath", path);
  }
}
