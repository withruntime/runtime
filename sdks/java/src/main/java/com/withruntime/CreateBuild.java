package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/** A build of a connected repository at a ref (a branch, a tag or a commit). */
public final class CreateBuild extends Params<CreateBuild> {
  public CreateBuild(String repositoryId, String ref) {
    set("repositoryId", repositoryId);
    set("ref", ref);
  }

  /**
   * The branch whose move asks for it. The same branch and commit is one build; a newer build of
   * the branch supersedes older ones not yet ended.
   */
  public CreateBuild branch(String branch) {
    return set("branch", branch);
  }

  public CreateBuild name(String name) {
    return set("name", name);
  }

  public CreateBuild labels(Map<String, String> labels) {
    return set("labels", new LinkedHashMap<>(labels));
  }
}
