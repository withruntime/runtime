package com.withruntime;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** An agent: a name, its definition at its current version, and labels. */
public final class Agent extends JsonObject {
  Agent(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  public String name() {
    return getString("name");
  }

  /** 1 at create, one more at each update. */
  public long version() {
    return getLong("version", 0);
  }

  /**
   * The definition as the API holds it, fields newer than this SDK included. A copy: change it and
   * pass it to {@link Agents#update}.
   */
  public AgentDefinition definition() {
    return AgentDefinition.from(getObject("definition").raw());
  }

  public Map<String, String> labels() {
    return getStringMap("labels");
  }

  /**
   * What the API thinks is wrong but allows, such as subscription_for_customers: a subscription
   * login is for your own team's agents, and an agent that serves your customers uses an API key
   * (the providers' terms). Empty when none.
   */
  public List<String> warnings() {
    return getStrings("warnings");
  }

  public Instant createdAt() {
    return getInstant("createdAt");
  }

  public Instant updatedAt() {
    return getInstant("updatedAt");
  }
}
