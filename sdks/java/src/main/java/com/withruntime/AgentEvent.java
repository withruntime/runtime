package com.withruntime;

import java.time.Instant;
import java.util.Map;

/** One entry of a session's log, numbered from 1 by seq. */
public final class AgentEvent extends JsonObject {
  AgentEvent(Map<String, Object> raw) {
    super(raw);
  }

  public long seq() {
    return getLong("seq", 0);
  }

  /**
   * input and answer (words to the agent); reply, ask, status, result and note (the agent's); error
   * (the runner's); child (a child session's end, posted into its parent's log); turn and tool (a
   * model turn and a tool call of its trace, the span in body; see {@link AgentSession#trace()}).
   */
  public String kind() {
    return getString("kind");
  }

  /**
   * Who: a key's principal id, {@code slack:<user>}, {@code github:<login>}, agent for the
   * harness, runtime for the runner.
   */
  public String actor() {
    return getString("actor");
  }

  public JsonObject body() {
    return getObject("body");
  }

  /** The words, body.text, or null. */
  public String text() {
    return body().getString("text");
  }

  public Instant createdAt() {
    return getInstant("createdAt");
  }
}
