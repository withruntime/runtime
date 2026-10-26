package com.withruntime;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Map;

/**
 * A session of an agent: send it words, read its log as it is written, stop it, or wait for it to
 * end. Its methods are safe for concurrent use.
 *
 * <pre>{@code
 * AgentSession session = runtime.agents().start("helpdesk", "My invoice is wrong");
 * try (EventStream<AgentEvent> events = session.events()) {
 *   for (AgentEvent event : events) if (event.kind().equals("reply")) System.out.println(event.text());
 * }
 * }</pre>
 */
public final class AgentSession {
  /** How long the API holds a read of the log open for a new event. */
  static final int LONG_POLL_SECONDS = 30;

  private final Transport t;
  private final String id;
  private volatile AgentSessionInfo info;
  private final boolean joined;
  private final long seq;

  AgentSession(Transport transport, AgentSessionInfo info, boolean joined, long seq) {
    this.t = transport;
    this.id = info.id();
    this.info = info;
    this.joined = joined;
    this.seq = seq;
  }

  static String path(String id, String suffix) {
    return "/v1/agents/sessions/" + Transport.segment(id) + suffix;
  }

  /**
   * The first page of its direct children, the sessions its harness started (trigger spawn), newest
   * first. A page walks every one; {@code sessions().list(new ListAgentSessions().root(id))} reads
   * a whole tree.
   */
  public Page<AgentSessionInfo> children() {
    return new Agents.Sessions(t).list(new ListAgentSessions().parent(id));
  }

  public String id() {
    return id;
  }

  /** What the API last said about the session. {@link #refresh()} asks again. */
  public AgentSessionInfo info() {
    return info;
  }

  public String state() {
    return info.state();
  }

  /**
   * Whether the start joined the open session with the same key rather than making one; always
   * false for a session read with {@code sessions().get}.
   */
  public boolean joined() {
    return joined;
  }

  /** The seq of the start's words in the log; for a session read by id, its last seq then. */
  public long seq() {
    return seq;
  }

  /** Reads the session again. */
  public AgentSession refresh() {
    info = new AgentSessionInfo(t.object(new Transport.Call("GET", path(id, ""))));
    return this;
  }

  /** Sends words to the session and returns their seq. An ended session is a Conflict (session_ended). */
  public long send(String text) {
    return send(text, null);
  }

  /**
   * As {@link #send(String)}. Leave idempotencyKey null: the client makes one and keeps it across
   * its own retries, so a retried send is never two messages.
   */
  public long send(String text, String idempotencyKey) {
    JsonObject answer =
        new JsonObject(
            t.object(new Transport.Call("POST", path(id, "/messages")).body(Map.of("text", text)).key(idempotencyKey)));
    return answer.getLong("seq", 0);
  }

  /** The whole log, from its first event, as it is written; it ends when the session has. */
  public EventStream<AgentEvent> events() {
    return events(0);
  }

  /**
   * The log after seq {@code after}, in order, as it is written: each read waits up to 30 seconds
   * on the server for a new event. It ends once the session has ended and every event is read.
   * Close it to stop early.
   */
  public EventStream<AgentEvent> events(long after) {
    Transport.Cancellation cancellation = new Transport.Cancellation();
    return new EventStream<>() {
      private final ArrayDeque<AgentEvent> ready = new ArrayDeque<>();
      private long cursor = after;
      private boolean ended;
      private boolean drained;

      @Override
      AgentEvent pull() {
        while (ready.isEmpty()) {
          if (drained || isClosed()) return null;
          // Once a page says the session ended, the rest of the log is read at once: no wait.
          boolean draining = ended;
          JsonObject page;
          try {
            page = poll(cursor, draining ? 0 : LONG_POLL_SECONDS, cancellation);
          } catch (RuntimeCloudException failure) {
            if (isClosed()) return null;
            throw failure;
          }
          ready.addAll(page.getObjects("data", AgentEvent::new));
          if (page.getBoolean("ended")) ended = true;
          if (draining && ready.isEmpty()) drained = true;
        }
        AgentEvent event = ready.poll();
        cursor = event.seq();
        return event;
      }

      @Override
      public void close() {
        super.close();
        cancellation.cancel();
      }
    };
  }

