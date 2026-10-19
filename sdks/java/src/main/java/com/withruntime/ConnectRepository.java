package com.withruntime;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A repository to connect: where it is and what its builds deploy. A private GitHub repository is
 * read through Runtime's GitHub App: install it first with {@link
 * Builds.Repositories#installGithub()}.
 */
public final class ConnectRepository extends Params<ConnectRepository> {
  /**
   * @param provider github or git
   * @param repository owner/name on GitHub, or a git URL
   * @param deploy app:&lt;id&gt;, function:&lt;id&gt; or container:&lt;id&gt;
   */
  public ConnectRepository(String provider, String repository, String deploy) {
    set("provider", provider);
    set("repository", repository);
    set("deploy", deploy);
  }

  public ConnectRepository productionBranch(String branch) {
    return set("productionBranch", branch);
  }

  /** Whether other branches build previews. */
  public ConnectRepository previews(boolean previews) {
    return set("previews", previews);
  }

  /** The folder the build runs in; the repository's root by default. */
  public ConnectRepository rootDirectory(String directory) {
    return set("rootDirectory", directory);
  }

  /** Left out, chosen by the lockfile (bun, pnpm, Yarn or npm). */
  public ConnectRepository installCommand(String command) {
    return set("installCommand", command);
  }

  public ConnectRepository buildCommand(String command) {
    return set("buildCommand", command);
  }

  /**
   * Run after the build with PORT set: the build ends as this server, answering healthPath with
   * 200 and saved with its memory.
   */
  public ConnectRepository startCommand(String command) {
    return set("startCommand", command);
  }

  public ConnectRepository port(int port) {
    return set("port", port);
  }

  public ConnectRepository healthPath(String path) {
    return set("healthPath", path);
  }

  /** Settings install and build are given. Never a secret: anyone who reads the repository sees them. */
  public ConnectRepository buildEnv(Map<String, String> env) {
    return set("buildEnv", new LinkedHashMap<>(env));
  }

  public ConnectRepository name(String name) {
    return set("name", name);
  }

  public ConnectRepository labels(Map<String, String> labels) {
    return set("labels", new LinkedHashMap<>(labels));
  }
}
