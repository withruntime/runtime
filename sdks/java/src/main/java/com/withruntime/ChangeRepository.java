package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A connected repository's settings changed in place; its id and builds stay. A field left out
 * stays as it is; null clears the fields that take it.
 */
public final class ChangeRepository extends Params<ChangeRepository> {
  public ChangeRepository() {}

  private ChangeRepository nullable(String field, Object value) {
    body.put(field, value);
    return this;
  }

  public ChangeRepository repository(String repository) {
    return set("repository", repository);
  }

  public ChangeRepository deploy(String deploy) {
    return set("deploy", deploy);
  }

  public ChangeRepository productionBranch(String branch) {
    return set("productionBranch", branch);
  }

  public ChangeRepository previews(boolean previews) {
    return set("previews", previews);
  }

  public ChangeRepository rootDirectory(String directory) {
    return set("rootDirectory", directory);
  }

  /** null goes back to choosing by the lockfile. */
  public ChangeRepository installCommand(String command) {
    return nullable("installCommand", command);
  }

  public ChangeRepository buildCommand(String command) {
    return nullable("buildCommand", command);
  }

  public ChangeRepository startCommand(String command) {
    return nullable("startCommand", command);
  }

  public ChangeRepository port(int port) {
    return set("port", port);
  }

  public ChangeRepository healthPath(String path) {
    return nullable("healthPath", path);
  }

  public ChangeRepository buildEnv(Map<String, String> env) {
    return set("buildEnv", new LinkedHashMap<>(env));
  }

  /** null clears the name. */
  public ChangeRepository name(String name) {
    return nullable("name", name);
  }

  public ChangeRepository labels(Map<String, String> labels) {
    return set("labels", new LinkedHashMap<>(labels));
  }
}