  /** One read of the log: {@code {data, ended}}. */
  private JsonObject poll(long after, int waitSeconds, Transport.Cancellation cancellation) {
    // The server holds the read up to waitSeconds; the call's own deadline is longer than that.
    Duration room = Duration.ofSeconds(waitSeconds + 15L);
    Transport.Call call =
        new Transport.Call("GET", path(id, "/events"))
            .query("after", after)
            .query("wait", waitSeconds)
            .timeout(t.timeout.compareTo(room) >= 0 ? t.timeout : room);
    if (cancellation != null) call.cancellation(cancellation);
    return new JsonObject(JsonObject.map(t.poll(call)));
  }

  /** The first page of its trace, up to 200 spans: {@link #trace(long, int)}. */
  public AgentTrace trace() {
    return trace(0, 0);
  }

  /**
   * A page of its trace: every model turn and tool call its harness made, with timing, tokens and
   * cost at the provider's list price. It holds the whole session's totals and up to {@code
   * limit} spans after {@code after} (0: 200; 500 at most); read on with {@code after} set to
   * {@link AgentTrace#nextAfter()} until it is null.
   */
  public AgentTrace trace(long after, int limit) {
    return new AgentTrace(t.object(tracePage("json", after, limit)));
  }

  /** The first page of its trace as OpenTelemetry traces: {@link #traceOtlp(long, int)}. */
  public Map<String, Object> traceOtlp() {
    return traceOtlp(0, 0);
  }

  /**
   * A page of its trace as OpenTelemetry traces: OTLP/JSON (an ExportTraceServiceRequest) in the
   * GenAI semantic conventions, with "nextAfter" as {@link AgentTrace#nextAfter()}; POST it
   * without "nextAfter" to any collector's /v1/traces. The first page holds the session's root.
   */
  public Map<String, Object> traceOtlp(long after, int limit) {
    return t.object(tracePage("otlp", after, limit));
  }

  private Transport.Call tracePage(String format, long after, int limit) {
    Transport.Call call = new Transport.Call("GET", path(id, "/trace")).query("format", format).query("after", after);
    return limit > 0 ? call.query("limit", limit) : call;
  }

  /**
   * Asks the session to stop and returns it as the API answered; it does not wait. A running
   * session ends once its sandbox is gone.
   */
  public AgentSessionInfo stop() {
    info = new AgentSessionInfo(t.object(new Transport.Call("POST", path(id, "/stop")).body(Map.of())));
    return info;
  }

  /** Waits, with no deadline, until the session has ended, and returns it. */
  public AgentSessionInfo waitFor() {
    return waitFor(null);
  }

  /**
   * Waits until the session has ended (done, failed or stopped) and returns it; a failed session is
   * returned, not thrown. It reads the log's long poll to know when to look again, so it never
   * polls on a timer. Past timeout (null or zero is none) it throws {@link
   * RuntimeCloudException.Connection} with code timeout; the session goes on.
   */
  public AgentSessionInfo waitFor(Duration timeout) {
    boolean bounded = timeout != null && !timeout.isZero() && !timeout.isNegative();
    long deadline = bounded ? System.nanoTime() + timeout.toNanos() : 0;
    while (true) {
      refresh();
      AgentSessionInfo now = info;
      if (now.ended()) return now;
      long after = now.lastSeq();
      while (true) {
        int wait = LONG_POLL_SECONDS;
        if (bounded) {
          long left = deadline - System.nanoTime();
          if (left <= 0)
            throw new RuntimeCloudException.Connection(
                "Session " + id + " had not ended after " + timeout.toSeconds() + " s; it is " + now.state() + ".",
                "timeout",
                "Wait again, or stop it with stop().",
                null,
                null);
          wait = (int) Math.min(LONG_POLL_SECONDS, Math.max(1, Duration.ofNanos(left).toSeconds()));
        }
        JsonObject page = poll(after, wait, null);
        if (page.getBoolean("ended") || !page.getList("data").isEmpty()) break;
      }
    }
  }
}
