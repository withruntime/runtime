package com.withruntime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One session's own model, instructions, MCP servers, disallowed tools, size and budget, within its
 * agent's session overrides ({@link AgentDefinition#sessionOverrides}). Recorded on the session
 * ({@link AgentSessionInfo#overrides()}) and noted in its log. A field left unset is not sent.
 *
 * <pre>{@code
 * runtime.agents().start("helpdesk", "Summarize this ticket", "customer:42", null,
 *     new AgentSessionOverrides().model("claude-haiku-5-5").disallowTool("Bash"), null);
 * }</pre>
 */
public final class AgentSessionOverrides {
  private final Map<String, Object> body = new LinkedHashMap<>();

  /** No overrides yet: each setter adds one. */
  public AgentSessionOverrides() {}

  /** The model the harness runs for this session, such as claude-opus-5-5. */
  public AgentSessionOverrides model(String model) {
    return set("model", model);
  }

  /** Words added after the agent's instructions (a blank line between). */
  public AgentSessionOverrides instructions(String instructions) {
    return set("instructions", instructions);
  }

  /** Words in place of the agent's instructions, where its owner allows replace. */
  public AgentSessionOverrides replaceInstructions(String instructions) {
    set("instructions", instructions);
    return set("instructionsMode", instructions == null ? null : "replace");
  }

  /** The agent's MCP servers this session keeps, by name; an empty list keeps none. */
  public AgentSessionOverrides mcp(List<String> names) {
    return set("mcp", names == null ? null : new ArrayList<>(names));
  }

  /**
   * A tool the harness may not use: Runtime's own ({@code spawn}, {@code pr}, ...; never wait,
   * reply or done) or the harness's ({@code Bash}, {@code mcp__github}).
   */
  public AgentSessionOverrides disallowTool(String tool) {
    @SuppressWarnings("unchecked")
    List<String> tools = (List<String>) body.computeIfAbsent("disallowedTools", k -> new ArrayList<String>());
    if (!tools.contains(tool)) tools.add(tool);
    return this;
  }

  /** 1, 2, 4, 8 or 16, at most the agent's maxVcpu override limit, else its own vcpu. */
  public AgentSessionOverrides vcpu(int vcpu) {
    return set("vcpu", vcpu);
  }

  /** A multiple of 256, at most the agent's maxMemoryMiB override limit, else its own. */
  public AgentSessionOverrides memoryMiB(int memoryMiB) {
    return set("memoryMiB", memoryMiB);
  }

  /** This session's budget, its subagents included, within the agent's limit. */
  public AgentSessionOverrides maxSessionDollars(double dollars) {
    return set("maxSessionDollars", dollars);
  }

  /** Sets any field, including one newer than this SDK; null removes it. */
  public AgentSessionOverrides set(String field, Object value) {
    if (value == null) body.remove(field);
    else body.put(field, value);
    return this;
  }

  /** The fields as they will be sent. */
  public Map<String, Object> toMap() {
    return new LinkedHashMap<>(body);
  }

  @Override
  public String toString() {
    return body.toString();
  }
}
