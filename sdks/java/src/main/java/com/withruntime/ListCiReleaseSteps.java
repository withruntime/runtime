package com.withruntime;

/** A list of CI/CD release steps' filters, every one optional. */
public final class ListCiReleaseSteps {
  public ListCiReleaseSteps() {}

  String repositoryId;
  String commit;
  Integer limit;
  String cursor;

  public ListCiReleaseSteps repositoryId(String id) {
    this.repositoryId = id;
    return this;
  }

  /** Keep only this commit's release. */
  public ListCiReleaseSteps commit(String commit) {
    this.commit = commit;
    return this;
  }

  /** The page size, 1 to 100; default 50. */
  public ListCiReleaseSteps limit(int limit) {
    this.limit = limit;
    return this;
  }

  /** Start at a page an earlier list's {@link Page#nextCursor()} named. */
  public ListCiReleaseSteps cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }

  Transport.Call call(String from) {
    return new Transport.Call("GET", "/v1/ci/releases")
        .query("repositoryId", repositoryId)
        .query("commit", commit)
        .query("limit", limit)
        .query("cursor", from != null ? from : cursor);
  }
}
