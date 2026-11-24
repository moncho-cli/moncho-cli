/**
 * The headless one-shot: `--exec <file>`, `--prompt <text>`, `--turns <n>` and
 * `--mode <name>` (docs/runtime/run-flags).
 *
 * The agent has always had two ways to run: a pty, which gets the TUI, and no pty, which
 * gets the line CLI. Both end up *asking* for a prompt, and both end when the user types
 * `exit` — so neither can be driven by another program. That is a real gap: anything that
 * wants to give the agent one task, let it work unattended and read what it changed has
 * had to fake a terminal, and faking a terminal is how a harness starts measuring its own
 * plumbing instead of the agent.
 *
 * `--exec <file>` closes it. The prompt is the file's whole contents, verbatim — not split
 * into lines and not trimmed into a shell argument, because a task is prose and the
 * newlines in it are part of the task. With `--exec` there is no question left to ask, so
 * the process runs its turn and leaves.
 *
 * The prompt has three sources, and they are the same thing arriving three ways:
 *
 *   --exec task.md      a file's bytes
 *   --exec -            whatever was piped to stdin (`moncho-cli run --exec - < task.md`)
 *   --prompt "do it"    one argument, verbatim
 *
 * Stdin is spelled `--exec -` rather than a fourth top-level rule because in the line CLI
 * stdin is also the *keyboard*: a process that reads a prompt from it is a process that
 * cannot also ask a question, and `--exec` already means exactly that. `--prompt` exists
 * for the case a shell makes easy and a file makes awkward — one line of prose — and it is
 * never trimmed, so a multi-line argument survives as it was written.
 *
 * Pure and terminal-free: the argv array is passed in, nothing is read from disk here, and
 * the answer is a plain object. That is what lets the contract be tested without a pty, a
 * provider or a sandbox.
 *
 * @see docs/runtime/run-flags
 */

/** The flag names, so a typo in one place cannot become a silently ignored argument. */
export const EXEC_FLAG = '--exec';
export const PROMPT_FLAG = '--prompt';
export const TURNS_FLAG = '--turns';
export const MODE_FLAG = '--mode';

/** The `--exec` value that means "the prompt is what was piped to stdin". */
export const STDIN_PATH = '-';

/** Does this argument look like a flag rather than a value? */
function looksLikeFlag(value) {
  return typeof value === 'string' && value.startsWith('--');
}

/**
 * Parse the run flags out of an `argv` tail.
 *
 * Deliberately strict, and the strictness is the point: an argument that is *ignored* is
 * an argument the caller believed was in force. A caller who typed `--turn 5` has asked
 * for a bounded run and would otherwise get an unbounded one; a caller who typed `--exec`
 * with nothing after it has asked for a prompt and would otherwise get the keyboard. A
 * benchmark that ran the wrong budget and reported a number would be worse than one that
 * refused to start, because nothing in the number would show the mistake.
 *
 * A flag never swallows another flag as its value. `--exec --turns 3` reports a missing
 * path for `--exec` *and* a valid `--turns`, which is the two facts a caller needs. An
 * empty argument, by contrast, was offered as this flag's value, so it is consumed and
 * refused on its own terms rather than being re-read as a stray argument.
 *
 * @param {string[]} argv the arguments after the script name
 * @returns {{exec: string|null, prompt: string|null, turns: number|null, mode: string|null, errors: string[]}}
 */
