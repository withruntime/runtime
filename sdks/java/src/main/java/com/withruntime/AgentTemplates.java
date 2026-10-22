package com.withruntime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code runtime.agents().templates()}: five harnesses, each usable for either of two uses.
 *
 * <p>A harness is what the session's sandbox runs: claude-code, codex, gemini-cli,
 * claude-agent-sdk or openai-agents-sdk. A use is what the agent is for: support (your customers,
 * driven by your own app: one session per end customer under your own key such as customer:42,
 * paused between their messages) or team (your team: from Slack and
 * GitHub, one session per task). {@link #definition(String, String)} merges the two into a
 * definition ready for {@link Agents#create(String, AgentDefinition)}.
 *
 * <p>A subscription login is for your own team's agents. An agent that serves your customers
 * (API or webhook sessions for end users) uses an API key: that is the providers' terms, and the API
 * warns with subscription_for_customers ({@link Agent#warnings()}).
 */
public final class AgentTemplates {
  /** The same data in every Runtime SDK and the guide. */
  static final AgentTemplates ALL = new AgentTemplates();

  private final Map<String, Template> templates = new LinkedHashMap<>();
  private final Map<String, Use> uses = new LinkedHashMap<>();

  private AgentTemplates() {
    harness(
        "claude-code",
        "Claude Code",
        "npx -y @anthropic-ai/claude-code --dangerously-skip-permissions --mcp-config ~/.runtime-agent/mcp.json -p \"$(cat ~/.runtime-agent/start.md)\"",
        "ANTHROPIC_API_KEY",
        "api.anthropic.com",
        "token: run `claude setup-token` on your own computer (Pro/Max), then `runtime secrets set CLAUDE_CODE_OAUTH_TOKEN` scoped to api.anthropic.com");
    harness(
        "codex",
        "Codex CLI",
        "npx -y @openai/codex exec --dangerously-bypass-approvals-and-sandbox \"$(cat ~/.runtime-agent/start.md)\"",
        "OPENAI_API_KEY",
        "api.openai.com",
        "login once in the sandbox's terminal: `npx -y @openai/codex login --device-auth`, kept in the snapshot or a volume at `~/.codex`");
    harness(
        "gemini-cli",
        "Gemini CLI",
        "npx -y @google/gemini-cli --yolo -p \"$(cat ~/.runtime-agent/start.md)\"",
        "GEMINI_API_KEY",
        "generativelanguage.googleapis.com",
        "login once in the sandbox's terminal (Sign in with Google), kept at `~/.gemini`");
    harness("claude-agent-sdk", "Claude Agent SDK", "python3 ~/agent.py", "ANTHROPIC_API_KEY", "api.anthropic.com", null);
    harness("openai-agents-sdk", "OpenAI Agents SDK", "python3 ~/agent.py", "OPENAI_API_KEY", "api.openai.com", null);
    Map<String, Object> support = new LinkedHashMap<>();
    support.put("template", "support");
    support.put("vcpu", 1);
    support.put("memoryMiB", 1024);
    support.put("idlePauseSeconds", 10);
    support.put("maxConcurrent", 1000);
    uses.put("support", new Use("support", "Your customers", "customer:<id>", List.of("api", "webhook"), support));
    Map<String, Object> team = new LinkedHashMap<>();
    team.put("template", "team");
    team.put("vcpu", 4);
    team.put("memoryMiB", 8192);
    uses.put("team", new Use("team", "Your team", null, List.of("slack", "github"), team));
  }

  private void harness(String key, String title, String command, String secret, String host, String subscription) {
    Map<String, Object> definition = new LinkedHashMap<>();
    definition.put("command", command);
    definition.put("secrets", List.of(secret));
    templates.put(key, new Template(key, title, command, secret, host, subscription, definition));
  }

  private static RuntimeCloudException unknown(String what, String key, java.util.Set<String> known) {
    return new RuntimeCloudException.InvalidRequest(
        new RuntimeCloudException.Init(
            "No agent " + what + " is called " + key + ".",
            "invalid_request",
            0,
            "Use one of " + String.join(", ", known) + ".",
            null,
            null,
            null,
            null,
            null,
            null));
  }

  /** A harness by key; an unknown key is an {@link RuntimeCloudException.InvalidRequest}. */
  public Template get(String key) {
    Template template = templates.get(key);
    if (template == null) throw unknown("template", key, templates.keySet());
    return template;
  }

  /** The five harnesses, in order. */
  public List<Template> list() {
    return List.copyOf(templates.values());
  }

  /** A use by key, support or team; an unknown key is an {@link RuntimeCloudException.InvalidRequest}. */
  public Use use(String key) {
    Use use = uses.get(key);
    if (use == null) throw unknown("use", key, uses.keySet());
    return use;
  }

  /** The two uses, support then team. */
  public List<Use> uses() {
    return List.copyOf(uses.values());
  }

  /** A new definition: the harness's alone. */
  public AgentDefinition definition(String template) {
    return definition(template, null);
  }

  /**
   * A new definition: the harness's, with the use's preset over it (use may be null). An unknown key
   * of either is an {@link RuntimeCloudException.InvalidRequest}, thrown before anything is sent.
   */
  public AgentDefinition definition(String template, String use) {
    AgentDefinition base = get(template).definition();
    return use == null ? base : base.with(use(use).definition);
  }

  /** The whole data as JSON fields: {@code {templates, uses}}, as the guide holds it. */
  Map<String, Object> toMap() {
    Map<String, Object> out = new LinkedHashMap<>();
    Map<String, Object> harnesses = new LinkedHashMap<>();
    templates.forEach((key, template) -> harnesses.put(key, template.toMap()));
    Map<String, Object> presets = new LinkedHashMap<>();
    uses.forEach((key, use) -> presets.put(key, use.toMap()));
    out.put("templates", harnesses);
    out.put("uses", presets);
    return out;
  }

  /** A harness: what a session's sandbox runs, and the model key it needs. */
  public static final class Template {
    private final String key;
    private final String title;
    private final String command;
    private final String apiKeySecret;
    private final String apiKeyHost;
    private final String subscription;
    private final Map<String, Object> definition;

    Template(String key, String title, String command, String apiKeySecret, String apiKeyHost, String subscription, Map<String, Object> definition) {
      this.key = key;
      this.title = title;
      this.command = command;
      this.apiKeySecret = apiKeySecret;
      this.apiKeyHost = apiKeyHost;
      this.subscription = subscription;
      this.definition = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(definition));
    }

    public String key() {
      return key;
    }

    public String title() {
      return title;
    }

    /** What the sandbox runs; Node and Python are in the default image. */
    public String command() {
      return command;
    }

    /** The egress secret that holds the model key, set with {@code runtime.secrets()}. */
    public String apiKeySecret() {
      return apiKeySecret;
    }

    /** The host that secret is for. */
    public String apiKeyHost() {
      return apiKeyHost;
    }

    /**
     * How to use a subscription instead of an API key, for your own team's agents only; null when
     * the harness takes only an API key.
     */
    public String subscription() {
      return subscription;
    }

    /** A new definition: command and secrets. */
    public AgentDefinition definition() {
      return AgentDefinition.from(definition);
    }

    Map<String, Object> toMap() {
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("key", key);
      out.put("title", title);
      out.put("command", command);
      out.put("apiKeySecret", apiKeySecret);
      out.put("apiKeyHost", apiKeyHost);
      out.put("subscription", subscription);
      out.put("definition", definition().toMap());
      return out;
    }
  }

  /** A use: what an agent is for, and the preset it adds to a harness's definition. */
  public static final class Use {
    private final String key;
    private final String title;
    private final String sessionKey;
    private final List<String> triggers;
    private final Map<String, Object> definition;

    Use(String key, String title, String sessionKey, List<String> triggers, Map<String, Object> definition) {
      this.key = key;
      this.title = title;
      this.sessionKey = sessionKey;
      this.triggers = List.copyOf(triggers);
      this.definition = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(definition));
    }

    public String key() {
      return key;
    }

    public String title() {
      return title;
    }

    /**
     * The session key to start with ({@code customer:<id>}: one session per end customer, under
     * your own key), or null: one per task.
     */
    public String sessionKey() {
      return sessionKey;
    }

    /** What starts its sessions: api and webhook, or slack and github. */
    public List<String> triggers() {
      return triggers;
    }

    /** A new definition of the preset alone. */
    public AgentDefinition definition() {
      return AgentDefinition.from(definition);
    }

    Map<String, Object> toMap() {
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("key", key);
      out.put("title", title);
      out.put("sessionKey", sessionKey);
      out.put("triggers", triggers);
      out.put("definition", definition().toMap());
      return out;
    }
  }
}
