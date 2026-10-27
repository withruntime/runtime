package com.withruntime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code runtime.agents()}: an agent is a command (Claude Code, Codex, your own code) that runs in
 * its own sandbox, once per piece of work: a <em>session</em>. Start one with words, send it more,
 * read what it says, and wait for it to end.
 *
 * <pre>{@code
 * Agent agent = runtime.agents().create("helpdesk", runtime.agents().templates().definition("claude-code", "support"));
 * AgentSession session = runtime.agents().start("helpdesk", "My invoice is wrong", "customer:42", null, null);
 * for (AgentEvent event : session.events()) System.out.println(event.kind() + ": " + event.text());
 * }</pre>
 *
 * <p>A private beta: an account outside it is refused with {@link RuntimeCloudException.PermissionDenied}
 * and code product_in_beta.
 */
public final class Agents {
  private final Transport t;
  private final Sessions sessions;
  private final Triggers triggers;
  private final Slack slack;
  private final AgentMemory memory;
  private final Asks asks;
  private final Workflows workflows;

  Agents(Transport transport) {
    this.t = transport;
    this.sessions = new Sessions(transport);
    this.triggers = new Triggers(transport);
    this.slack = new Slack(transport);
    this.memory = new AgentMemory(transport);
    this.asks = new Asks(transport);
    this.workflows = new Workflows(transport);
  }

  static String path(String agent) {
    return "/v1/agents/" + Transport.segment(agent);
  }

  /**
   * Claude Managed Agents' API on Runtime: the base URL and key Anthropic's Java SDK takes, so code
   * written for it runs here unchanged.
   *
   * <pre>{@code
   * Agents.AnthropicOptions o = runtime.agents().anthropic();
   * AnthropicClient client = AnthropicOkHttpClient.builder().baseUrl(o.baseUrl()).apiKey(o.apiKey()).build();
   * }</pre>
   *
   * <p>Sessions call the model with the account's own Anthropic key, the egress secret
   * ANTHROPIC_API_KEY ({@code runtime secrets set ANTHROPIC_API_KEY --host api.anthropic.com}).
   */
  public AnthropicOptions anthropic() {
    return new AnthropicOptions(t.baseUrl + "/anthropic", t.apiKey);
  }

  /** What {@link #anthropic()} answers. */
  public record AnthropicOptions(String baseUrl, String apiKey) {}

  /** Sessions by id, across agents. */
  public Sessions sessions() {
    return sessions;
  }

  /** What starts sessions besides the API: Slack, GitHub, a schedule, a webhook. */
  public Triggers triggers() {
    return triggers;
  }

  /** Runtime's Slack app in your workspaces, for {@code slack} triggers. */
  public Slack slack() {
    return slack;
  }

  /**
   * {@code runtime.agents().slack()}: Runtime's Slack app in your workspaces. Add it with {@link
   * #install}'s link; a {@code slack} trigger then names a workspace's {@code team} and a channel
   * the app is in.
   */
  public static final class Slack {
    private final Transport t;

    Slack(Transport transport) {
      this.t = transport;
    }

    /**
     * A link that adds Runtime's Slack app to a workspace, good for 15 minutes: {@code url} and
     * {@code expiresAt}. Open it as a person who may add apps to the workspace; Slack sends them
     * back to the console once it is added.
     */
    public JsonObject install() {
      return new JsonObject(t.object(new Transport.Call("POST", "/v1/agents/slack/installs").body(Map.of())));
    }

    /** The workspaces added to this account: {@code team}, {@code name}, {@code botUser}, {@code installedAt}. */
    public List<JsonObject> teams() {
      return new JsonObject(t.object(new Transport.Call("GET", "/v1/agents/slack/teams")))
          .getObjects("data", JsonObject::new);
    }

    /** Removes a workspace: its token is revoked, and its triggers refuse events until it is added again. */
    public void remove(String team) {
      t.json(new Transport.Call("DELETE", "/v1/agents/slack/teams/" + Transport.segment(team)));
    }
  }

  /** Each agent's built-in memory: files its sessions keep and search, shared or one key's alone. */
  public AgentMemory memory() {
    return memory;
  }

