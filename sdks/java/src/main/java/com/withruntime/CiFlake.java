package com.withruntime;

import java.util.List;
import java.util.Map;

/**
 * A test that passed and failed on the same inputs, one run main's: quarantined at once (it still
 * runs and reports, and blocks nothing), or still gating when the repository protects it; handed to
 * an owner with 48 hours to fix it or delete it with a reason; fixed once 100 runs of a main commit
 * in parallel forks all pass. {@link #runs()} and {@link #failures()} come with a get or an update.
 */
public final class CiFlake extends JsonObject {
  CiFlake(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String repositoryId() {
    return getString("repositoryId");
  }

  /** The test file, from the repository's root. */
  public String file() {
    return getString("file");
  }

  /** quarantined, gating, fixed or deleted. */
  public String state() {
    return getString("state");
  }

  /** Why it still fails checks (protected, its area's last test); null when it doesn't. */
  public JsonObject gates() {
    return raw().get("gates") == null ? null : getObject("gates");
  }

  /** The key it both passed and failed under, its commit, check and job. */
  public JsonObject proof() {
    return getObject("proof");
  }

  /** Who it is handed to, or null when nobody was found. */
  public Owner owner() {
    return raw().get("owner") == null ? null : new Owner(map(raw().get("owner")));
  }

  public long since() {
    return getLong("since", 0);
  }

  /** 48 hours after it opened. */
  public long dueAt() {
    return getLong("dueAt", 0);
  }

  /** Open past its 48 hours. */
  public boolean overdue() {
    return getBoolean("overdue");
  }

  public String deleteReason() {
    return getString("deleteReason");
  }

  public Long endedAt() {
    return getLong("endedAt");
  }

  /** The test file's newest 200 runs, newest first. */
  public List<Run> runs() {
    return getObjects("runs", Run::new);
  }

  /** Each failed run's job, whose log {@code ci().jobs().get} reads. */
  public List<JsonObject> failures() {
    return getObjects("failures");
  }

  /** Who a flake is handed to. */
  public static final class Owner extends JsonObject {
    Owner(Map<String, Object> raw) {
      super(raw);
    }

    /** A GitHub login, or org/team. */
    public String login() {
      return getString("login");
    }

    /** codeowners, last change or handed. */
    public String from() {
      return getString("from");
    }

    /** The pull request that last changed the test, when that chose it. */
    public Long pullRequest() {
      return getLong("pullRequest");
    }

    public String branch() {
      return getString("branch");
    }
  }

  /** One run of the test file, by commit and content key. */
  public static final class Run extends JsonObject {
    Run(Map<String, Object> raw) {
      super(raw);
    }

    public String commit() {
      return getString("commit");
    }

    public String key() {
      return getString("key");
    }

    public boolean passed() {
      return getBoolean("passed");
    }

    /** first, again (alone, after a failure) or repeat (a new test's 20, a proof's 100). */
    public String attempt() {
      return getString("attempt");
    }

    /** A run of the production branch's own commit. */
    public boolean main() {
      return getBoolean("main");
    }

    public String jobId() {
      return getString("jobId");
    }

    public String message() {
      return getString("message");
    }

    public long at() {
      return getLong("at", 0);
    }
  }
}
