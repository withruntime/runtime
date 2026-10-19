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
  // Approvals come next, with their own table: agents().approvals().list() and answer(...).

  Agents(Transport transport) {
    this.t = transport;
    this.sessions = new Sessions(transport);
    this.triggers = new Triggers(transport);
  }

  static String path(String agent) {
    return "/v1/agents/" + Transport.segment(agent);
  }

  /** Sessions by id, across agents. */
  public Sessions sessions() {
    return sessions;
  }

  /** What starts sessions besides the API: Slack, GitHub, a schedule, a webhook. */
  public Triggers triggers() {
    return triggers;
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
   * its day's budget is refused with a Conflict, budget_reached.
   */
  public AgentSession start(
      String agent, String input, String key, Map<String, String> labels, String idempotencyKey) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("input", input);
    if (key != null) body.put("key", key);
    if (labels != null) body.put("labels", labels);
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
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("kind", kind);
      body.put("config", config == null ? Map.of() : config);
      return new AgentTrigger(t.object(new Transport.Call("POST", Agents.path(agent) + "/triggers").body(body)));
    }

    /** An agent's triggers, every one. */
    public List<AgentTrigger> list(String agent) {
      return new JsonObject(t.object(new Transport.Call("GET", Agents.path(agent) + "/triggers")))
          .getObjects("data", AgentTrigger::new);
    }

    /** Holds one trigger: what reaches it is refused (trigger_paused, with why) and never queued. */
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
}
