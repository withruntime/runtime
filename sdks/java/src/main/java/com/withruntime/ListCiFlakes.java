package com.withruntime;

import java.util.ArrayList;
import java.util.List;

/** A list of CI/CD flaky tests' filters, every one optional. */
public final class ListCiFlakes {
  public ListCiFlakes() {}

  String repositoryId;
  final List<String> states = new ArrayList<>();
  Integer limit;
  String cursor;

  public ListCiFlakes repositoryId(String id) {
    this.repositoryId = id;
    return this;
  }

  /** Keep only these states: quarantined, gating (the open ones), fixed or deleted. */
  public ListCiFlakes state(String... states) {
    this.states.addAll(List.of(states));
    return this;
  }

  /** The page size, 1 to 100; default 50. */
  public ListCiFlakes limit(int limit) {
    this.limit = limit;
    return this;
  }

  /** Start at a page an earlier list's {@link Page#nextCursor()} named. */
  public ListCiFlakes cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }

  Transport.Call call(String from) {
    Transport.Call call =
        new Transport.Call("GET", "/v1/ci/flakes").query("repositoryId", repositoryId).query("limit", limit);
    for (String state : states) call.query("state", state);
    return call.query("cursor", from != null ? from : cursor);
  }
}