  /** The account's inbox: what its sessions need answered, one row per step however many ask it. */
  public Asks asks() {
    return asks;
  }

  /** Many sessions in phases, fanned out and pipelined, with limits and a cost cap. */
  public Workflows workflows() {
    return workflows;
  }

  /**
   * The five harnesses (claude-code, codex, gemini-cli, claude-agent-sdk, openai-agents-sdk) and the
   * two uses (support, team), as data.
   */
  public AgentTemplates templates() {
    return AgentTemplates.ALL;
  }

  public Agent create(String name, AgentDefinition definition) {
    return create(name, definition, null, null);
  }

  /**
   * Makes an agent at version 1. labels and idempotencyKey may be null. A name already used is a
   * Conflict (name_taken); the names sessions, triggers, templates and approvals are refused, since
   * they are paths beside the agents.
   */
  public Agent create(String name, AgentDefinition definition, Map<String, String> labels, String idempotencyKey) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("name", name);
    body.put("definition", definition.toMap());
    if (labels != null) body.put("labels", labels);
    return new Agent(t.object(new Transport.Call("POST", "/v1/agents").body(body).key(idempotencyKey)));
  }

  /** An agent by id or name. */
  public Agent get(String agent) {
    return new Agent(t.object(new Transport.Call("GET", path(agent))));
  }

  /** The first page of agents. Iterating the page walks every one. */
  public Page<Agent> list() {
    return list(null, null);
  }

  /**
   * The page at cursor (a page's {@link Page#nextCursor()}; null is the first), of at most limit
   * agents (null: the API's default).
   */
  public Page<Agent> list(String cursor, Integer limit) {
    return Page.read(t, listCall(cursor, limit), Agent::new, next -> listCall(next, limit));
  }

  private static Transport.Call listCall(String cursor, Integer limit) {
    return new Transport.Call("GET", "/v1/agents").query("cursor", cursor).query("limit", limit);
  }

  /** Replaces the whole definition: a new version, which sessions started from now on run. */
  public Agent update(String agent, AgentDefinition definition) {
    return new Agent(
        t.object(new Transport.Call("PATCH", path(agent)).body(Map.of("definition", definition.toMap()))));
  }

  public void delete(String agent) {
    t.json(new Transport.Call("DELETE", path(agent)));
  }

  /** Starts a session with these words. */
  public AgentSession start(String agent, String input) {
    return start(agent, input, null, null, null);
  }

  /**
   * Starts a session with these words; every other argument may be null. A key, your own name for
   * the conversation ({@code customer:42}, {@code ticket:981}), joins the open session with the
   * same key instead, and the words go to it: {@link AgentSession#joined()} says which. An agent at
   * its day's budget is refused with budget_reached (402).
   */
  public AgentSession start(
      String agent, String input, String key, Map<String, String> labels, String idempotencyKey) {
    return start(agent, input, key, labels, null, idempotencyKey);
  }

  /**
   * Starts a session with its own model, instructions, MCP servers, disallowed tools, size and
   * budget, within the agent's session overrides; every argument but agent and input may be null.
   * An override the agent does not allow is refused with permission_denied (403), naming what it
   * allows; words that join an open session carry its own overrides or none (else conflict, 409).
   */
  public AgentSession start(
      String agent,
      String input,
      String key,
      Map<String, String> labels,
      AgentSessionOverrides overrides,
      String idempotencyKey) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("input", input);
    if (key != null) body.put("key", key);
    if (labels != null) body.put("labels", labels);
    if (overrides != null) body.put("overrides", overrides.toMap());
    JsonObject answer =
        new JsonObject(
            t.object(new Transport.Call("POST", path(agent) + "/sessions").body(body).key(idempotencyKey)));
    AgentSessionInfo session = new AgentSessionInfo(answer.getObject("session").raw());
    return new AgentSession(t, session, answer.getBoolean("joined"), answer.getLong("seq", session.lastSeq()));
  }

  /** {@code runtime.agents().sessions()}: sessions by id, across agents. */
  public static final class Sessions {
    private final Transport t;

    Sessions(Transport transport) {
      this.t = transport;
    }

    /** A session to follow, send to or stop. */
    public AgentSession get(String id) {
      AgentSessionInfo info = new AgentSessionInfo(t.object(new Transport.Call("GET", AgentSession.path(id, ""))));
      return new AgentSession(t, info, false, info.lastSeq());
    }

    /**
     * Deletes an ended session's history: its log, and every log under it in its tree. Until then
     * the history is kept, counted as storage. The session is kept as a deleted record: {@link
     * #get} still reads it, with deletedAt set, reason deleted, key and result cleared and its cost
     * kept (a delete never frees budget), and its log reads empty. An open session or tree is
     * refused with a Conflict, session_open: stop it first.
     */
    public void delete(String id) {
      t.json(new Transport.Call("DELETE", AgentSession.path(id, "")));
    }

    /** The first page of sessions, newest first. Either filter may be null: an agent's id or name, and a state. */
    public Page<AgentSessionInfo> list(String agent, String state) {
      return list(agent, state, null, null);
    }

    /**
     * The page at cursor (a page's {@link Page#nextCursor()}; null is the first), of at most
     * limit sessions (null: the API's default).
     */
    public Page<AgentSessionInfo> list(String agent, String state, String cursor, Integer limit) {
      return Page.read(t, call(agent, state, cursor, limit), AgentSessionInfo::new, next -> call(agent, state, next, limit));
    }

    /**
     * The first page of sessions these filters find, newest first: by agent and state, a session's
     * direct children ({@link ListAgentSessions#parent}), a whole tree ({@link
     * ListAgentSessions#root}), and deleted records too ({@link ListAgentSessions#includeDeleted}).
     */
    public Page<AgentSessionInfo> list(ListAgentSessions filter) {
      return Page.read(t, call(filter, filter.cursor), AgentSessionInfo::new, next -> call(filter, next));
    }

    private static Transport.Call call(String agent, String state, String cursor, Integer limit) {
      return call(new ListAgentSessions().agent(agent).state(state).limit(limit), cursor);
    }

    private static Transport.Call call(ListAgentSessions filter, String cursor) {
      return new Transport.Call("GET", "/v1/agents/sessions")
          .query("agent", filter.agent)
          .query("state", filter.state)
          .query("parent", filter.parent)
          .query("root", filter.root)
          .query("deleted", filter.includeDeleted ? "true" : null)
          .query("cursor", cursor)
          .query("limit", filter.limit);
    }
  }

  /**
   * {@code runtime.agents().triggers()}: what starts an agent's sessions besides the API. Kinds and
   * their config:
   *
   * <ul>
   *   <li>{@code slack}: {@code {team, channel}}; Runtime's Slack app must be installed for the
   *       team, else a Conflict (not_installed).
   *   <li>{@code github}: {@code {repository, installation, events?}}; installation is your own
   *       installation id of Runtime's GitHub App, required, else a Conflict (not_installed).
   *   <li>{@code schedule}: {@code {cron, timezone?, input}}.
   *   <li>{@code webhook}: {@code {}}.
   * </ul>
   *
   * <p>Each trigger has rules, every one optional: {@code priority} (-100 to 100: queue order when
   * the agent's maxConcurrent is full, higher first), {@code maxStartsPerHour} (a call past it is
   * held for you), {@code onEnded} ({@code start}, {@code note} or {@code ask}: what a call does
   * when its key's session has ended), {@code notify} ({@code email} or {@code webhook}: where a
   * held call is told) and, a webhook's only, {@code key} ({@code "{cause}"}: the key of a call
   * that sends none, from its JSON's fields). A call no session can take is held, never dropped:
   * {@link #held}, {@link #startHeld}, {@link #dismissHeld}.
   */
  public static final class Triggers {
    private final Transport t;

    Triggers(Transport transport) {
      this.t = transport;
    }

    private static String path(String id, String verb) {
      return "/v1/agents/triggers/" + Transport.segment(id) + verb;
    }

    public AgentTrigger create(String agent, String kind, Map<String, ?> config) {
      return create(agent, kind, config, null);
    }

    /** A trigger with its rules (null: every default). */
    public AgentTrigger create(String agent, String kind, Map<String, ?> config, Map<String, ?> rules) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("kind", kind);
      body.put("config", config == null ? Map.of() : config);
      if (rules != null) body.put("rules", rules);
      return new AgentTrigger(t.object(new Transport.Call("POST", Agents.path(agent) + "/triggers").body(body)));
    }

    /** Its rules, whole, in place: its secret stays. An empty map is every default. */
    public AgentTrigger setRules(String id, Map<String, ?> rules) {
      return new AgentTrigger(
          t.object(new Transport.Call("PATCH", path(id, "")).body(Map.of("rules", java.util.Objects.requireNonNull(rules, "rules")))));
    }

    /**
     * Calls a webhook trigger as its sender would, by its secret, never your key: {@code outcome}
     * started, joined (the open session with key), noted or held, with {@code sessionId}, {@code
     * seq}, {@code callId} and {@code why}. key, labels and idempotencyKey may be null; the same
     * idempotencyKey is the same call.
     */
    public JsonObject call(
        String id, String secret, String text, String key, Map<String, String> labels, String idempotencyKey) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("text", java.util.Objects.requireNonNull(text, "text"));
      if (key != null) body.put("key", key);
      if (labels != null) body.put("labels", labels);
      return new JsonObject(
          t.object(
              new Transport.Call("POST", path(id, "/calls"))
                  .body(body)
                  .bearer(java.util.Objects.requireNonNull(secret, "secret"))
                  .key(idempotencyKey)));
    }

    /** The calls it held for you, newest first; state (held, started or dismissed) may be null. */
    public Page<JsonObject> held(String id, String state) {
      return Page.read(t, heldCall(id, state, null), JsonObject::new, next -> heldCall(id, state, next));
    }

    private static Transport.Call heldCall(String id, String state, String cursor) {
      return new Transport.Call("GET", path(id, "/held")).query("state", state).query("cursor", cursor);
    }

    /**
     * Starts a held call: one session with it and every call held for its key since, oldest first.
     * {@code session}, {@code joined} and {@code calls}.
     */
    public JsonObject startHeld(String id, String callId) {
      return new JsonObject(
          t.object(new Transport.Call("POST", path(id, "/held/" + Transport.segment(callId) + "/start")).body(Map.of())));
    }

    /** Dismisses a held call: nothing runs. */
    public JsonObject dismissHeld(String id, String callId) {
      return new JsonObject(
          t.object(new Transport.Call("POST", path(id, "/held/" + Transport.segment(callId) + "/dismiss")).body(Map.of())));
    }

    /** An agent's triggers, every one. */
    public List<AgentTrigger> list(String agent) {
      return new JsonObject(t.object(new Transport.Call("GET", Agents.path(agent) + "/triggers")))
          .getObjects("data", AgentTrigger::new);
    }

    /** Holds one trigger, saying why: a webhook's calls are held for you ({@link #held}), never dropped. */
    public AgentTrigger pause(String id, String why) {
      return new AgentTrigger(t.object(new Transport.Call("POST", path(id, "/pause")).body(Map.of("why", java.util.Objects.requireNonNull(why, "why")))));
    }

    public AgentTrigger resume(String id) {
      return new AgentTrigger(t.object(new Transport.Call("POST", path(id, "/resume")).body(Map.of())));
    }

    public void delete(String id) {
      t.json(new Transport.Call("DELETE", path(id, "")));
    }
  }

  /**
   * {@code runtime.agents().asks()}: the account's inbox. An ask closes by itself when every
   * session asking it ends, when they withdraw it, or when it expires, its pick taken as the answer
   * when it has one.
   */
  public static final class Asks {
    private final Transport t;

    Asks(Transport transport) {
      this.t = transport;
    }

    private static String path(String id, String verb) {
      return "/v1/agents/asks/" + Transport.segment(id) + verb;
    }

    /** The open asks, newest first. */
    public Page<AgentAsk> list() {
      return list(null, null, null, null, null);
    }

    /**
     * The page at cursor (null: the first), newest first: in these states (null: open), of one
     * agent (an id or name, or null), carrying every one of labels (who sees an ask; or null), at
     * most limit (null: the API's default).
     */
    public Page<AgentAsk> list(List<String> states, String agent, Map<String, String> labels, String cursor, Integer limit) {
      return Page.read(t, call(states, agent, labels, cursor, limit), AgentAsk::new, next -> call(states, agent, labels, next, limit));
    }

    private static Transport.Call call(List<String> states, String agent, Map<String, String> labels, String cursor, Integer limit) {
      Transport.Call call = new Transport.Call("GET", "/v1/agents/asks");
      if (states != null) for (String state : states) call.query("state", state);
      call.query("agent", agent);
      if (labels != null) for (Map.Entry<String, String> label : labels.entrySet()) call.query("label", label.getKey() + ":" + label.getValue());
      return call.query("cursor", cursor).query("limit", limit);
    }

    /** One ask, with the sessions asking it. */
    public AgentAsk get(String id) {
      return new AgentAsk(t.object(new Transport.Call("GET", path(id, ""))));
    }

    /**
     * Answers with an option's label and/or text (either may be null, not both): every session
     * asking reads it next and wakes. One no longer open is a Conflict, ask_closed.
     */
    public AgentAsk answer(String id, String option, String text) {
      if (option == null && text == null) throw new IllegalArgumentException("An answer is an option's label, text, or both.");
      Map<String, Object> body = new LinkedHashMap<>();
      if (option != null) body.put("option", option);
      if (text != null) body.put("text", text);
      return new AgentAsk(t.object(new Transport.Call("POST", path(id, "/answer")).body(body)));
    }

    /** Lets a tool call the agent's permissions held run (its ask's Allow). */
    public AgentAsk approve(String id) {
      return answer(id, "Allow", null);
    }

    /**
     * Keeps a held tool call from running (its ask's Deny); {@code message}, which may be null, is
     * told to the agent as the reason.
     */
    public AgentAsk deny(String id, String message) {
      return answer(id, "Deny", message);
    }
  }

  /**
   * {@code runtime.agents().workflows()}: many sessions in phases. A workflow is data, not code:
   * each phase names an {@code agent} (or uses the workflow's), an {@code input} template
   * ({@code {{input}}}, {@code {{item}}}, {@code {{index}}}, and {@code {{<phase>}}} for an earlier
   * phase's results) and {@code each}, a list of items (1 to 1000) or {@code {from, split}} (json
   * or lines) to fan out over an earlier phase's result. A phase waits for every phase before it,
   * unless {@code pipeline} is true: then each item starts as soon as its own item in the source
   * phase ends. {@code maxSessions} (100 unless set, at most 1000), {@code maxConcurrent} (20, at
   * most 200) and {@code maxDollars} (10, at most 10000) bound it; at the cap it fails with reason
   * budget.
   */
  public static final class Workflows {
    private final Transport t;

    Workflows(Transport transport) {
      this.t = transport;
    }

    /** Runs it now. An invalid spec is an InvalidRequest, its details naming the field. */
    public AgentWorkflow run(Map<String, ?> spec) {
      return run(spec, null);
    }

    /** Runs it now; a retry with the same idempotencyKey (null: one made here) runs it once. */
    public AgentWorkflow run(Map<String, ?> spec, String idempotencyKey) {
      Map<String, Object> raw = t.object(new Transport.Call("POST", "/v1/agents/workflows").body(spec).key(idempotencyKey));
      return new AgentWorkflow(t, new AgentWorkflow.Info(raw));
    }

    public AgentWorkflow get(String id) {
      return new AgentWorkflow(t, new AgentWorkflow.Info(t.object(new Transport.Call("GET", AgentWorkflow.path(id, "")))));
    }

    /** Workflows, newest first. */
    public Page<AgentWorkflow.Info> list() {
      return list(null, null, null);
    }

    /** The page at cursor (null: the first), newest first, in these states (null: all). */
    public Page<AgentWorkflow.Info> list(List<String> states, String cursor, Integer limit) {
      return Page.read(t, call(states, cursor, limit), AgentWorkflow.Info::new, next -> call(states, next, limit));
    }

    private static Transport.Call call(List<String> states, String cursor, Integer limit) {
      Transport.Call call = new Transport.Call("GET", "/v1/agents/workflows");
      if (states != null) for (String state : states) call.query("state", state);
      return call.query("cursor", cursor).query("limit", limit);
    }
  }
}