export function parseRunFlags(argv = []) {
  const list = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
  const errors = [];
  let exec = null;
  let prompt = null;
  let turns = null;
  let mode = null;

  /**
   * The value offered to the flag at `index`.
   *
   * `inline` is what followed an `=` in the same argument; otherwise the next argument is
   * taken — but only when it does not itself look like a flag, since a flag belongs to
   * itself. Reported as `null` when there is nothing to take.
   */
  const valueFor = (name, inline, index) => {
    // An empty value is reported as nothing to take, whether it arrived attached
    // (`--exec=`) or as its own argument (`--exec ''`). Accepting it would hand the run an
    // empty path, and the failure would then surface as a filesystem error a long way from
    // the argument that caused it.
    if (inline !== null) return { value: inline === '' ? null : inline, consumed: index };
    const next = list[index + 1];
    if (next === undefined || next === '' || looksLikeFlag(next)) {
      // A following flag belongs to itself and is not consumed; an empty argument was
      // offered as this flag's value, so it is consumed and refused on its own terms.
      return { value: null, consumed: next === '' ? index + 1 : index };
    }
    return { value: next, consumed: index + 1 };
  };

  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];

    const flag = [EXEC_FLAG, PROMPT_FLAG, TURNS_FLAG, MODE_FLAG]
      .find((name) => arg === name || arg.startsWith(`${name}=`));

    if (!flag) {
      errors.push(`unknown argument "${arg}"`);
      continue;
    }

    const inline = arg === flag ? null : arg.slice(flag.length + 1);
    const { value, consumed } = valueFor(flag, inline, index);
    index = consumed;

    if (value === null) {
      const needed = flag === TURNS_FLAG
        ? 'a positive whole number of turns'
        : flag === MODE_FLAG
          ? 'a mode name'
          : flag === PROMPT_FLAG ? 'the prompt text' : 'a path to a file holding the prompt';
      errors.push(`${flag} needs ${needed}`);
      continue;
    }

    if (flag === TURNS_FLAG) {
      if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
        errors.push(`${TURNS_FLAG} must be a positive whole number (got "${value}")`);
        continue;
      }
      turns = Number(value);
      continue;
    }

    if (flag === MODE_FLAG) {
      // The name itself is not validated here: an unknown mode resolves the way an
      // unknown mode always does (app/session-mode.js#normalizeMode), rather than
      // becoming a new failure mode invented by the flag parser.
      mode = value;
      continue;
    }

    if (flag === PROMPT_FLAG) {
      prompt = value;
      continue;
    }

    exec = value;
  }

  // Two prompt sources in one run is a contradiction, not a precedence question: the run
  // has one turn and one prompt, so there is no rule that could pick between them. Reported
  // rather than resolved, because either resolution would silently discard what the caller
  // believed was in force.
  if (exec !== null && prompt !== null) {
    errors.push(`${EXEC_FLAG} and ${PROMPT_FLAG} both name a prompt; give one`);
  }

  return { exec, prompt, turns, mode, errors };
}

/**
 * Is this process running headlessly?
 *
 * True when a prompt was named, or when a turn budget was given. A turn budget on its own
 * is meaningful: `--turns 3` with a terminal attached is a session that stops by itself
 * after three turns, which is what a scripted demonstration wants.
 *
 * @param {{exec: string|null, prompt: string|null, turns: number|null}} flags
 */
export function isHeadless(flags = {}) {
  return Boolean(flags.exec) || Boolean(flags.prompt)
    || (typeof flags.turns === 'number' && flags.turns > 0);
}

/**
 * The turns one process may take, or `0` for "no bound".
 *
 * `--exec` supplies exactly one prompt and a file is not a queue: re-reading it would
 * repeat the same task rather than continue it. So a named prompt bounds the process to
 * one turn whatever `--turns` says, and the two do not conflict — `--turns` is what bounds
 * an *interactive* run.
 *
 * @param {{exec: string|null, prompt: string|null, turns: number|null}} flags
 * @returns {number} 0 means unbounded
 */
export function turnBudget(flags = {}) {
  if (flags.exec || flags.prompt) return 1;
  return typeof flags.turns === 'number' && flags.turns > 0 ? flags.turns : 0;
}

