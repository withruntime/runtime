package com.withruntime;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.function.BiFunction;
import java.util.function.Function;
import java.util.function.LongFunction;

/**
 * Events of a stream as they arrive. Iterate it once; close it (try-with-resources) to stop reading
 * early. It closes itself at the end.
 */
public class EventStream<T> implements Iterator<T>, Iterable<T>, AutoCloseable {
  private T next;
  private volatile boolean done;

  EventStream() {}

  final boolean isClosed() {
    return done;
  }

  /** The next event, or null at the end. */
  T pull() {
    return null;
  }

  @Override
  public final boolean hasNext() {
    if (next != null) return true;
    if (done) return false;
    try {
      next = pull();
    } catch (RuntimeException error) {
      close();
      throw error;
    }
    if (next == null) close();
    return next != null;
  }

  @Override
  public final T next() {
    if (!hasNext()) throw new NoSuchElementException();
    T value = next;
    next = null;
    return value;
  }

  @Override
  public final Iterator<T> iterator() {
    return this;
  }

  @Override
  public void close() {
    done = true;
  }

  /** Newline-delimited JSON from a response body. */
  static <T> EventStream<T> ndjson(
      InputStream body, Function<Map<String, Object>, T> make, Transport transport) {
    BufferedReader reader = new BufferedReader(new InputStreamReader(body, StandardCharsets.UTF_8));
    return new EventStream<>() {
      @Override
      T pull() {
        try {
          for (String line = reader.readLine(); line != null; line = reader.readLine())
            if (!line.isBlank()) return make.apply(JsonObject.map(Json.parse(line)));
          return null;
        } catch (IOException error) {
          throw transport.connectionError(false, false, null, error);
        } catch (IllegalArgumentException error) {
          throw new RuntimeCloudException(
              "Unexpected stream line: " + error.getMessage(), "unexpected_answer", null);
        }
      }

      @Override
      public void close() {
        super.close();
        try {
          // Close the underlying response first: BufferedReader.close waits
          // for a blocked readLine to release its monitor.
          body.close();
          reader.close();
        } catch (IOException ignored) {
          // Closing a finished stream cannot fail in a way that matters.
        }
      }
    };
  }

  static RuntimeCloudException streamError(JsonObject event) {
    JsonObject error = event.getObject("error");
    String code = error.getString("code");
    String message = error.getString("message");
    return new RuntimeCloudException(
        message == null ? "The output stream failed." : message,
        code == null ? "stream_failed" : code,
        0,
        null,
        error.getString("requestId"),
        null,
        null,
        null,
        null);
  }

  /** A command's stream: when the server hands it over with "continue", follow the process. */
  static EventStream<OutputEvent> following(
      EventStream<OutputEvent> first, BiFunction<String, Long, EventStream<OutputEvent>> follow) {
    return new EventStream<>() {
      volatile EventStream<OutputEvent> current = first;

      @Override
      OutputEvent pull() {
        if (isClosed() || !current.hasNext()) return null;
        OutputEvent event = current.next();
        if ("continue".equals(event.type())) {
          current.close();
          current = follow.apply(event.processId(), event.cursor());
          if (isClosed()) {
            current.close();
            return null;
          }
          return current.hasNext() ? current.next() : null;
        }
        if ("error".equals(event.type())) throw streamError(event);
        return event;
      }

      @Override
      public void close() {
        super.close();
        current.close();
      }
    };
  }

  /** A process's output from a cursor, reopened at each "continue", until it exits. */
  static EventStream<OutputEvent> resuming(
      long cursor, LongFunction<EventStream<OutputEvent>> open) {
    return new EventStream<>() {
      long at = cursor;
      volatile EventStream<OutputEvent> current = open.apply(cursor);
      boolean exited;

      @Override
      OutputEvent pull() {
        while (!exited && !isClosed()) {
          if (!current.hasNext()) return null;
          OutputEvent event = current.next();
          switch (event.type()) {
            case "continue" -> {
              at = event.cursor();
              current.close();
              current = open.apply(at);
              if (isClosed()) {
                current.close();
                return null;
              }
              continue;
            }
            case "stdout", "stderr" ->
                at = event.offset() + event.data().getBytes(StandardCharsets.UTF_8).length;
            case "error" -> throw streamError(event);
            case "exit" -> exited = true;
            default -> {}
          }
          return event;
        }
        return null;
      }

      @Override
      public void close() {
        super.close();
        current.close();
      }
    };
  }
}
