package com.withruntime;

/** A list of agent sessions' filters, every one optional. */
public final class ListAgentSessions {
  public ListAgentSessions() {}

  String agent;
  String state;
  String parent;
  String root;
  boolean includeDeleted;
  String cursor;
  Integer limit;

  /** One agent's sessions, by its id or name. */
  public ListAgentSessions agent(String agent) {
    this.agent = agent;
    return this;
  }

  /** queued, running, waiting, done, failed or stopped. */
  public ListAgentSessions state(String state) {
    this.state = state;
    return this;
  }

  /** A session's direct children, by its id. */
  public ListAgentSessions parent(String sessionId) {
    this.parent = sessionId;
    return this;
  }

  /** The whole tree under a top session, by its id, the root included. */
  public ListAgentSessions root(String sessionId) {
    this.root = sessionId;
    return this;
  }

  /** Deleted records too, which a list hides otherwise. */
  public ListAgentSessions includeDeleted() {
    this.includeDeleted = true;
    return this;
  }

  /** The page at this cursor (a page's {@link Page#nextCursor()}); unset is the first. */
  public ListAgentSessions cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }

  /** The page size; null for the API's default. */
  public ListAgentSessions limit(Integer limit) {
    this.limit = limit;
    return this;
  }
}