/**
 * A source that answers once, then reports "nothing more to run".
 *
 * This is the whole rule, and every prompt source is a caller of it: read on the *first*
 * call, never at construction, so an unreadable or empty source surfaces when the run starts
 * — where the message can say what was being attempted — rather than during argument parsing
 * or in the wiring. The text is returned **verbatim**; trimming it here would be this module
 * editing the user's task.
 *
 * **Synchronous on purpose.** `askForPrompt()` inspects what a source returns to decide
 * whether there is a prompt at all, and an `async` source cannot answer that: the check would
 * see a Promise — truthy, and not `null` — and report a prompt on every call, including the
 * one after the source was spent. The loop would then never reach its exit route and would
 * spin. Every source here is synchronous work (a file, a pipe, an argument), so returning a
 * value rather than a Promise costs nothing and keeps "nothing left" observable.
 *
 * @param {() => string} read reads the text, called at most once
 * @param {string} emptyMessage the refusal for a source that turned out to hold nothing
 * @returns {() => string|null} the source; `null` means "nothing more to run"
 */
function createOnce(read, emptyMessage) {
  let used = false;
  return () => {
    if (used) return null;
    used = true;
    const text = String(read() ?? '');
    if (!text.trim()) throw new Error(emptyMessage);
    return text;
  };
}

/**
 * A prompt source that answers once with the file's contents, then stops.
 *
 * `readFile` is injected so the source is testable without touching a disk. The read, the
 * verbatim rule and the empty refusal are `createOnce`'s; this function only supplies where
 * the bytes come from and what to say when there are none.
 *
 * @param {object} options
 * @param {string} options.file the path to read
 * @param {Function} options.readFile `(path) => string`
 * @returns {() => string|null} the source; `null` means "nothing more to run"
 */
export function createFilePrompt({ file, readFile }) {
  return createOnce(() => readFile(file), `${EXEC_FLAG} ${file} is empty; there is no prompt to run`);
}

/**
 * The prompt source the flags ask for, or `null` when they name none.
 *
 * All three sources produce the same thing — one string, answered once — so the caller
 * (`main.js`) never learns which one it got and `runSessionLoop` keeps taking a source it
 * already knew how to take. The three differ only in where the bytes come from:
 *
 * - `--exec <file>` reads the file, as `createFilePrompt` always did.
 * - `--exec -` reads **stdin**, which the runner supplies whenever there is no tty
 *   (`bin/lib/container.sh`), so `moncho-cli run --exec - < task.md` works the way every
 *   other unix command does.
 * - `--prompt <text>` is the argument itself, verbatim.
 *
 * `readStdin` is injected for the same reason `readFile` is: the contract is proved without a
 * terminal. It is expected to answer with the bytes **already in hand**, which is why this
 * stays synchronous — `main.js` drains the pipe once at startup through
 * `utils/stdin-prompt.js#readStdinPrompt` (which is also what refuses a terminal, since that
 * read would never end), and the source only has to hand the answer over. The loop inspects
 * that answer to decide whether there is a prompt at all (see `createFilePrompt`).
 *
 * An empty source is refused rather than sent: an empty prompt is not a task. A **file** and
 * an **argument** are checked on the first call, never at construction, because a throw here
 * would be a crash in the wiring before a session exists to report it. Stdin's emptiness is
 * caught at startup with the pipe's terminal check, for the reason above.
 *
 * @param {object} options
 * @param {string|null} [options.exec] the `--exec` value, `-` meaning stdin
 * @param {string|null} [options.prompt] the `--prompt` value
 * @param {Function} [options.readFile] `(path) => string`
 * @param {Function} [options.readStdin] `() => string`
 * @returns {(() => string|null)|null} the source, or `null` when no prompt was named
 */
export function createPromptSource({ exec = null, prompt = null, readFile, readStdin } = {}) {
  if (prompt !== null && prompt !== undefined) {
    return createOnce(() => prompt, `${PROMPT_FLAG} is empty; there is no prompt to run`);
  }

  if (exec === STDIN_PATH) {
    return createOnce(readStdin, `${EXEC_FLAG} ${STDIN_PATH} is empty; nothing was piped to it`);
  }

  if (exec !== null && exec !== undefined) return createFilePrompt({ file: exec, readFile });
  return null;
}