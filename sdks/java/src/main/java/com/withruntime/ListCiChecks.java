package com.withruntime;

import java.util.ArrayList;
import java.util.List;

/** A list of CI/CD checks' filters, newest first, every one optional. */
public final class ListCiChecks {
  public ListCiChecks() {}

  String repositoryId;
  final List<String> states = new ArrayList<>();
  String branch;
  String commit;
  Integer pullRequest;
  Integer limit;
  String cursor;

  public ListCiChecks repositoryId(String id) {
    this.repositoryId = id;
    return this;
  }

  /** Keep only these states: queued, running, passed, failed or cancelled. */
  public ListCiChecks state(String... states) {
    this.states.addAll(List.of(states));
    return this;
  }

  public ListCiChecks branch(String branch) {
    this.branch = branch;
    return this;
  }

  /** A full commit SHA. */
  public ListCiChecks commit(String commit) {
    this.commit = commit;
    return this;
  }

  public ListCiChecks pullRequest(int number) {
    this.pullRequest = number;
    return this;
  }

  /** The page size, 1 to 100; default 50. */
  public ListCiChecks limit(int limit) {
    this.limit = limit;
    return this;
  }

  /** Start at a page an earlier list's {@link Page#nextCursor()} named. */
  public ListCiChecks cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }

  Transport.Call call(String from) {
    Transport.Call call =
        new Transport.Call("GET", "/v1/ci/checks")
            .query("repositoryId", repositoryId)
            .query("branch", branch)
            .query("commit", commit)
            .query("pullRequest", pullRequest);
    for (String state : states) call.query("state", state);
    return call.query("limit", limit).query("cursor", from != null ? from : cursor);
  }
}
