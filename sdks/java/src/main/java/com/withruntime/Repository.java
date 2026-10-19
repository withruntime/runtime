package com.withruntime;

import java.util.Map;

/** A connected repository: where it is, what its builds deploy, and how they build. */
public final class Repository extends JsonObject {
  Repository(Map<String, Object> raw) {
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

  /** connected or disconnected. */
  public String state() {
    return getString("state");
  }

  /** github or git. */
  public String provider() {
    return getString("provider");
  }

  public String repository() {
    return getString("repository");
  }

  /** What a build deploys: app:&lt;id&gt;, function:&lt;id&gt; or container:&lt;id&gt;. */
  public String deploy() {
    return getString("deploy");
  }

  public String productionBranch() {
    return getString("productionBranch");
  }

  /** Whether other branches build previews. */
  public boolean previews() {
    return getBoolean("previews");
  }

  public String rootDirectory() {
    return getString("rootDirectory");
  }

  public String installCommand() {
    return getString("installCommand");
  }

  public String buildCommand() {
    return getString("buildCommand");
  }

  public String startCommand() {
    return getString("startCommand");
  }

  public int port() {
    return (int) getLong("port", 0);
  }

  public String healthPath() {
    return getString("healthPath");
  }

  /** Settings install and build are given; never a secret. */
  public Map<String, String> buildEnv() {
    return getStringMap("buildEnv");
  }

  /** Unix milliseconds. */
  public long createdAt() {
    return getLong("createdAt", 0);
  }

  public long updatedAt() {
    return getLong("updatedAt", 0);
  }
}
