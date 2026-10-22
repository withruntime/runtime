package com.withruntime;

import java.util.List;
import java.util.Map;

/**
 * {@code runtime.agents().memory()}: an agent's built-in memory, text files its sessions keep across
 * sessions and search. A scope is whose: {@code ""} for what every session of the agent shares, or a
 * session key such as {@code customer:42} for that key's alone. Up to 1 MiB a file, 1 GiB and
 * 100,000 files an agent, billed as storage; past them a write is refused with a Conflict,
 * memory_full.
 *
 * <pre>{@code
 * runtime.agents().memory().write("helpdesk", "faq/refunds.md", "Refunds within 30 days.");
 * for (AgentMemoryFile hit : runtime.agents().memory().search("helpdesk", "refund", null, null))
 *   System.out.println(hit.path() + ": " + hit.snippet());
 * }</pre>
 */
public final class AgentMemory {
  private final Transport t;

  AgentMemory(Transport transport) {
    this.t = transport;
  }

  private static String path(String agent) {
    return Agents.path(agent) + "/memory";
  }

  /** The first page of an agent's files in every scope, by scope and path. */
  public Page<AgentMemoryFile> list(String agent) {
    return list(agent, null, null, null, null);
  }

  /**
   * The page at cursor (null: the first) of an agent's files, by scope and path; scope null is
   * every scope, prefix null every path, limit null the API's 100 (at most 1000).
   */
  public Page<AgentMemoryFile> list(String agent, String scope, String prefix, String cursor, Integer limit) {
    return Page.read(t, listCall(agent, scope, prefix, cursor, limit), AgentMemoryFile::new, next -> listCall(agent, scope, prefix, next, limit));
  }

  private static Transport.Call listCall(String agent, String scope, String prefix, String cursor, Integer limit) {
    return new Transport.Call("GET", path(agent))
        .queryKept("scope", scope)
        .query("prefix", prefix)
        .query("cursor", cursor)
        .query("limit", limit);
  }

  /** The agent's whole memory, every scope: what storage is billed on, and its bounds. */
  public AgentMemoryUsage usage(String agent) {
    return new AgentMemoryUsage(new JsonObject(t.object(listCall(agent, null, null, null, 1))).getObject("usage").raw());
  }

  /**
   * The files whose words or path match q (words, "a phrase", or, -not), best first, each with a
   * snippet; scope null searches every scope, limit null is the API's 10 (at most 50).
   */
  public List<AgentMemoryFile> search(String agent, String q, String scope, Integer limit) {
    Transport.Call call = new Transport.Call("GET", path(agent)).queryKept("scope", scope).query("q", q).query("limit", limit);
    return new JsonObject(t.object(call)).getObjects("data", AgentMemoryFile::new);
  }

  /** A file of the shared memory, with its text. */
  public AgentMemoryFile read(String agent, String path) {
    return read(agent, path, "");
  }

  /** A file with its text; none there is a NotFound. */
  public AgentMemoryFile read(String agent, String path, String scope) {
    return new AgentMemoryFile(t.object(file("GET", agent, path, scope)));
  }

  /** Seeds or replaces a file of the shared memory. */
  public AgentMemoryFile write(String agent, String path, String content) {
    return write(agent, path, content, "");
  }

  /** Seeds or replaces a file; {@link AgentMemoryFile#created()} says which. */
  public AgentMemoryFile write(String agent, String path, String content, String scope) {
    return new AgentMemoryFile(t.object(file("PUT", agent, path, scope).body(Map.of("content", content))));
  }

  /** Deletes a file of the shared memory; whether there was one. */
  public boolean delete(String agent, String path) {
    return delete(agent, path, "");
  }

  /** Deletes a file; whether there was one. */
  public boolean delete(String agent, String path, String scope) {
    return new JsonObject(t.object(file("DELETE", agent, path, scope))).getBoolean("deleted");
  }

  private static Transport.Call file(String method, String agent, String path, String scope) {
    return new Transport.Call(method, path(agent) + "/content")
        .queryKept("scope", scope == null ? "" : scope)
        .queryKept("path", path);
  }
}
