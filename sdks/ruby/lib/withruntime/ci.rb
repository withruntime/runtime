# frozen_string_literal: true

module WithRuntime
  # +runtime.ci+: CI/CD. A connected repository's checks run as jobs in
  # sandboxes. In a private beta: an account outside it is refused with
  # product_in_beta (403, PermissionDeniedError). Times are Unix milliseconds.
  #
  #   repo = runtime.ci.repositories.connect("acme/web")
  #   check = runtime.ci.checks.list(repository_id: repo.id, state: ["failed"]).first
  #   job = runtime.ci.checks.get(check.id).jobs.first
  #   puts runtime.ci.jobs.get(job.id).log
  class CI < Product
    attr_reader :repositories, :checks, :jobs, :tests, :flakes, :releases

    def initialize(transport)
      super
      @repositories = CIRepositories.new(transport)
      @checks = CIChecks.new(transport)
      @jobs = CIJobs.new(transport)
      @tests = CITests.new(transport)
      @flakes = CIFlakes.new(transport)
      @releases = CIReleases.new(transport)
    end
  end

  # +runtime.ci.repositories+: the repositories whose checks run.
  #
  # A repository: id, name, labels, repository (owner/name), production_branch,
  # config_path, installation, github_repository_id, undo_culprits (whether a
  # red production branch's culprit is undone: set_undo), state (connected or
  # disconnected), error, created_at, updated_at and deleted_at.
  class CIRepositories < Product
    # Connects +repository+ ("owner/name"), read through Runtime's GitHub App.
    # Pushes and pull requests then run the checks written in +config_path:+
    # (runtime.yml). Optional: production_branch (main), config_path,
    # installation (the GitHub App installation to read it through; the newest
    # when left out), name and labels.
    def connect(repository, production_branch: nil, config_path: nil, installation: nil, name: nil, labels: nil,
                idempotency_key: nil)
      body = Fields.body(repository: repository, production_branch: production_branch, config_path: config_path,
                         installation: installation, name: name, labels: labels)
      Record.new(@t.json("POST", "/v1/ci/repositories", body: body, key: idempotency_key))
    end

    # +label+ is "key:value" strings, +state+ connected or disconnected.
    def list(name: nil, label: nil, state: nil, limit: nil, cursor: nil)
      page("/v1/ci/repositories", { "name" => name, "label" => label, "state" => state, "limit" => limit, "cursor" => cursor })
    end

    # Turns on (or off) the undo of a red production branch's culprit: when
    # main's check fails, CI/CD finds the first commit that fails it and opens
    # a pull request reverting it, which lands once its own check passes. Off
    # until set; only an owner's or admin's full key sets it.
    def set_undo(id, on, idempotency_key: nil)
      Record.new(@t.json("POST", "/v1/ci/repositories/#{seg(id)}:update", body: { "undoCulprits" => on },
                                                                          key: idempotency_key))
    end

    # Stops running its checks; the checks already run stay readable.
    def disconnect(id, idempotency_key: nil)
      Record.new(@t.json("DELETE", "/v1/ci/repositories/#{seg(id)}", key: idempotency_key))
    end
  end

  # +runtime.ci.checks+: one run of a commit's jobs.
  #
  # A check: id, repository_id, repository, commit, branch, event, pull_request,
  # base_commit, actor, trusted, waiting, approved_by, approved_at, landed,
  # state (queued, running, passed, failed or cancelled), reason, counts (jobs
  # per state), machines (where its machines came from and how soon, or nil),
  # created_at, updated_at, started_at and ended_at.
  class CIChecks < Product
    # Checks, newest first. +state+ is any of queued, running, passed, failed,
    # cancelled; +commit+ is a full sha.
    def list(repository_id: nil, state: nil, branch: nil, commit: nil, pull_request: nil, limit: nil, cursor: nil)
      page("/v1/ci/checks", { "repositoryId" => repository_id, "state" => state, "branch" => branch, "commit" => commit,
                              "pullRequest" => pull_request, "limit" => limit, "cursor" => cursor })
    end

    # The check with its +jobs+ in plan order (no log).
    def get(id) = Record.new(@t.json("GET", "/v1/ci/checks/#{seg(id)}"))

    # Cancels a queued or running check: its jobs end and its machines are let
    # go. A check that has ended is answered as it is.
    def cancel(id) = Record.new(@t.json("POST", "/v1/ci/checks/#{seg(id)}:cancel"))
  end

  # +runtime.ci.jobs+: one command of a check, run in sandboxes.
  class CIJobs < Product
    # The job with its +log+ (the tail, at most 256 KiB). A failed job's
    # sandbox_ids may be kept paused: wake one or exec in it with
    # +runtime.sandboxes+. A review step's job has its +review+: the verdict
    # (pass or block), summary, findings (kind, file, line, what, fix), notes,
    # and the agent, account, model and session that gave it; nil otherwise.
    def get(id) = Record.new(@t.json("GET", "/v1/ci/jobs/#{seg(id)}"))
  end

  # +runtime.ci.tests+: a repository's test files and their recent runs.
  class CITests < Product
    # Test files by name: file, ms, quarantined_since (their failures do not
    # fail a check), runs and updated_at.
    def list(repository_id, quarantined: nil, limit: nil, cursor: nil)
      page("/v1/ci/tests", { "repositoryId" => repository_id, "quarantined" => quarantined, "limit" => limit, "cursor" => cursor })
    end
  end

  # +runtime.ci.flakes+: tests that passed and failed on the same inputs, one
  # run main's. Each is quarantined at once (it still runs and reports, and
  # blocks nothing), or still gating when the repository protects it; handed
  # to an owner with 48 hours to fix it or delete it with a reason; fixed once
  # 100 runs of a main commit in parallel forks all pass.
  #
  # A flake: id, repository_id, file, state (quarantined, gating, fixed or
  # deleted), gates, proof, again, owner (login, from, pull_request, branch),
  # since, due_at, overdue, tried, prove_asked_at, delete_reason, ended_at,
  # ended_check_id and updated_at; with a get or an update, its runs and
  # failures too.
  class CIFlakes < Product
    # Flaky tests, newest first. +state+ is any of quarantined, gating (the
    # open ones), fixed, deleted.
    def list(repository_id: nil, state: nil, limit: nil, cursor: nil)
      page("/v1/ci/flakes", { "repositoryId" => repository_id, "state" => state, "limit" => limit, "cursor" => cursor })
    end

    # The flake with its test file's newest 200 +runs+ (by commit and content
    # key) and its +failures+' jobs, whose logs +runtime.ci.jobs.get+ reads.
    def get(id) = Record.new(@t.json("GET", "/v1/ci/flakes/#{seg(id)}"))

    # +prove: true+ asks for its 100 proof runs at main's next commit; +owner:+
    # hands it to a GitHub login or org/team; +delete_reason:+ says why its
    # test is deleted (it ends once main no longer holds the file).
    def update(id, prove: nil, owner: nil, delete_reason: nil, idempotency_key: nil)
      body = Fields.body(prove: prove, owner: owner, delete_reason: delete_reason)
      Record.new(@t.json("POST", "/v1/ci/flakes/#{seg(id)}:update", body: body, key: idempotency_key))
    end
  end

  # +runtime.ci.releases+: the steps each release took, as it took them: a
  # migration's copy test or apply, a deploy ref moved, a server's canary or
  # release, the website's deploy or promote, or a wait and why. Only
  # repositories whose releases CI/CD runs have any.
  #
  # A step: id, repository_id, commit, source (mover, or the deploy target
  # that walked it), host (or nil), line and at.
  class CIReleases < Product
    # Steps, newest first; +commit:+ keeps one release's.
    def list(repository_id: nil, commit: nil, limit: nil, cursor: nil)
      page("/v1/ci/releases", { "repositoryId" => repository_id, "commit" => commit, "limit" => limit, "cursor" => cursor })
    end
  end
end
