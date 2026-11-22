// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
// Same answers as vendor/csv-reader readCsv for every input, faster:
// the reference walks one character at a time building each field with
// `value += c`; this walks delimiter to delimiter with native indexOf and
// takes each field (or quoted segment) as one slice, so the per-character
// JS loop and rope concatenation disappear. All of the reference's broken-
// row policy is kept exactly: BOM drop, empty lines are no records, stray
// CR dropped (stray_cr), quoted fields with "" -> ", CRLF/lone CR inside
// quotes -> LF, junk after a closing quote appended (quote_junk), an
// unterminated quote read again as unquoted (unterminated_quote), quotes
// inside unquoted fields literal, fields never trimmed/converted, rows
// padded (short_row) or cut (long_row) to the first record's width, and
// errors {code, line, row} in the order met with line = 1-based line the
// record starts on (counting line breaks inside quotes) and row = the
// record's index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// One native scan for the next field delimiter (comma, LF or CR). A
// separate indexOf('\r') per field would overscan: with no CR in the
// field it keeps scanning past the field's end until the next CR anywhere
// in the text. The regex stops at the first delimiter of any kind.
const DELIM_RE = /[,\r\n]/g;

// A quoted segment with CRLF / lone CR / LF turned into LF, and how many
// line breaks it held (each CRLF, lone CR and LF counts once).
function fixSegment(seg) {
  if (seg.indexOf('\r') === -1) {
    if (seg.indexOf('\n') === -1) return [seg, 0];
    let b = 0;
    let i = -1;
    while ((i = seg.indexOf('\n', i + 1)) !== -1) b++;
    return [seg, b];
  }
  let b = 0;
  const t = seg.replace(/\r\n?|\n/g, () => {
    b++;
    return '\n';
  });
  return [t, b];
}

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;

    do {
      quoted = text.charCodeAt(pos) === 34;
      let value;
      let doUnquoted = false;
      let unqInit = '';
      let junkCheck = false;

      if (quoted) {
        const open = pos;
        const openLine = line;
        let acc = '';
        let segStart = pos + 1;
        let curLine = line;
        let closed = false;
        while (true) {
          const q = text.indexOf('"', segStart);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            const fixed = fixSegment(text.slice(segStart, q));
            acc += fixed[0];
            acc += '"';
            curLine += fixed[1];
            segStart = q + 2;
            continue;
          }
          const fixed = fixSegment(text.slice(segStart, q));
          acc += fixed[0];
          curLine += fixed[1];
          line = curLine;
          pos = q + 1;
          closed = true;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          doUnquoted = true;
          unqInit = '"';
        } else if (pos >= n) {
          value = acc;
          ended = END;
        } else {
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            value = acc;
            ended = COMMA;
          } else if (c === 10) {
            pos += 1;
            line += 1;
            value = acc;
            ended = LINE_BREAK;
          } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            value = acc;
            ended = LINE_BREAK;
          } else {
            // What follows the closing quote is appended as it stands,
            // up to the next comma or line break.
            doUnquoted = true;
            unqInit = acc;
            junkCheck = true;
          }
        }
      } else {
        doUnquoted = true;
        unqInit = '';
      }

      if (doUnquoted) {
        let acc2 = unqInit;
        let hasAcc = unqInit !== '';
        let start = pos;
        let added = 0;
        while (true) {
          DELIM_RE.lastIndex = start;
          const m = DELIM_RE.exec(text);
          let end = n;
          let kind = END;
          if (m !== null) {
            end = m.index;
            const dc = m[0];
            kind = dc === ',' ? COMMA : dc === '\n' ? LINE_BREAK : 3; // CR: CRLF ends the record, a lone CR is dropped
          }
          if (kind === 3) {
            if (text.charCodeAt(end + 1) === 10) {
              const seg = text.slice(start, end);
              added += seg.length;
              value = hasAcc ? acc2 + seg : seg;
              pos = end + 2;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            const seg = text.slice(start, end);
            added += seg.length;
            acc2 = hasAcc ? acc2 + seg : seg;
            hasAcc = true;
            start = end + 1;
            continue;
          }
          const seg = text.slice(start, end);
          added += seg.length;
          value = hasAcc ? acc2 + seg : seg;
          if (kind === COMMA) {
            pos = end + 1;
            ended = COMMA;
          } else if (kind === LINE_BREAK) {
            pos = end + 1;
            line += 1;
            ended = LINE_BREAK;
          } else {
            pos = n;
            ended = END;
          }
          break;
        }
        if (junkCheck && added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
