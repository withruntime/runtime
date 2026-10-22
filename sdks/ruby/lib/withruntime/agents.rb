# frozen_string_literal: true

module WithRuntime
  # An agent: +id+, +name+, +version+ (one more on each update), +definition+,
  # +labels+, +created_at+, +updated_at+, and +warnings+, such as
  # "subscription_for_customers" for an agent that serves your customers on a
  # subscription login (an empty list when there are none).
  class Agent < Record
    def warnings = self["warnings"] || []
  end

  # One entry of a session's log: +seq+, +kind+ (input, answer, reply, ask,
  # status, result, error, note, or child: a child session's end, posted into
  # its parent's log), +actor+, +body+ and +created_at+. +text+ is its words,
  # +body.text+.
  class AgentEvent < Record
    def text = self["body"].is_a?(Hash) ? self["body"]["text"] : nil
  end

  # A session as the API answers it. Times are ISO 8601 strings.
  #
  # +id+, +agent_id+, +agent_version+, +key+, +trigger+ (api, slack, github,
  # schedule, webhook, or spawn: a child its parent's harness started),
  # +state+ (queued, running, waiting, done, failed or stopped), +reason+
  # (why it ended; among others "budget", "parent_ended", and "deleted" on a
  # deleted record), +result+, +sandbox_id+, +last_seq+, +labels+,
  # +created_at+, +started_at+, +ended_at+.
  #
  # Its tree: +parent_session_id+ (nil for a top session), +root_session_id+
  # (itself for a top session) and +depth+ (0 to 3). Its use: +cost+ (this
  # session's so far) and +tree_cost+ (it and every session under it), each
  # an AgentCost. Its storage: +history_bytes+ (its log, kept until the
  # session is deleted) and +attachment_bytes+ (its files and screenshots).
  # +stop_why+ is why a stop was asked ("stopped", "budget" or
  # "parent_ended") or nil, and +deleted_at+ is set once its history was
  # deleted (+sessions.delete+).
  class AgentSessionInfo < Record
    def cost = AgentCost.new(self["cost"])
    def tree_cost = AgentCost.new(self["treeCost"])
    def deleted? = !self["deletedAt"].nil?
  end

  # What a session, or its tree, has used: +dollars+, +vcpu_seconds+ and
  # +gib_seconds+ (0 when not given).
  class AgentCost < Record
    def dollars = self["dollars"] || 0
    def vcpu_seconds = self["vcpuSeconds"] || 0
    def gib_seconds = self["gibSeconds"] || 0
  end

  # +runtime.agents+: agents that run in their own sandbox per session, started
  # by your own app through the API, Slack, GitHub, a schedule or a webhook. A private
  # beta: an account outside it is refused +product_in_beta+
  # (PermissionDeniedError).
  #
  #   definition = runtime.agents.templates.definition("claude-code", use: "team")
  #   runtime.agents.create("reviewer", definition)
  #   session = runtime.agents.start("reviewer", "Review the open pull requests.")
  #   session.events.each { |event| puts event.text if event.kind == "reply" }
  #
  # A definition is a Hash, by snake_case keyword (+memory_mib:+) or by the
  # API's own key ("memoryMiB"): +command+ (required), +from+ ({ image: },
  # { snapshot: }, or { repo: "owner/name" }: a repository connected to
  # CI/CD, each session a copy of its warm snapshot, checked out at
  # /workspace/repo), +vcpu+ and +memory_mib+ (4 vCPU and 8 GiB unless set; a
  # definition from a snapshot takes neither, InvalidRequestError, since a
  # snapshot keeps its own size), +instructions+, +env+, +secrets+ (names of
  # egress secrets: model keys go here), +mcp+ ([{ name:, url: }]), +volumes+
  # ([{ volume:, path: }]), +idle_pause_seconds+, +max_session_seconds+,
  # +max_concurrent+, +max_session_dollars+ (more than 0, at most 10000, 5
  # unless set: the session and every session under it, the root's covering
  # its tree; a tree at it stops, reason "budget"), +max_day_dollars+ (more
  # than 0, at most 100000, 100 unless set: the agent's sessions started that
  # UTC day; an agent at it starts nothing new, +budget_reached+
  # (402), until the next day) and +template+ ("support" or
  # "team").
  class Agents < Product
    attr_reader :sessions, :triggers, :templates, :memory

    def initialize(transport)
      super
      @sessions = AgentSessions.new(transport)
      @triggers = AgentTriggers.new(transport)
      @templates = AgentTemplates.new
      @memory = AgentMemory.new(transport)
      # Approvals come later, here: agents.approvals.list / answer.
    end

    # Makes an agent at version 1. A name already used is a ConflictError
    # (name_taken); the names sessions, triggers, templates and approvals are
    # refused, since they are paths beside the agents.
    def create(name, definition, labels: nil, idempotency_key: nil)
      body = Fields.body(name: name, definition: AgentTemplates.plain(definition), labels: labels)
      Agent.new(@t.json("POST", "/v1/agents", body: body, key: idempotency_key))
    end

    # By id or by name.
    def get(agent) = Agent.new(@t.json("GET", "/v1/agents/#{seg(agent)}"))

    # The first page of agents, at most +limit+ a page; +each+ walks every page.
    def list(cursor: nil, limit: nil) = agents_page(cursor, limit)

    # Replaces the whole definition: a new version. Sessions already running
    # keep the version they started with.
    def update(agent, definition)
      body = { "definition" => Fields.convert(AgentTemplates.plain(definition)) }
      Agent.new(@t.json("PATCH", "/v1/agents/#{seg(agent)}", body: body))
    end

    # Deletes an agent: its triggers go and its open sessions are asked to stop.
    def delete(agent) = @t.json("DELETE", "/v1/agents/#{seg(agent)}") && nil

    # Starts a session with +input+, its first words. With +key:+, your own
    # name for the conversation (a Slack thread, a pull request, one of your
    # customers such as "customer:42"), words with the same key join the open
    # session instead of starting a second; +session.joined+ says so. An agent
    # at its day's budget is refused +budget_reached+ (402).
    def start(agent, input, key: nil, labels: nil, idempotency_key: nil)
      body = Fields.body(input: input, key: key, labels: labels)
      answer = @t.json("POST", "/v1/agents/#{seg(agent)}/sessions", body: body, key: idempotency_key)
      AgentSession.new(@t, answer["session"], joined: answer["joined"] == true, seq: answer["seq"])
    end

    private

    def agents_page(cursor, limit)
      body = @t.json("GET", "/v1/agents", query: { "cursor" => cursor, "limit" => limit })
      Page.new(body["data"].map { |item| Agent.new(item) }, body["nextCursor"]) { |after| agents_page(after, limit) }
    end
  end

  # +runtime.agents.sessions+: find sessions. A session is one piece of work
  # or one conversation; it has its own sandbox while it runs.
  class AgentSessions < Product
    # A session to follow, send to, stop or wait for.
    def get(id)
      info = @t.json("GET", "/v1/agents/sessions/#{seg(id)}")
      AgentSession.new(@t, info, joined: false, seq: info["lastSeq"])
    end

    # Deletes an ended session's history: its log, and every log under it in
    # its tree. Until then the history is kept, counted as storage. The
    # session is kept as a deleted record: +get+ still reads it, with
    # +deleted_at+ set, +reason+ "deleted", +key+ and +result+ cleared and its
    # cost kept (a delete never frees budget), and its log reads empty. An
    # open session or tree is refused +session_open+ (ConflictError): stop it
    # first.
    def delete(id) = @t.json("DELETE", "/v1/agents/sessions/#{seg(id)}") && nil

    # The first page of sessions, as AgentSessionInfo records; +each+ walks
    # every page. +agent+ is an id or a name; +state+ is queued, running,
    # waiting, done, failed or stopped; +parent+ (a session's id) lists its
    # direct children; +root+ (a top session's id) its whole tree, the root
    # included; +deleted: true+ includes deleted records, hidden otherwise; at
    # most +limit+ a page.
    def list(agent: nil, state: nil, parent: nil, root: nil, deleted: nil, cursor: nil, limit: nil)
      query = { "agent" => agent, "state" => state, "parent" => parent, "root" => root, "deleted" => deleted, "limit" => limit }
      sessions_page(query, cursor)
    end

    private

    def sessions_page(query, cursor)
      body = @t.json("GET", "/v1/agents/sessions", query: query.merge("cursor" => cursor))
      Page.new(body["data"].map { |item| AgentSessionInfo.new(item) }, body["nextCursor"]) { |after| sessions_page(query, after) }
    end
  end

  # A session of an agent. +info+ is its latest record, an AgentSessionInfo:
  # +state+ (queued, running, waiting, done, failed or stopped), +reason+,
  # +result+, +last_seq+, its tree (+parent_session_id+, +root_session_id+,
  # +depth+), its use (+cost+, +tree_cost+), its storage (+history_bytes+,
  # +attachment_bytes+), +stop_why+, +deleted_at+ and the rest; history is
  # kept until the session is deleted (+sessions.delete+). +joined+ is
  # whether +start+ joined an open session with the same key, and +seq+ the
  # number of the words it sent.
  class AgentSession
    ENDED = %w[done failed stopped].freeze
    # How long the API holds an events read open, and the margin past it a
    # read waits for its answer.
    POLL_SECONDS = 30
    POLL_MARGIN = 15

    attr_reader :info, :joined, :seq

    def initialize(transport, info, joined: false, seq: nil)
      @t = transport
      @info = AgentSessionInfo.new(info)
      @joined = joined
      @seq = seq
    end

    def id = @info["id"]
    def state = @info["state"]
    def joined? = @joined
    def ended? = ENDED.include?(state)

    # Reads the session again.
    def refresh(timeout: nil)
      @info = AgentSessionInfo.new(@t.json("GET", path, timeout: timeout))
      self
    end

    # The first page of its direct children, the sessions its harness started
    # (+trigger+ "spawn"), newest first; +each+ walks every page.
    # +sessions.list(root:)+ reads a whole tree.
    def children(cursor: nil, limit: nil) = AgentSessions.new(@t).list(parent: id, cursor: cursor, limit: limit)

    # Sends words into a running or waiting session and answers their seq.
    # The idempotency key, made here when not given, means a retried send is
    # never two messages. Named send_message, not send, so Ruby's own
    # Object#send stays as it is.
    def send_message(text, idempotency_key: nil)
      @t.json("POST", path("/messages"), body: { "text" => text }, key: idempotency_key)["seq"]
    end

    # The session's log after +after+ (0, the whole log), in order, each an
    # AgentEvent; without a block, an Enumerator. It waits for new events and
    # ends once the session has ended and its last event has been given.
    def events(after: 0, &block)
      return enum_for(:events, after: after) unless block

      wait = POLL_SECONDS
      loop do
        page = read_events(after, wait)
        data = page["data"] || []
        data.each do |item|
          event = AgentEvent.new(item)
          after = event.seq
          yield event
        end
        # Ended: read on at once, without waiting, until nothing is left.
        if page["ended"]
          return nil if wait.zero? && data.empty?

          wait = 0
        end
      end
    end

    # Asks the session to stop and keeps the answer. A running session ends
    # once its sandbox is deleted; this does not wait for that (+wait+ does).
    def stop
      @info = AgentSessionInfo.new(@t.json("POST", path("/stop"), body: {}))
    end

    # The session once it has ended (done, failed or stopped); a failed
    # session is returned, not raised. Waits on the server, with no polling.
    # +timeout+ in seconds (nil or 0: no deadline) raises a ConnectionError
    # with code "timeout" when it passes first.
    def wait(timeout: nil)
      deadline = timeout&.positive? ? now + timeout : nil
      loop do
        refresh(timeout: deadline && left(deadline))
        return @info if ended?

        loop do
          seconds = deadline ? [POLL_SECONDS, left(deadline).ceil].min : POLL_SECONDS
          page = read_events(@info["lastSeq"] || 0, seconds)
          break if page["ended"] || !(page["data"] || []).empty?

          left(deadline) if deadline
        end
      end
    end

    def inspect = "#<#{self.class.name} #{id} #{state}>"

    private

    def path(suffix = "") = "/v1/agents/sessions/#{Transport.segment(id)}#{suffix}"

    # One long poll: its own deadline past the API's hold, whatever the client's.
    def read_events(after, wait)
      @t.json("GET", path("/events"), query: { "after" => after, "wait" => wait }, timeout: [@t.timeout, wait + POLL_MARGIN].max)
    end

    def now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    def left(deadline)
      seconds = deadline - now
      raise @t.connection_error(true, false, nil) unless seconds.positive?

      seconds
    end
  end

  # +runtime.agents.triggers+: what starts or feeds an agent's sessions
  # besides the API. A trigger is +id+, +agent_id+, +kind+, +config+,
  # +paused_at+, +paused_why+ and +created_at+. The kinds and their configs:
  #
  #   slack     { team: "T…", channel: "C…" }, once Runtime's Slack app is installed
  #   github    { repository: "owner/name", installation: <Runtime's GitHub App
  #             installation id, the organization's own>, events: [...] (optional) }
  #   schedule  { cron: "0 9 * * 1-5", timezone: "America/Denver" (optional), input: "words" }
  #   webhook   {}
  #
  # A slack or github trigger whose app is not installed for the account is
  # refused +not_installed+ (ConflictError).
  class AgentTriggers < Product
    def create(agent, kind, config = {})
      Record.new(@t.json("POST", "/v1/agents/#{seg(agent)}/triggers", body: { "kind" => kind, "config" => Fields.convert(config.to_h) }))
    end

    def list(agent) = @t.json("GET", "/v1/agents/#{seg(agent)}/triggers")["data"].map { |row| Record.new(row) }

    # Holds this trigger alone; its events are refused +trigger_paused+, with
    # +why+, where they came from. Nothing else is held.
    def pause(id, why) = Record.new(@t.json("POST", "/v1/agents/triggers/#{seg(id)}/pause", body: { "why" => why }))

    def resume(id) = Record.new(@t.json("POST", "/v1/agents/triggers/#{seg(id)}/resume", body: {}))

    def delete(id) = @t.json("DELETE", "/v1/agents/triggers/#{seg(id)}") && nil
  end

  # A page of an agent's memory files; +usage+ is the agent's whole memory,
  # every scope: +bytes+, +files+, +limit_bytes+ and +limit_files+.
  class AgentMemoryPage < Page
    attr_reader :usage

    def initialize(data, next_cursor, usage, &fetch)
      super(data, next_cursor, &fetch)
      @usage = usage
    end
  end

  # +runtime.agents.memory+: an agent's built-in memory, text files its
  # sessions keep across sessions and search. A +scope+ is whose: "" (the
  # default) for what every session of the agent shares, or a session key such
  # as "customer:42" for that key's alone. Up to 1 MiB a file, 1 GiB and
  # 100,000 files an agent, billed as storage; past them a write is refused
  # +memory_full+ (ConflictError).
  #
  #   runtime.agents.memory.write("helpdesk", "faq/refunds.md", "Refunds within 30 days.")
  #   runtime.agents.memory.search("helpdesk", "refund").each { |hit| puts "#{hit.path}: #{hit.snippet}" }
  class AgentMemory < Product
    # The first page of an agent's files by scope and path, each with +scope+,
    # +path+, +bytes+, +updated_at+ and +updated_by+; every scope unless
    # +scope:+ is given. +each+ walks every page.
    def list(agent, scope: nil, prefix: nil, cursor: nil, limit: nil)
      memory_page(agent, { "scope" => scope, "prefix" => prefix, "limit" => limit }, cursor)
    end

    # The files whose words or path match +q+ (words, "a phrase", or, -not),
    # best first, each with a +snippet+ and +rank+; every scope unless
    # +scope:+ is given.
    def search(agent, q, scope: nil, limit: nil)
      body = @t.json("GET", "/v1/agents/#{seg(agent)}/memory", query: { "scope" => scope, "q" => q, "limit" => limit })
      body["data"].map { |row| Record.new(row) }
    end

    # A file with its +content+; none there is NotFoundError.
    def read(agent, path, scope: "")
      Record.new(@t.json("GET", file(agent), query: { "scope" => scope, "path" => path }))
    end

    # Seeds or replaces a file; +created+ says which.
    def write(agent, path, content, scope: "")
      Record.new(@t.json("PUT", file(agent), query: { "scope" => scope, "path" => path }, body: { "content" => content }))
    end

    # Deletes a file; whether there was one.
    def delete(agent, path, scope: "")
      @t.json("DELETE", file(agent), query: { "scope" => scope, "path" => path })["deleted"] == true
    end

    private

    def file(agent) = "/v1/agents/#{seg(agent)}/memory/content"

    def memory_page(agent, query, cursor)
      body = @t.json("GET", "/v1/agents/#{seg(agent)}/memory", query: query.merge("cursor" => cursor))
      AgentMemoryPage.new(body["data"].map { |item| Record.new(item) }, body["nextCursor"], Record.new(body["usage"] || {})) do |after|
        memory_page(agent, query, after)
      end
    end
  end

  # +runtime.agents.templates+: the five harnesses an agent can run, each
  # usable for either use, and the two uses.
  #
  #   runtime.agents.templates.map(&:key)   # claude-code, codex, gemini-cli, claude-agent-sdk, openai-agents-sdk
  #   runtime.agents.templates["codex"].api_key_secret
  #   runtime.agents.templates.uses["support"].session_key
  #   runtime.agents.templates.definition("claude-code", use: "support")
  #
  # A subscription is for your own team's agents. An agent that serves your
  # customers (api or webhook sessions for end users) uses an API key: those
  # are the providers' terms, and the API warns +subscription_for_customers+
  # on an agent that does not.
  class AgentTemplates
    include Enumerable

    # The same values as every Runtime SDK and the guide
    # (packages/cloud-guide/agent-templates.json).
    DATA = {
      "templates" => {
        "claude-code" => {
          "key" => "claude-code",
          "title" => "Claude Code",
          "command" => "npx -y @anthropic-ai/claude-code --dangerously-skip-permissions --mcp-config ~/.runtime-agent/mcp.json -p \"$(cat ~/.runtime-agent/start.md)\"",
          "apiKeySecret" => "ANTHROPIC_API_KEY",
          "apiKeyHost" => "api.anthropic.com",
          "subscription" => "token: run `claude setup-token` on your own computer (Pro/Max), then `runtime secrets set CLAUDE_CODE_OAUTH_TOKEN` scoped to api.anthropic.com",
          "definition" => {
            "command" => "npx -y @anthropic-ai/claude-code --dangerously-skip-permissions --mcp-config ~/.runtime-agent/mcp.json -p \"$(cat ~/.runtime-agent/start.md)\"",
            "secrets" => ["ANTHROPIC_API_KEY"]
          }
        },
        "codex" => {
          "key" => "codex",
          "title" => "Codex CLI",
          "command" => "npx -y @openai/codex exec --dangerously-bypass-approvals-and-sandbox \"$(cat ~/.runtime-agent/start.md)\"",
          "apiKeySecret" => "OPENAI_API_KEY",
          "apiKeyHost" => "api.openai.com",
          "subscription" => "login once in the sandbox's terminal: `npx -y @openai/codex login --device-auth`, kept in the snapshot or a volume at `~/.codex`",
          "definition" => {
            "command" => "npx -y @openai/codex exec --dangerously-bypass-approvals-and-sandbox \"$(cat ~/.runtime-agent/start.md)\"",
            "secrets" => ["OPENAI_API_KEY"]
          }
        },
        "gemini-cli" => {
          "key" => "gemini-cli",
          "title" => "Gemini CLI",
          "command" => "npx -y @google/gemini-cli --yolo -p \"$(cat ~/.runtime-agent/start.md)\"",
          "apiKeySecret" => "GEMINI_API_KEY",
          "apiKeyHost" => "generativelanguage.googleapis.com",
          "subscription" => "login once in the sandbox's terminal (Sign in with Google), kept at `~/.gemini`",
          "definition" => {
            "command" => "npx -y @google/gemini-cli --yolo -p \"$(cat ~/.runtime-agent/start.md)\"",
            "secrets" => ["GEMINI_API_KEY"]
          }
        },
        "claude-agent-sdk" => {
          "key" => "claude-agent-sdk",
          "title" => "Claude Agent SDK",
          "command" => "python3 ~/agent.py",
          "apiKeySecret" => "ANTHROPIC_API_KEY",
          "apiKeyHost" => "api.anthropic.com",
          "subscription" => nil,
          "definition" => {
            "command" => "python3 ~/agent.py",
            "secrets" => ["ANTHROPIC_API_KEY"]
          }
        },
        "openai-agents-sdk" => {
          "key" => "openai-agents-sdk",
          "title" => "OpenAI Agents SDK",
          "command" => "python3 ~/agent.py",
          "apiKeySecret" => "OPENAI_API_KEY",
          "apiKeyHost" => "api.openai.com",
          "subscription" => nil,
          "definition" => {
            "command" => "python3 ~/agent.py",
            "secrets" => ["OPENAI_API_KEY"]
          }
        }
      },
      "uses" => {
        "support" => {
          "key" => "support",
          "title" => "Your customers",
          "sessionKey" => "customer:<id>",
          "triggers" => %w[api webhook],
          "definition" => {
            "template" => "support",
            "vcpu" => 1,
            "memoryMiB" => 1024,
            "idlePauseSeconds" => 10,
            "maxConcurrent" => 1000
          }
        },
        "team" => {
          "key" => "team",
          "title" => "Your team",
          "sessionKey" => nil,
          "triggers" => %w[slack github],
          "definition" => {
            "template" => "team",
            "vcpu" => 4,
            "memoryMiB" => 8192
          }
        }
      }
    }.then { |data| JSON.parse(JSON.generate(data), freeze: true) }

    # A definition given as a Record (a template's own) as the Hash it holds.
    def self.plain(definition) = definition.is_a?(Record) ? definition.to_h : definition

    # The harness template +key+ (+key+, +title+, +command+, +api_key_secret+,
    # +api_key_host+, +subscription+: how to log in on one, or nil, and
    # +definition+), or nil.
    def [](key) = DATA["templates"][key.to_s]&.then { |template| Record.new(template) }

    def keys = DATA["templates"].keys

    # The harness templates, in order.
    def each(&block)
      return enum_for(:each) unless block

      DATA["templates"].each_value { |template| block.call(Record.new(template)) }
    end

    # The uses, "support" (your customers, driven by your own app: one session
    # per end customer under your own key such as "customer:42", paused between
    # their messages) and "team" (your team's
    # code, from Slack and GitHub): +key+, +title+, +session_key+, +triggers+
    # and the +definition+ preset merged over a template's.
    def uses = DATA["uses"].transform_values { |use| Record.new(use) }

    # A new definition: the template's, with the use's preset over it. Ready
    # for +agents.create(name, definition)+. An unknown key raises
    # InvalidRequestError before anything is sent.
    def definition(template, use: nil)
      found = DATA["templates"][template.to_s] or raise unknown("template", template, DATA["templates"].keys)
      out = JSON.parse(JSON.generate(found["definition"]))
      return out if use.nil?

      preset = DATA["uses"][use.to_s] or raise unknown("use", use, DATA["uses"].keys)
      out.merge(JSON.parse(JSON.generate(preset["definition"])))
    end

    # Every template and use as plain JSON data: { "templates" => ..., "uses" => ... }.
    def to_h = JSON.parse(JSON.generate(DATA))

    def inspect = "#<#{self.class.name} #{keys.join(", ")}; uses #{DATA["uses"].keys.join(", ")}>"

    private

    def unknown(what, value, known)
      InvalidRequestError.new("No agent #{what} is called #{value.inspect}.", code: "invalid_request", status: 400,
                                                                               hint: "One of: #{known.join(", ")}.")
    end
  end
end
