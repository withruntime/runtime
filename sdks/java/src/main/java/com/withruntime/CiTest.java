package com.withruntime;

import java.util.List;
import java.util.Map;

/** One test file of a repository: its recent time and its last 20 runs. */
public final class CiTest extends JsonObject {
  CiTest(Map<String, Object> raw) {
    super(raw);
  }

  public String repositoryId() {
    return getString("repositoryId");
  }

  public String file() {
    return getString("file");
  }

  /** Its recent time in milliseconds, which splits jobs in parts. */
  public long ms() {
    return getLong("ms", 0);
  }

  /** Since when (milliseconds since the epoch) its failures do not fail a check; null: they do. */
  public Long quarantinedSince() {
    return getLong("quarantinedSince");
  }

  /** Its last 20 runs, oldest first. */
  public List<Run> runs() {
    return getObjects("runs", Run::new);
  }

  public long updatedAt() {
    return getLong("updatedAt", 0);
  }

  /** One run of a test file. */
  public static final class Run extends JsonObject {
    Run(Map<String, Object> raw) {
      super(raw);
    }

    public long at() {
      return getLong("at", 0);
    }

    public String check() {
      return getString("check");
    }

    public String job() {
      return getString("job");
    }

    /** passed, failed, flaky or skipped. */
    public String outcome() {
      return getString("outcome");
    }

    public Long ms() {
      return getLong("ms");
    }

    /** False for an approved outsider's run. */
    public boolean writers() {
      return getBoolean("writers");
    }
  }
}
