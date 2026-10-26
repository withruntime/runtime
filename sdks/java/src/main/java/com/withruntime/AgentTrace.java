package com.withruntime;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * A page of a session's trace ({@link AgentSession#trace(long, int)}): every model turn and tool
 * call its harness made, with timing, tokens and cost at the provider's list price, and the whole
 * session's totals by model and tool.
 */
public final class AgentTrace extends JsonObject {
  AgentTrace(Map<String, Object> raw) {
    super(raw);
  }

  public String sessionId() {
    return getString("sessionId");
  }

  /**
   * turns, toolCalls, inputTokens (uncached), outputTokens, cacheReadTokens, cacheWriteTokens,
   * costUsd, unpricedTurns, failedTurns, failedToolCalls, modelMs and toolMs.
   */
  public JsonObject totals() {
    return getObject("totals");
  }

  /** The same counts by model, costliest first. */
  public List<JsonObject> models() {
    return getObjects("models");
  }

  /** name, calls, failed and durationMs of each tool, most called first. */
  public List<JsonObject> tools() {
    return getObjects("tools");
  }

  /** Each turn and tool call, in order. */
  public List<Span> spans() {
    return getObjects("spans", Span::new);
  }

  /** Where the next page starts ({@code after}), or null when the log held no more. */
  public Long nextAfter() {
    return getLong("nextAfter");
  }

  /** The session's total cost so far at list prices, in USD. */
  public double costUsd() {
    Double cost = totals().getDouble("costUsd");
    return cost == null ? 0 : cost;
  }

  /** One model turn (kind turn) or one tool call (kind tool). */
  public static final class Span extends JsonObject {
    Span(Map<String, Object> raw) {
      super(raw);
    }

    public long seq() {
      return getLong("seq", 0);
    }

    /** turn or tool. */
    public String kind() {
      return getString("kind");
    }

    /** A turn's id (16 hex digits), or a tool call's id. */
    public String id() {
      return getString("id");
    }

    public Instant startedAt() {
      return getInstant("startedAt");
    }

    public long durationMs() {
      return getLong("durationMs", 0);
    }

    /** A turn's model, or null for a tool call. */
    public String model() {
      return getString("model");
    }

    public long inputTokens() {
      return getLong("inputTokens", 0);
    }

    public long outputTokens() {
      return getLong("outputTokens", 0);
    }

    public long cacheReadTokens() {
      return getLong("cacheReadTokens", 0);
    }

    public long cacheWriteTokens() {
      return getLong("cacheWriteTokens", 0);
    }

    /** A turn's cost at its model's list price, or null when unpriced. */
    public Double costUsd() {
      return getDouble("costUsd");
    }

    /** A tool call's name, or null for a turn. */
    public String name() {
      return getString("name");
    }

    /** Whether a tool call failed, or a turn ended with an error. */
    public boolean failed() {
      Object error = get("error");
      return Boolean.TRUE.equals(error) || error instanceof String;
    }
  }
}
