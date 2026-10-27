package com.withruntime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What an agent runs: a command, and what its sandbox starts from and holds. Only command is
 * required; a field left unset is not sent. Each field is read by its name with no argument and set
 * with one; {@link #set(String, Object)} sets a field newer than this SDK, and one read from the API
 * is kept as it came.
 *
 * <pre>{@code
 * new AgentDefinition("python3 ~/agent.py").fromSnapshot("snap_1").vcpu(2).secret("OPENAI_API_KEY");
 * }</pre>
 */
public final class AgentDefinition {
  private final Map<String, Object> body = new LinkedHashMap<>();

  public AgentDefinition() {}

  public AgentDefinition(String command) {
    command(command);
  }

  /** A definition from its JSON fields, such as one kept from an earlier answer. */
  public static AgentDefinition from(Map<String, ?> fields) {
    AgentDefinition definition = new AgentDefinition();
    if (fields != null) definition.body.putAll(fields);
    return definition;
  }

  /** Sets any field, including one newer than this SDK; null removes it. */
  public AgentDefinition set(String field, Object value) {
    if (value == null) body.remove(field);
    else body.put(field, value);
    return this;
  }

  /** A field, or null. */
  public Object get(String field) {
    return body.get(field);
  }

  private JsonObject view() {
    return new JsonObject(body);
  }

  private Integer integer(String field) {
    Long value = view().getLong(field);
    return value == null ? null : value.intValue();
  }

  /** The command the sandbox runs for each session. Required. */
  public AgentDefinition command(String command) {
    return set("command", command);
  }

  public String command() {
    return view().getString("command");
  }

  /** Start from this image (an id, name, name:tag or name@version). */
  public AgentDefinition fromImage(String image) {
    return set("from", image == null ? null : Map.of("image", image));
  }

  /**
   * Start from this snapshot, such as one with a harness already logged in. A snapshot keeps its
   * own size: a definition from one that sets vcpu or memoryMiB is refused (InvalidRequest).
   */
  public AgentDefinition fromSnapshot(String snapshot) {
    return set("from", snapshot == null ? null : Map.of("snapshot", snapshot));
  }

  /**
   * Start from a GitHub repository connected to CI/CD ({@code owner/name}): each session is a copy
   * of its warm snapshot, the repository checked out at /workspace/repo at its production
   * branch's last passing commit, set up, with the harness run there.
   */
  public AgentDefinition fromRepo(String repo) {
    return set("from", repo == null ? null : Map.of("repo", repo));
  }

  /** {@code {image}}, {@code {snapshot}} or {@code {repo}}; empty when unset (the default image). */
  public JsonObject from() {
    return view().getObject("from");
  }

  /** 1, 2, 4, 8 or 16; 4 unless set. Not with a snapshot, which keeps its own size. */
  public AgentDefinition vcpu(int vcpu) {
    return set("vcpu", vcpu);
  }

  public Integer vcpu() {
    return integer("vcpu");
  }

  /** 512 to 65536, a multiple of 256; 8192 (8 GiB) unless set. Not with a snapshot. */
  public AgentDefinition memoryMiB(int mib) {
    return set("memoryMiB", mib);
  }

  public Integer memoryMiB() {
    return integer("memoryMiB");
  }

  /** What the agent is for, written into its start file for the harness to read. */
  public AgentDefinition instructions(String instructions) {
    return set("instructions", instructions);
  }

  public String instructions() {
    return view().getString("instructions");
  }

  /** Adds one environment variable. */
  public AgentDefinition env(String name, String value) {
    Map<String, Object> env = new LinkedHashMap<>(JsonObject.map(body.get("env")));
    env.put(name, value);
    return set("env", env);
  }

  public Map<String, String> env() {
    return view().getStringMap("env");
  }

  /**
   * Egress secrets (set with {@code runtime.secrets()}) the sandbox may use without seeing them:
   * ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY and the like.
   */
  public AgentDefinition secrets(List<String> names) {
    return set("secrets", names == null ? null : List.copyOf(names));
  }

  /** Adds one egress secret by name. */
  public AgentDefinition secret(String name) {
    List<String> names = new ArrayList<>(secrets());
    names.add(name);
    return set("secrets", names);
  }

  public List<String> secrets() {
    return view().getStrings("secrets");
  }

  /**
   * Its pool of Claude accounts: 1 to 16 egress secrets' names, each a subscription token or, for a
   * name holding API_KEY, an API key. Each session takes the one with the most usage left; the review
   * template moves to the next when one is out of usage.
   */
  public AgentDefinition pool(List<String> names) {
    return set("pool", names == null ? null : List.copyOf(names));
  }

  public List<String> pool() {
    return view().getStrings("pool");
  }

  /** Adds an MCP server the harness may call. */
  public AgentDefinition mcp(String name, String url) {
    List<Object> servers = new ArrayList<>(view().getList("mcp"));
    servers.add(Map.of("name", name, "url", url));
    return set("mcp", servers);
  }

  /** Each: name and url. */
  public List<JsonObject> mcp() {
    return view().getObjects("mcp");
  }

  /** Attaches a volume at path in each session's sandbox. */
  public AgentDefinition volume(String volume, String path) {
    List<Object> volumes = new ArrayList<>(view().getList("volumes"));
    volumes.add(Map.of("volume", volume, "path", path));
    return set("volumes", volumes);
  }

  /** Each: volume and path. */
  public List<JsonObject> volumes() {
    return view().getObjects("volumes");
  }

  /**
   * Where each session's sandbox may connect, enforced by its network rules from its first packet:
   * only the hosts in allow. Unset: anywhere.
   */
  public AgentDefinition network(List<String> allow) {
    return set("network", Map.of("internet", true, "allow", List.copyOf(allow)));
  }

  /** internet, and allow when set. */
  public JsonObject network() {
    return view().getObject("network");
  }

  /** Seconds with nothing happening before a session's sandbox pauses between words. */
  public AgentDefinition idlePauseSeconds(int seconds) {
    return set("idlePauseSeconds", seconds);
  }

  public Integer idlePauseSeconds() {
    return integer("idlePauseSeconds");
  }

  /** The longest a session may run before it is stopped. */
  public AgentDefinition maxSessionSeconds(int seconds) {
    return set("maxSessionSeconds", seconds);
  }

  public Integer maxSessionSeconds() {
    return integer("maxSessionSeconds");
  }

  /** Sessions of this agent running at once; more wait queued. */
  public AgentDefinition maxConcurrent(int sessions) {
    return set("maxConcurrent", sessions);
  }

  public Integer maxConcurrent() {
    return integer("maxConcurrent");
  }

  /**
   * Dollars a session and every session under it may cost: more than 0, at most 10000, 5 unless
   * set. The root's covers its whole tree; a tree that reaches it stops with reason budget.
   */
  public AgentDefinition maxSessionDollars(double dollars) {
    return set("maxSessionDollars", dollars);
  }

  public Double maxSessionDollars() {
    return view().getDouble("maxSessionDollars");
  }

  /**
   * Dollars the agent's sessions started in a UTC day may cost: more than 0, at most 100000, 100
   * unless set. Past it, it starts nothing new (402, budget_reached) until the next day.
   */
  public AgentDefinition maxDayDollars(double dollars) {
    return set("maxDayDollars", dollars);
  }

  public Double maxDayDollars() {
    return view().getDouble("maxDayDollars");
  }

  /** Sessions one session's harness may start: 1 to 1000, 100 unless set. */
  public AgentDefinition maxChildren(int sessions) {
    return set("maxChildren", sessions);
  }

  public Integer maxChildren() {
    return integer("maxChildren");
  }

  /**
   * A stronger or different model its sessions may ask for advice with the advise tool, each call
   * kept in the session's log as a note. The provider is inferred from the model's name; the key is
   * that provider's usual egress secret (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...), which must be
   * among the secrets or the pool. {@link #advisor(Map)} sets the rest: provider, secret, baseUrl,
   * maxCalls (1 to 200, 20 unless set) and instructions.
   */
  public AgentDefinition advisor(String model) {
    return set("advisor", Map.of("model", model));
  }

  public AgentDefinition advisor(Map<String, ?> advisor) {
    return set("advisor", advisor);
  }

  /** {@code model}, {@code provider}, {@code secret} and the rest, or null. */
  public JsonObject advisor() {
    return view().getObject("advisor");
  }

  /** The use it was made for: support or team (see {@link AgentTemplates}). */
  public AgentDefinition template(String use) {
    return set("template", use);
  }

  public String template() {
    return view().getString("template");
  }

  /**
   * The model the harness runs, such as claude-opus-5-5; unset, the harness's default. The harness
   * reads it as RUNTIME_AGENT_MODEL, and Claude Code, the Claude Agent SDK, Codex, Gemini CLI and
   * the OpenAI Agents SDK each by their own setting.
   */
  public AgentDefinition model(String model) {
    return set("model", model);
  }

  public String model() {
    return view().getString("model");
  }

  /**
   * What a session's start may override ({@link AgentSessionOverrides}): {@code models} (a list;
   * unset, any), {@code instructions} (append, the default; replace; or none), and {@code maxVcpu},
   * {@code maxMemoryMiB} and {@code maxSessionDollars} (the most a session may ask for; unset, the
   * agent's own). A session may always narrow its MCP servers and disallow tools.
   */
  public AgentDefinition sessionOverrides(Map<String, ?> limits) {
    return set("sessionOverrides", limits == null ? null : new LinkedHashMap<>(limits));
  }

  public JsonObject sessionOverrides() {
    return view().getObject("sessionOverrides");
  }

  /** A new definition: this one with other's fields over it (a shallow merge, other's win). */
  AgentDefinition with(Map<String, ?> other) {
    AgentDefinition merged = from(body);
    merged.body.putAll(other);
    return merged;
  }

  /** The fields as they will be sent. */
  public Map<String, Object> toMap() {
    return new LinkedHashMap<>(body);
  }

  @Override
  public String toString() {
    return Json.write(body);
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof AgentDefinition definition && definition.body.equals(body);
  }

  @Override
  public int hashCode() {
    return body.hashCode();
  }
}
