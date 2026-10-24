package com.withruntime;

import java.util.Map;

/**
 * One step a release took, as it took it: a migration's copy test or apply, a deploy ref moved, a
 * server's canary or release, the website's deploy or promote, or a wait and why.
 */
public final class CiReleaseStep extends JsonObject {
  CiReleaseStep(Map<String, Object> raw) {
    super(raw);
  }

  public long id() {
    return getLong("id", 0);
  }

  public String repositoryId() {
    return getString("repositoryId");
  }

  /** The commit the release is of. */
  public String commit() {
    return getString("commit");
  }

  /** Who took it: mover, or the deploy target that walked it. */
  public String source() {
    return getString("source");
  }

  /** The server it was on, or null when on none. */
  public String host() {
    return getString("host");
  }

  public String line() {
    return getString("line");
  }

  /** Unix milliseconds. */
  public long at() {
    return getLong("at", 0);
  }
}
