package com.withruntime;

import java.util.List;
import java.util.Map;

/** A review step's verdict on one commit: it passes only with no findings. */
public final class CiReview extends JsonObject {
  CiReview(Map<String, Object> raw) {
    super(raw);
  }

  /** pass or block. */
  public String verdict() {
    return getString("verdict");
  }

  public boolean passed() {
    return "pass".equals(verdict());
  }

  public String summary() {
    return getString("summary");
  }

  /** What stops the merge until it is fixed. */
  public List<Finding> findings() {
    return getObjects("findings", Finding::new);
  }

  /** Worth a look; they block nothing. */
  public List<Note> notes() {
    return getObjects("notes", Note::new);
  }

  /** The Runtime Agent that reviewed. */
  public String agent() {
    return getString("agent");
  }

  /** The name of the agent's secret it ran on. */
  public String account() {
    return getString("account");
  }

  public String model() {
    return getString("model");
  }

  /** The agent session that gave the verdict. */
  public String session() {
    return getString("session");
  }

  /** True when the diff was too long and its end was not read. */
  public boolean cut() {
    return getBoolean("cut");
  }

  /** A note: a file, its line in the new file (0 for the whole file), and what to look at. */
  public static class Note extends JsonObject {
    Note(Map<String, Object> raw) {
      super(raw);
    }

    public String file() {
      return getString("file");
    }

    public long line() {
      return getLong("line", 0);
    }

    public String what() {
      return getString("what");
    }
  }

  /** A finding: a note that blocks, with its kind and its fix. */
  public static final class Finding extends Note {
    Finding(Map<String, Object> raw) {
      super(raw);
    }

    /** bug, missed-case, data-at-risk, money-at-risk, auth-bypass, ... or other. */
    public String kind() {
      return getString("kind");
    }

    public String fix() {
      return getString("fix");
    }
  }
}
