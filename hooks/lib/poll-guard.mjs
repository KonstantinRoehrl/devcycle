// A guarded devcycle dispatch waiting on a capture in an until/while loop that sleeps can wait forever:
// #385's implementer polled for a marker line an earlier `&&` step's failure meant would never be
// written. The bounded forms are a foreground capture under the Bash tool's own timeout, or a
// background one whose completion notification ends the wait. A `for` loop is bounded by its list,
// and a loop that never sleeps is not a wait.
//
// One left-to-right pass, linear in the command's length (a hook must answer whatever it is fed): a
// word counts as a loop keyword or as `sleep` only in command position and unquoted, comments and
// heredoc bodies are skipped as data, and a `sleep` is a poll only inside an open until/while
// loop's own do…done body, nested loops tracked on a stack. Like the git guard beside it, this is a
// backstop for cooperative dispatches, not a shell parser: a heredoc a shell then runs, a function
// that hides the loop, or `case` patterns spelling keywords are left alone.

// Separators end a command, so the next word is in command position again.
const SEPARATORS = new Set([";", "&", "|", "(", ")", "`", "\n"]);
// Reserved words after which the next word is still in command position.
const LEADS_A_COMMAND = new Set(["while", "until", "do", "then", "else", "elif", "if", "!", "{", "time"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function isPollLoop(command) {
  const text = String(command);
  const length = text.length;
  const loops = []; // one frame per open loop: { polls: until/while, body: past its `do` }
  let pollingBodies = 0; // open until/while frames past their `do`
  let commandStart = true;
  let heredocs = []; // delimiters whose bodies start after the current line
  let heredocWantsDelimiter = null; // `<<` seen with its delimiter still to come as the next word
  let i = 0;

  const skipHeredocBodies = () => {
    for (const { delimiter, stripTabs } of heredocs) {
      while (i < length) {
        const end = text.indexOf("\n", i);
        const lineEnd = end === -1 ? length : end;
        let line = text.slice(i, lineEnd);
        if (stripTabs) line = line.replace(/^\t+/, "");
        i = lineEnd + 1;
        if (line === delimiter) break;
      }
    }
    heredocs = [];
  };

  const readWord = () => {
    let value = "";
    let bare = ""; // the word's unquoted characters: only an unquoted `<<` opens a heredoc
    let quoted = false;
    while (i < length) {
      const c = text[i];
      if (c === " " || c === "\t" || SEPARATORS.has(c)) break;
      if (c === "\\") {
        value += text[i + 1] ?? "";
        quoted = true;
        i += 2;
      } else if (c === "'") {
        const end = text.indexOf("'", i + 1);
        const stop = end === -1 ? length : end;
        value += text.slice(i + 1, stop);
        quoted = true;
        i = stop + 1;
      } else if (c === '"') {
        let j = i + 1;
        while (j < length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
        value += text.slice(i + 1, Math.min(j, length));
        quoted = true;
        i = j + 1;
      } else {
        value += c;
        bare += c;
        i += 1;
      }
    }
    return { value, bare, quoted };
  };

  const noteHeredoc = (word, bare) => {
    const at = word.indexOf("<<");
    if (!bare.includes("<<") || word[at + 2] === "<") return;
    const stripTabs = word[at + 2] === "-";
    const delimiter = word.slice(at + (stripTabs ? 3 : 2));
    if (delimiter) heredocs.push({ delimiter, stripTabs });
    else heredocWantsDelimiter = { stripTabs };
  };

  while (i < length) {
    const c = text[i];
    if (c === " " || c === "\t") { i += 1; continue; }
    if (c === "\\" && text[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n") { i += 1; skipHeredocBodies(); commandStart = true; continue; }
    if (SEPARATORS.has(c)) { i += 1; commandStart = true; continue; }
    if (c === "#") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? length : end;
      continue;
    }

    const { value, bare, quoted } = readWord();
    if (heredocWantsDelimiter) {
      heredocs.push({ delimiter: value, ...heredocWantsDelimiter });
      heredocWantsDelimiter = null;
      continue;
    }
    noteHeredoc(value, bare);
    if (!commandStart || quoted) { commandStart = false; continue; }

    if (value === "while" || value === "until") loops.push({ polls: true, body: false });
    else if (value === "for" || value === "select") loops.push({ polls: false, body: false });
    else if (value === "do") {
      const loop = loops.at(-1);
      if (loop && !loop.body) {
        loop.body = true;
        if (loop.polls) pollingBodies += 1;
      }
    } else if (value === "done") {
      const loop = loops.pop();
      if (loop?.polls && loop.body) pollingBodies -= 1;
    } else if (value === "sleep" && pollingBodies > 0) return true;

    commandStart = LEADS_A_COMMAND.has(value) || ASSIGNMENT.test(value);
  }
  return false;
}

export const POLL_DENY_TAIL =
  "poll in an until/while loop that sleeps — run a capture in the foreground with the Bash tool's timeout: 600000, " +
  "or in the background and wait for its completion notification; never poll an evidence file";
