package com.withruntime;

import java.time.Instant;
import java.util.Map;

/** A session as the API answers it: one piece of an agent's work, in its own sandbox. */
public final class AgentSessionInfo extends JsonObject {
  AgentSessionInfo(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String agentId() {
    return getString("agentId");
  }

  /** The agent's version it runs: an update reaches only later sessions. */
  public long agentVersion() {
    return getLong("agentVersion", 0);
  }

  /** The key that joins words to it (your own, such as {@code customer:42}), or null. */
  public String key() {
    return getString("key");
  }

  /**
   * What started it: api, slack, github, schedule, webhook, or spawn (a child session its parent's
   * harness started).
   */
  public String trigger() {
    return getString("trigger");
  }

  /** queued, running, waiting, done, failed or stopped. */
  public String state() {
    return getString("state");
  }

  /** Whether it has ended: done, failed or stopped. */
  public boolean ended() {
    String state = state();
    return "done".equals(state) || "failed".equals(state) || "stopped".equals(state);
  }

  /**
   * Why it ended, or null: among others budget (its tree reached its maxSessionDollars),
   * parent_ended, and deleted on a deleted record.
   */
  public String reason() {
    return getString("reason");
  }

  /** What it ended with, as the agent said it (a pull request's address, an answer), or null. */
  public String result() {
    return getString("result");
  }

  /** Its sandbox, an ordinary sandbox of the account, or null before it runs. */
  public String sandboxId() {
    return getString("sandboxId");
  }

  /** The seq of its log's last event. */
  public long lastSeq() {
    return getLong("lastSeq", 0);
  }

  public Map<String, String> labels() {
    return getStringMap("labels");
  }

  public Instant createdAt() {
    return getInstant("createdAt");
  }

  public Instant startedAt() {
    return getInstant("startedAt");
  }

  public Instant endedAt() {
    return getInstant("endedAt");
  }

  /** The session that spawned it, or null for a top session. */
  public String parentSessionId() {
    return getString("parentSessionId");
  }

  /** The top of its tree: its own id for a top session. */
  public String rootSessionId() {
    return getString("rootSessionId");
  }

  /** 0 for a top session, one more for each parent above it (at most 3). */
  public int depth() {
    return (int) getLong("depth", 0);
  }

  /** What this session has used so far. A delete keeps it: it never frees budget. */
  public Cost cost() {
    return new Cost(getObject("cost").raw());
  }

  /** What it and every session under it have used so far. */
  public Cost treeCost() {
    return new Cost(getObject("treeCost").raw());
  }

  /** Its log's size in bytes, counted as storage and kept until the session is deleted. */
  public long historyBytes() {
    return getLong("historyBytes", 0);
  }

  /** Its files' and screenshots' size in bytes, counted as storage. */
  public long attachmentBytes() {
    return getLong("attachmentBytes", 0);
  }

  /** Why a stop was asked: stopped, budget or parent_ended; null when none was. */
  public String stopWhy() {
    return getString("stopWhy");
  }

  /** When its history was deleted, or null: a deleted session is kept as a record. */
  public Instant deletedAt() {
    return getInstant("deletedAt");
  }

  /** What a session (or its tree) has used: dollars, vCPU-seconds and GiB-seconds. */
  public static final class Cost extends JsonObject {
    Cost(Map<String, Object> raw) {
      super(raw);
    }

    public double dollars() {
      Double value = getDouble("dollars");
      return value == null ? 0 : value;
    }

    public double vcpuSeconds() {
      Double value = getDouble("vcpuSeconds");
      return value == null ? 0 : value;
    }

    public double gibSeconds() {
      Double value = getDouble("gibSeconds");
      return value == null ? 0 : value;
    }
  }
}
