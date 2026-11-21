import { spawnSync } from 'node:child_process';

/**
 * Putting the selection on the clipboard of the machine the user is sitting at, through a
 * native tool — the path that actually works.
 *
 * OSC 52 (`app/clipboard.js`) is the only clipboard a bare terminal offers a program, and it
 * is honoured **only when the terminal chooses to**: xterm gates it behind its
 * window-operations resource, tmux needs `set-clipboard on`, and a terminal that does not
 * implement it drops the sequence in silence — which looks exactly like a copy that never
 * happened, toast and all. So the sequence is still built, because it is the one thing that
 * reaches a user whose machine has no clipboard tool at all (an SSH session into a
 * container), but it is the **fallback**: a native tool that exits 0 has really put the text
 * where the user will paste it, and that is verifiable where OSC 52 is only a hope.
 *
 * The candidates, in the order they are tried:
 *
 *  - **macOS** — `pbcopy`, always present;
 *  - **Windows** — `clip.exe`, always present;
 *  - **Wayland** — `wl-copy`, first when `WAYLAND_DISPLAY` names a compositor;
 *  - **X11** — `xclip -selection clipboard`, then `xsel --clipboard --input`.
 *
 * Two details keep this cheap enough to run from a mouse handler:
 *
 *  - a tool that is not installed is **remembered as missing** (`ENOENT`), so a session on a
 *    box without `xclip` spawns one failed process and never tries that one again;
 *  - every spawn is bounded by a timeout, because a wedged clipboard daemon must not freeze
 *    the conversation.
 *
 * Pure enough to test without a terminal: `spawn` and the platform are injected, so the
 * order, the fall-through and the "remembered missing" rule are proven with a recorder
 * rather than a real clipboard.
 */

/** The tools to try, in order, for this platform and environment. */
export function nativeClipboardCandidates({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform === 'darwin') {
    return [{ name: 'pbcopy', command: 'pbcopy', args: [] }];
  }
  if (platform === 'win32') {
    return [{ name: 'clip', command: 'clip', args: [] }];
  }
  // Everything else is treated as a Unix with an X11 or Wayland session. Wayland is tried
  // first when the environment says so, because `xclip` under XWayland often exists and
  // silently targets a display nobody is looking at.
  const x11 = [
    { name: 'xclip', command: 'xclip', args: ['-selection', 'clipboard'] },
    { name: 'xsel', command: 'xsel', args: ['--clipboard', '--input'] },
  ];
  const wayland = { name: 'wl-copy', command: 'wl-copy', args: [] };
  return env.WAYLAND_DISPLAY ? [wayland, ...x11] : [...x11, wayland];
}

/**
 * The native writer: `write(text)` answers `{ ok, via, error }` for the first candidate that
 * accepts the text, or `{ ok: false, via: null, error: <the last reason> }` when none does.
 *
 * `via` names the tool that took it — the report carries it so the caller can say *how* the
 * text was delivered rather than only that it was. A candidate that reported `ENOENT` is
 * retired for the life of the process, so a missing tool is discovered once.
 */
export function createNativeClipboard({
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
  timeoutMs = 2000,
} = {}) {
  const candidates = nativeClipboardCandidates({ platform, env });
  const missing = new Set();

  return {
    candidates: () => candidates.slice(),
    /** The tools already known not to be installed. */
    missing: () => Array.from(missing),
    write(text) {
      const payload = String(text ?? '');
      if (!payload) return { ok: false, via: null, error: 'EMPTY' };
      let reason = 'NO_TOOL';

      for (const candidate of candidates) {
        if (missing.has(candidate.name)) continue;
        try {
          const result = spawn(candidate.command, candidate.args, {
            input: payload,
            timeout: timeoutMs,
            windowsHide: true,
          });
          if (result?.error) {
            const code = result.error.code || result.error.message || 'FAILED';
            // A tool that is not installed will not appear later in this process.
            if (code === 'ENOENT') missing.add(candidate.name);
            reason = code;
            continue;
          }
          if (result?.status === 0) return { ok: true, via: candidate.name, error: null };
          reason = `EXIT_${result?.status ?? 'UNKNOWN'}`;
        } catch (error) {
          // A throwing spawn is one more reason to try the next tool, never a crash: a copy
          // is a convenience, and losing the clipboard must not take the conversation down
          // (`app/clipboard.js#createClipboard`).
          reason = error?.code || error?.message || 'FAILED';
        }
      }

      return { ok: false, via: null, error: reason };
    },
  };
}