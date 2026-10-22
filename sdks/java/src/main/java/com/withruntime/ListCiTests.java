package com.withruntime;

/** A list of a repository's CI/CD test files' filters, every one optional. */
public final class ListCiTests {
  public ListCiTests() {}

  Boolean quarantined;
  Integer limit;
  String cursor;

  /** True: only quarantined files; false: only gating ones. */
  public ListCiTests quarantined(boolean quarantined) {
    this.quarantined = quarantined;
    return this;
  }

  /** The page size, 1 to 100; default 50. */
  public ListCiTests limit(int limit) {
    this.limit = limit;
    return this;
  }

  /** Start at a page an earlier list's {@link Page#nextCursor()} named. */
  public ListCiTests cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }

  Transport.Call call(String repositoryId, String from) {
    return new Transport.Call("GET", "/v1/ci/tests")
        .query("repositoryId", repositoryId)
        .query("quarantined", quarantined)
        .query("limit", limit)
        .query("cursor", from != null ? from : cursor);
  }
}
