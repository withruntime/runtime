package com.withruntime;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * One row of the account's inbox ({@link Agents.Asks}): a question an agent's session needs
 * answered to go on, with why it matters, its options, a recommended pick and maybe an expiry.
 * Asks of one agent's sessions sharing a memory, with the same step, are one row while it is
 * open, and one answer reaches every session asking.
 */
public final class AgentAsk extends JsonObject {
  AgentAsk(Map<String, Object> raw) {
    super(raw);
  }

  public String id() {
    return getString("id");
  }

  /** The agent of the session that asked first. */
  public String agentId() {
    return getString("agentId");
  }

  /** What it waits on, in the asker's words, or null. */
  public String step() {
    return getString("step");
  }

  public String question() {
    return getString("question");
  }

  /** Why it matters, or null. */
  public String why() {
    return getString("why");
  }

  /** Each option: its {@code label} and, maybe, {@code detail} (what it costs, what follows). */
  public List<JsonObject> options() {
    return getObjects("options");
  }

  /** The recommended option's label, taken as the answer when it expires; or null. */
  public String pick() {
    return getString("pick");
  }

  /** Who sees it: its agent's labels with the ask's own over them. */
  public Map<String, String> labels() {
    return getStringMap("labels");
  }

  /** open, answered, withdrawn, expired (no pick) or closed (every asking session ended). */
  public String state() {
    return getString("state");
  }

  /** {@code option}, {@code text} and {@code expired} once answered, else null. */
  public JsonObject answer() {
    return getObject("answer");
  }

  /** A key's principal id, or runtime for a pick taken at expiry; null before. */
  public String answeredBy() {
    return getString("answeredBy");
  }

  /** The sessions asking it: {@code sessionId}, {@code state}, {@code seq}, {@code answerSeq}. */
  public List<JsonObject> sessions() {
    return getObjects("sessions");
  }

  public Instant expiresAt() {
    return getInstant("expiresAt");
  }

  public Instant createdAt() {
    return getInstant("createdAt");
  }

  public Instant closedAt() {
    return getInstant("closedAt");
  }

  /**
   * The tool call it holds, answered Allow or Deny ({@code tool}, {@code input}, {@code toolUseId},
   * {@code seq}, {@code policy}, {@code reasonCode}); null for any other ask.
   */
  public JsonObject toolCall() {
    return getObject("toolCall");
  }
}
