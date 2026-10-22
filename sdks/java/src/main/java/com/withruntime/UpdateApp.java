package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/** An App's or Function's settings changed in place. A field left out stays as it is. */
public final class UpdateApp extends Params<UpdateApp> {
  public UpdateApp() {}

  /** A new name; null clears it. */
  public UpdateApp name(String name) {
    body.put("name", name);
    return this;
  }

  public UpdateApp labels(Map<String, String> labels) {
    return set("labels", new LinkedHashMap<>(labels));
  }

  /** Apps only: a Function refuses it. */
  public UpdateApp minCopies(int minCopies) {
    return set("minCopies", minCopies);
  }

  public UpdateApp maxCopies(int maxCopies) {
    return set("maxCopies", maxCopies);
  }

  public UpdateApp concurrency(int concurrency) {
    return set("concurrency", concurrency);
  }

  public UpdateApp spares(int spares) {
    return set("spares", spares);
  }

  /** Functions only: 250 to 5000 ms. */
  public UpdateApp sleepAfterMs(int sleepAfterMs) {
    return set("sleepAfterMs", sleepAfterMs);
  }

  public UpdateApp vcpu(int vcpu) {
    return set("vcpu", vcpu);
  }

  public UpdateApp memoryMiB(int memoryMiB) {
    return set("memoryMiB", memoryMiB);
  }

  public UpdateApp port(int port) {
    return set("port", port);
  }

  public UpdateApp healthPath(String path) {
    return set("healthPath", path);
  }

  /** Cloudflare's CDN in front of the App's addresses; false sends visitors straight to the routers. */
  public UpdateApp cdn(boolean cdn) {
    return set("cdn", cdn);
  }

  /** "alert", "rollback" or "off"; see {@link CreateApp#releaseWatch}. */
  public UpdateApp releaseWatch(String mode) {
    return set("releaseWatch", mode);
  }
}
