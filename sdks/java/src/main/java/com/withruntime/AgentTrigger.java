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
