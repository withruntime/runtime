package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A deploy: exactly one of {@link #image} or {@link #build}, started beside the live version. The
 * old version keeps serving until the new one is healthy, and keeps serving if it fails.
 */
public final class DeployApp extends Params<DeployApp> {
  public DeployApp() {}

  /** A ready image of this account: its id, name, name:tag or name@version. */
  public DeployApp image(String image) {
    return set("image", image);
  }

  /** A succeeded build's id. */
  public DeployApp build(String build) {
    return set("build", build);
  }

  /** The whole environment of the new version. */
  public DeployApp env(Map<String, String> env) {
    return set("env", new LinkedHashMap<>(env));
  }

  @SuppressWarnings("unchecked")
  public DeployApp env(String name, String value) {
    ((Map<String, String>) body.computeIfAbsent("env", k -> new LinkedHashMap<String, String>())).put(name, value);
    return this;
  }

  /**
   * Carry the last deploy's environment, still sealed; with {@link #env}, that environment with
   * env's names set, so one value changes without sending the rest (that needs a key that may
   * reveal the App's secrets, else 403). For a build: only one a push to the production branch
   * made, from the repository the environment came with. For an image: only from a key that may
   * reveal the App's secrets, and only an environment named with an image deploy. Otherwise
   * refused with keep_env_refused (409).
   */
  public DeployApp keepEnv(boolean keep) {
    return set("keepEnv", keep);
  }

  public DeployApp port(int port) {
    return set("port", port);
  }

  public DeployApp healthPath(String path) {
    return set("healthPath", path);
  }
}
