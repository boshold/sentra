const ESC = 0x1b;
const BEL = 0x07;

function isFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/** End index (exclusive) of the escape sequence starting at `start` (an ESC). */
function escapeEnd(text: string, start: number): number {
  const kind = text.charCodeAt(start + 1);
  if (kind === 0x5b) {
    // CSI: ESC [ params final
    let index = start + 2;
    while (index < text.length && !isFinalByte(text.charCodeAt(index))) {
      index += 1;
    }
    return index + 1;
  }
  if (kind === 0x5d) {
    // OSC: ESC ] ... (BEL | ESC \)
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === BEL) {
        return index + 1;
      }
      if (code === ESC && text.charCodeAt(index + 1) === 0x5c) {
        return index + 2;
      }
      index += 1;
    }
    return index;
  }
  return start + 2;
}

function isDroppedControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
}

/** Drops ANSI escape sequences and control characters except tab and newline; `\r\n` → `\n`. */
function sanitizeText(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === ESC) {
      index = escapeEnd(text, index);
      continue;
    }
    if (code === 0x0d) {
      result += text.charCodeAt(index + 1) === 0x0a ? "" : "\n";
    } else if (!isDroppedControl(code)) {
      result += text[index];
    }
    index += 1;
  }
  return result;
}

/** Sanitized first line. */
function firstLine(text: string): string {
  const clean = sanitizeText(text);
  const end = clean.indexOf("\n");
  return end === -1 ? clean : clean.slice(0, end);
}

/** Markdown code fence longer than any backtick run in `lines`. */
function fenceFor(lines: string[]): string {
  const runs = lines.flatMap((line) => line.match(/`+/g) ?? []);
  return "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
}

export { fenceFor, firstLine, sanitizeText };
