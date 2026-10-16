/**
 * Text that came from someone else's program, made safe to print on a
 * terminal: log lines, labels, anything a customer's code wrote. Printed raw,
 * an escape sequence in it could clear or rewrite the screen, set the
 * clipboard (OSC 52), forge a link (OSC 8) or reorder what is read (Unicode
 * direction overrides). Each such character is shown as its \uXXXX escape
 * instead, so nothing is hidden and nothing acts. Tab stays; a newline inside
 * one value is escaped too, so a line on screen is always one value.
 *
 * Only for a terminal: a pipe or a file gets the bytes as they are.
 */
export function terminalSafe(text: string): string {
  return text.replace(UNSAFE, escaped);
}

/** As {@link terminalSafe}, for a stream of lines: its newlines stay. */
export function terminalSafeLines(text: string): string {
  return text.replace(UNSAFE_BUT_NEWLINE, escaped);
}

/**
 * Writes a log stream (a sandbox process's, an image build's, a job run's) to
 * `to`: escaped on a terminal, as written to a pipe or a file, or with `raw`.
 * Not for `exec` or an attached process, whose output is the customer's own
 * terminal session.
 */
export function logStream(
  to: { isTTY?: boolean; write(text: string): unknown },
  raw: boolean,
): (text: string) => void {
  return (text) => void to.write(to.isTTY && !raw ? terminalSafeLines(text) : text);
}

const escaped = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
// C0 but tab, DEL, C1, and the Unicode marks and overrides that reorder text.
const CONTROLS = String.raw`\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩`;
const UNSAFE = new RegExp(String.raw`[\n${CONTROLS}]`, "g");
const UNSAFE_BUT_NEWLINE = new RegExp(`[${CONTROLS}]`, "g");
