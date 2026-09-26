package com.withruntime;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.function.Function;

/**
 * One page of a list. {@link #next()} reads the one after it; iterating a page walks every item
 * on it and on every page after it.
 */
public final class Page<T> implements Iterable<T> {
  private final List<T> data;
  private final String nextCursor;
  private final Function<String, Page<T>> fetch;

  Page(List<T> data, String nextCursor, Function<String, Page<T>> fetch) {
    this.data = List.copyOf(data);
    this.nextCursor = nextCursor;
    this.fetch = fetch;
  }

  /** Reads one {data, nextCursor} page of a list call; cursor is null for the first. */
  static <T> Page<T> read(Transport transport, Transport.Call call, Function<java.util.Map<String, Object>, T> make, Function<String, Transport.Call> again) {
    JsonObject body = new JsonObject(transport.object(call));
    return new Page<>(body.getObjects("data", make), body.getString("nextCursor"), cursor -> read(transport, again.apply(cursor), make, again));
  }

  /** This page's items. */
  public List<T> data() {
    return data;
  }

  public boolean hasMore() {
    return nextCursor != null && !nextCursor.isEmpty();
  }

  public String nextCursor() {
    return nextCursor;
  }

  /** The following page, or null when there is none. */
  public Page<T> next() {
    return hasMore() ? fetch.apply(nextCursor) : null;
  }

  /** Every item on this page and every page after it, up to limit. */
  public List<T> toList(int limit) {
    List<T> out = new ArrayList<>();
    for (T item : this) {
      if (out.size() >= limit) break;
      out.add(item);
    }
    return out;
  }

  @Override
  public Iterator<T> iterator() {
    return new Iterator<>() {
      private Page<T> page = Page.this;
      private int at;

      @Override
      public boolean hasNext() {
        while (page != null && at >= page.data.size()) {
          page = page.next();
          at = 0;
        }
        return page != null;
      }

      @Override
      public T next() {
        if (!hasNext()) throw new NoSuchElementException();
        return page.data.get(at++);
      }
    };
  }
}
