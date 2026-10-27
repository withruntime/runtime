# frozen_string_literal: true

module WithRuntime
  # +runtime.browsers+: a task in plain words, done by an agent that browses
  # in a sandbox with Chromium, at /v1/browsers/runs. In a private beta: an
  # account outside it is refused with product_in_beta (403,
  # PermissionDeniedError).
  #
  #   run = runtime.browsers.run("Find the price of the cheapest plan on withruntime.com")
  #   puts run.output || run.error
  #   runtime.browsers.runs.follow(run.id) { |step| puts "#{step.n} #{step.url}" }
  #
  # The model's key is your egress secret: ANTHROPIC_API_KEY for claude-
  # models (the default, claude-sonnet-5-5), OPENAI_API_KEY for gpt- and
  # o-series, GEMINI_API_KEY for gemini-. A run is billed as its sandbox's
  # time, at the sandbox rates; the model's use is on your key.
  #
  # A run: id, state (queued, running, done, failed or stopped), task, model,
  # start_url, output (the answer, once done), error (why it failed, and what
  # to do), steps, url (the page it ended on), sandbox_id, labels,
  # created_at, started_at and ended_at. A step: n (0 is the page before the
  # first step; the last, the page at the end), url, title, goal, actions,
  # frame (the page as a base64 JPEG), at and seq.
  class Browsers < Product
    attr_reader :runs

    def initialize(transport)
      super
      @runs = BrowserRuns.new(transport)
    end

    # Does +task+ in a browser and returns the run once it has ended: +output+
    # once done, +error+ once failed. Also +start_url:+, +model:+,
    # +max_steps:+, +allowed_domains:+ and +labels:+.
    def run(task, **fields)
      @runs.wait(@runs.create(task, **fields).id)
    end
  end

  # +runtime.browsers.runs+: start, read, follow and stop runs.
  class BrowserRuns < Product
    ENDED = %w[done failed stopped].freeze
    # How long the API holds a steps read open, and the margin past it a
    # read waits for its answer.
    POLL_SECONDS = 30
    POLL_MARGIN = 15

    # Starts a run and returns it at once (state queued). +start_url:+ is
    # opened before the first step; +max_steps:+ is 1 to 200 (30 unless
    # set); +allowed_domains:+ limits the pages it opens.
    def create(task, start_url: nil, model: nil, max_steps: nil, allowed_domains: nil, labels: nil, idempotency_key: nil)
      body = Fields.body(task: task, start_url: start_url, model: model, max_steps: max_steps,
                         allowed_domains: allowed_domains, labels: labels)
      Record.new(@t.json("POST", "/v1/browsers/runs", body: body, key: idempotency_key))
    end

    def get(id) = Record.new(@t.json("GET", path(id)))

    # The first page of runs, newest first; +each+ walks every page.
    def list(cursor: nil, limit: nil)
      body = @t.json("GET", "/v1/browsers/runs", query: { "cursor" => cursor, "limit" => limit })
      Page.new(body["data"].map { |item| Record.new(item) }, body["nextCursor"]) { |after| list(cursor: after, limit: limit) }
    end

    # One page of its steps after seq +after+: {data, after, ended}. +wait:+
    # (seconds, up to 30) holds the answer on the server for a step.
    def steps(id, after: 0, limit: nil, frames: nil, wait: nil)
      query = { "after" => after, "limit" => limit, "frames" => frames, "wait" => wait }
      timeout = wait ? [@t.timeout, wait + POLL_MARGIN].max : nil
      @t.json("GET", path(id, "/steps"), query: query, timeout: timeout)
    end

    # Each step as it comes, until the run ends: its recording. Without a
    # block, an Enumerator. Each read waits on the server, not a timer.
    def follow(id, after: 0, frames: true, &block)
      return enum_for(:follow, id, after: after, frames: frames) unless block

      loop do
        page = steps(id, after: after, frames: frames ? nil : false, wait: POLL_SECONDS)
        data = page["data"] || []
        data.each { |step| yield Record.new(step) }
        after = page["after"] || after
        return nil if page["ended"] && data.empty?
      end
    end

    # Stops it; its sandbox is deleted and its steps are kept.
    def stop(id) = Record.new(@t.json("POST", path(id, ":stop"), body: {}))

    # The run once it has ended (done, failed or stopped); a failed run is
    # returned, not raised: read +error+.
    def wait(id)
      run = get(id)
      return run if ENDED.include?(run.state)

      follow(id, frames: false) { |_step| nil }
      get(id)
    end

    private

    def path(id, suffix = "") = "/v1/browsers/runs/#{seg(id)}#{suffix}"
  end
end
