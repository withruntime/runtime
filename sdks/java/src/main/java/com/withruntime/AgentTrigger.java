package com.withruntime;

import java.time.Instant;
import java.util.Map;

/**
 * What starts an agent's sessions besides the API. {@link Agents.Triggers} lists the kinds and
 * their config.
 */
public final class AgentTrigger extends JsonObject {
  AgentTrigger(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String agentId() {
    return getString("agentId");
  }

  /** slack, github, schedule or webhook. */
  public String kind() {
    return getString("kind");
  }

  public JsonObject config() {
    return getObject("config");
  }

  /**
   * Its rules, every one optional: priority (-100 to 100, queue order when the agent's
   * maxConcurrent is full), maxStartsPerHour, onEnded (start, note or ask), notify (email or
   * webhook) and a webhook's key template ("{cause}"). Empty: every default.
   */
  public JsonObject rules() {
    JsonObject rules = getObject("rules");
    return rules == null ? new JsonObject(Map.of()) : rules;
  }

  public boolean paused() {
    return has("pausedAt");
  }

  public Instant pausedAt() {
    return getInstant("pausedAt");
  }

  /** Why it is paused, or null. */
  public String pausedWhy() {
    return getString("pausedWhy");
  }

  public Instant createdAt() {
    return getInstant("createdAt");
  }
}
