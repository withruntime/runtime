package com.withruntime;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small JSON reader and writer (RFC 8259), so the SDK needs no dependency.
 *
 * <p>Objects read as {@code Map<String, Object>} in document order, arrays as {@code List<Object>},
 * whole numbers as {@code Long} (or {@code BigInteger} past 64 bits), other numbers as {@code
 * Double}, and {@code null} as {@code null}. Writing takes the same types, any {@code Number},
 * {@code Boolean}, a {@link JsonObject} and arrays.
 */
public final class Json {
  private Json() {}

  /** Reads one JSON value. Throws IllegalArgumentException on malformed input. */
  public static Object parse(String text) {
    Reader reader = new Reader(text);
    reader.space();
    Object value = reader.value(0);
    reader.space();
    if (reader.at < text.length()) throw reader.fail("trailing characters");
    return value;
  }

  /** Writes a value as compact JSON. */
  public static String write(Object value) {
    StringBuilder out = new StringBuilder();
    write(value, out);
    return out.toString();
  }

  @SuppressWarnings("unchecked")
  static void write(Object value, StringBuilder out) {
    if (value == null) {
      out.append("null");
    } else if (value instanceof JsonObject object) {
      write(object.raw(), out);
    } else if (value instanceof String text) {
      quote(text, out);
    } else if (value instanceof Boolean) {
      out.append(value);
    } else if (value instanceof Double number) {
      if (number.isNaN() || number.isInfinite())
        throw new IllegalArgumentException("JSON has no NaN or Infinity");
      if (number == Math.rint(number) && Math.abs(number) < 1e15) out.append(number.longValue());
      else out.append(number);
    } else if (value instanceof Float number) {
      write(number.doubleValue(), out);
    } else if (value instanceof BigDecimal number) {
      out.append(number.toPlainString());
    } else if (value instanceof Number) {
      out.append(value);
    } else if (value instanceof Map<?, ?> map) {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        if (!first) out.append(',');
        first = false;
        quote(String.valueOf(entry.getKey()), out);
        out.append(':');
        write(entry.getValue(), out);
      }
      out.append('}');
    } else if (value instanceof Collection<?> list) {
      out.append('[');
      boolean first = true;
      for (Object item : list) {
        if (!first) out.append(',');
        first = false;
        write(item, out);
      }
      out.append(']');
    } else if (value instanceof Object[] array) {
      write(List.of(array), out);
    } else if (value instanceof int[] array) {
      List<Object> list = new ArrayList<>();
      for (int item : array) list.add(item);
      write(list, out);
    } else if (value instanceof Enum<?> constant) {
      quote(constant.name(), out);
    } else {
      throw new IllegalArgumentException("Cannot write " + value.getClass().getName() + " as JSON");
    }
  }

  private static void quote(String text, StringBuilder out) {
    out.append('"');
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        default -> {
          if (c < 0x20 || c == 0x2028 || c == 0x2029) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    out.append('"');
  }

  private static final class Reader {
    private final String text;
    private int at;

    Reader(String text) {
      this.text = text;
    }

    IllegalArgumentException fail(String what) {
      return new IllegalArgumentException("Malformed JSON at " + at + ": " + what);
    }

    void space() {
      while (at < text.length()) {
        char c = text.charAt(at);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') at++;
        else break;
      }
    }

    Object value(int depth) {
      if (depth > 512) throw fail("nested too deeply");
      if (at >= text.length()) throw fail("unexpected end");
      char c = text.charAt(at);
      switch (c) {
        case '{':
          return object(depth);
        case '[':
          return array(depth);
        case '"':
          return string();
        case 't':
          return literal("true", Boolean.TRUE);
        case 'f':
          return literal("false", Boolean.FALSE);
        case 'n':
          return literal("null", null);
        default:
          if (c == '-' || (c >= '0' && c <= '9')) return number();
          throw fail("unexpected '" + c + "'");
      }
    }

    Object literal(String word, Object value) {
      if (!text.startsWith(word, at)) throw fail("expected " + word);
      at += word.length();
      return value;
    }

    Map<String, Object> object(int depth) {
      Map<String, Object> map = new LinkedHashMap<>();
      at++;
      space();
      if (at < text.length() && text.charAt(at) == '}') {
        at++;
        return map;
      }
      while (true) {
        space();
        if (at >= text.length() || text.charAt(at) != '"') throw fail("expected a key");
        String key = string();
        space();
        if (at >= text.length() || text.charAt(at) != ':') throw fail("expected ':'");
        at++;
        space();
        map.put(key, value(depth + 1));
        space();
        if (at >= text.length()) throw fail("unexpected end");
        char c = text.charAt(at++);
        if (c == '}') return map;
        if (c != ',') throw fail("expected ',' or '}'");
      }
    }

    List<Object> array(int depth) {
      List<Object> list = new ArrayList<>();
      at++;
      space();
      if (at < text.length() && text.charAt(at) == ']') {
        at++;
        return list;
      }
      while (true) {
        space();
        list.add(value(depth + 1));
        space();
        if (at >= text.length()) throw fail("unexpected end");
        char c = text.charAt(at++);
        if (c == ']') return list;
        if (c != ',') throw fail("expected ',' or ']'");
      }
    }

    String string() {
      at++;
      StringBuilder out = new StringBuilder();
      while (true) {
        if (at >= text.length()) throw fail("unterminated string");
        char c = text.charAt(at++);
        if (c == '"') return out.toString();
        if (c < 0x20) throw fail("control character in a string");
        if (c != '\\') {
          out.append(c);
          continue;
        }
        if (at >= text.length()) throw fail("unterminated escape");
        char e = text.charAt(at++);
        switch (e) {
          case '"' -> out.append('"');
          case '\\' -> out.append('\\');
          case '/' -> out.append('/');
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'n' -> out.append('\n');
          case 'r' -> out.append('\r');
          case 't' -> out.append('\t');
          case 'u' -> {
            if (at + 4 > text.length()) throw fail("short \\u escape");
            try {
              out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
            } catch (NumberFormatException error) {
              throw fail("bad \\u escape");
            }
            at += 4;
          }
          default -> throw fail("bad escape");
        }
      }
    }

    Object number() {
      int start = at;
      if (text.charAt(at) == '-') at++;
      if (at >= text.length()) throw fail("bad number");
      if (text.charAt(at) == '0') at++;
      else if (text.charAt(at) >= '1' && text.charAt(at) <= '9') digits();
      else throw fail("bad number");
      boolean whole = true;
      if (at < text.length() && text.charAt(at) == '.') {
        whole = false;
        at++;
        if (digits() == 0) throw fail("bad fraction");
      }
      if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
        whole = false;
        at++;
        if (at < text.length() && (text.charAt(at) == '+' || text.charAt(at) == '-')) at++;
        if (digits() == 0) throw fail("bad exponent");
      }
      String literal = text.substring(start, at);
      if (!whole) return Double.parseDouble(literal);
      BigInteger big = new BigInteger(literal);
      return big.bitLength() < 64 ? (Object) big.longValue() : big;
    }

    int digits() {
      int start = at;
      while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
      return at - start;
    }
  }
}
