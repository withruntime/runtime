package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A GitHub repository to connect for CI/CD checks. Only a full key connects one. Fields left out
 * take the API's defaults.
 */
public final class ConnectCiRepository extends Params<ConnectCiRepository> {
  /** @param repository owner/name on GitHub */
  public ConnectCiRepository(String repository) {
    set("repository", repository);
  }

  /** The branch whose pushes are checked as landed; main by default. */
  public ConnectCiRepository productionBranch(String branch) {
    return set("productionBranch", branch);
  }

  /**
   * Where in the repository its checks are written; runtime.yml by default. A cloudbuild.yaml or
   * buildspec.yml runs as Cloud Build or CodeBuild runs it.
   */
  public ConnectCiRepository configPath(String path) {
    return set("configPath", path);
  }

  /** The installation of Runtime's GitHub App to read it through; the newest by default. */
  public ConnectCiRepository installation(long installation) {
    return set("installation", installation);
  }

  public ConnectCiRepository name(String name) {
    return set("name", name);
  }

  public ConnectCiRepository labels(Map<String, String> labels) {
    return set("labels", new LinkedHashMap<>(labels));
  }
}
