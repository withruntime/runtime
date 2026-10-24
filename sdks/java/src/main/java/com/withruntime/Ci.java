package com.withruntime;

/**
 * {@code runtime.ci()}: CI/CD. A connected GitHub repository ({@link #repositories()}) has its
 * pushes and pull requests checked ({@link #checks()}, {@link #jobs()}) in sandboxes the runner
 * drives for the account; {@link #tests()} reads its test files and their quarantine, and
 * {@link #flakes()} its flaky tests, each quarantined and handed to an owner.
 *
 * <p>In private beta: an account outside the beta is refused with {@link
 * RuntimeCloudException.PermissionDenied}, code product_in_beta (403).
 */
public final class Ci {
  private final Repositories repositories;
  private final Checks checks;
  private final Jobs jobs;
  private final Tests tests;
  private final Flakes flakes;

  Ci(Transport transport) {
    this.repositories = new Repositories(transport);
    this.checks = new Checks(transport);
    this.jobs = new Jobs(transport);
    this.tests = new Tests(transport);
    this.flakes = new Flakes(transport);
  }

  /** Connected repositories, whose pushes and pull requests are checked. */
  public Repositories repositories() {
    return repositories;
  }

  public Checks checks() {
    return checks;
  }

  public Jobs jobs() {
    return jobs;
  }

  public Tests tests() {
    return tests;
  }

  /** Tests that passed and failed on the same inputs. */
  public Flakes flakes() {
    return flakes;
  }

  /** {@code ci().repositories()}: connect, list, set undo and disconnect. */
  public static final class Repositories {
    private final Transport t;

    Repositories(Transport transport) {
      this.t = transport;
    }

    /** Connects a repository; only a full key connects one. */
    public CiRepository connect(ConnectCiRepository input) {
      return new CiRepository(
          t.object(new Transport.Call("POST", "/v1/ci/repositories").body(input.toMap()).key(input.idempotencyKey)));
    }

    public Page<CiRepository> list() {
      return list(null);
    }

    public Page<CiRepository> list(ListResources filter) {
      return ListResources.read(t, "/v1/ci/repositories", filter, CiRepository::new);
    }

    /**
     * Turns on (or off) the undo of a red production branch's culprit: when main's check fails,
     * CI/CD finds the first commit that fails it and opens a pull request reverting it, which lands
     * once its own check passes. Off until set; only an owner's or admin's full key sets it.
     */
    public CiRepository setUndo(String id, boolean on) {
      return new CiRepository(
          t.object(
              new Transport.Call("POST", "/v1/ci/repositories/" + Transport.segment(id) + ":update")
                  .body(java.util.Map.of("undoCulprits", on))));
    }

    /** Disconnects a repository; its checks still going are cancelled. */
    public CiRepository disconnect(String id) {
      return new CiRepository(t.object(new Transport.Call("DELETE", "/v1/ci/repositories/" + Transport.segment(id))));
    }
  }

  /** {@code ci().checks()}. */
  public static final class Checks {
    private final Transport t;

    Checks(Transport transport) {
      this.t = transport;
    }

    /** Checks, newest first. */
    public Page<CiCheck> list() {
      return list(null);
    }

    public Page<CiCheck> list(ListCiChecks filter) {
      ListCiChecks query = filter == null ? new ListCiChecks() : filter;
      return Page.read(t, query.call(null), CiCheck::new, query::call);
    }

    /** A check with its jobs in plan order. */
    public CiCheckDetail get(String id) {
      return new CiCheckDetail(t.object(new Transport.Call("GET", "/v1/ci/checks/" + Transport.segment(id))));
    }

    /** Cancel a queued or running check: its jobs end and its machines are let go. */
    public CiCheckDetail cancel(String id) {
      return new CiCheckDetail(
          t.object(new Transport.Call("POST", "/v1/ci/checks/" + Transport.segment(id) + ":cancel")));
    }
  }

  /** {@code ci().jobs()}. */
  public static final class Jobs {
    private final Transport t;

    Jobs(Transport transport) {
      this.t = transport;
    }

    /** A job with the tail of its output (the last 256 KiB). */
    public CiJobDetail get(String id) {
      return new CiJobDetail(t.object(new Transport.Call("GET", "/v1/ci/jobs/" + Transport.segment(id))));
    }
  }

  /** {@code ci().tests()}. */
  public static final class Tests {
    private final Transport t;

    Tests(Transport transport) {
      this.t = transport;
    }

    /** A repository's test files by name. */
    public Page<CiTest> list(String repositoryId) {
      return list(repositoryId, null);
    }

    public Page<CiTest> list(String repositoryId, ListCiTests filter) {
      ListCiTests query = filter == null ? new ListCiTests() : filter;
      return Page.read(t, query.call(repositoryId, null), CiTest::new, cursor -> query.call(repositoryId, cursor));
    }
  }

  /** {@code ci().flakes()}: list, get, and an owner's say. */
  public static final class Flakes {
    private final Transport t;

    Flakes(Transport transport) {
      this.t = transport;
    }

    /** Flaky tests, newest first. */
    public Page<CiFlake> list() {
      return list(null);
    }

    public Page<CiFlake> list(ListCiFlakes filter) {
      ListCiFlakes query = filter == null ? new ListCiFlakes() : filter;
      return Page.read(t, query.call(null), CiFlake::new, query::call);
    }

    /** A flaky test with its test file's newest 200 runs and its failures' jobs. */
    public CiFlake get(String id) {
      return new CiFlake(t.object(new Transport.Call("GET", "/v1/ci/flakes/" + Transport.segment(id))));
    }

    /** Ask for its 100 proof runs again, hand it on, or say why its test is deleted. */
    public CiFlake update(String id, UpdateCiFlake change) {
      return new CiFlake(
          t.object(
              new Transport.Call("POST", "/v1/ci/flakes/" + Transport.segment(id) + ":update")
                  .body(change.toMap())
                  .key(change.idempotencyKey)));
    }
  }
}
