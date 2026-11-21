/**
 * The transient surface: the notice bar and the retry handle.
 *
 * A recovered provider failure is *news*, not history (`docs/interface/notice-overlay`):
 * it floats over the transcript and hides itself after a few minutes instead of leaving a
 * stale error line in the record. The line CLI has no floating box, so it prints the same
 * information as a plain line — only the place differs (`docs/interface/line-cli`).
 *
 * The handle of the current retry notice is kept here so a turn that finally succeeds can
 * take it down at once instead of waiting out its TTL. That is the whole reason this is an
 * object rather than a bare function: the handle is state the startup file would otherwise
 * have to carry itself.
 *
 * @param {object} options
 * @param {object} [options.tui] the TUI, or `null` for the line CLI
 * @param {Function} [options.log] the line sink the CLI fallback prints through
 * @returns {{notify: Function, dismissRetry: Function}}
 */
export function createNoticeSink({ tui = null, log = () => {} } = {}) {
  let retry = null;

  const notify = (kind, text, options = {}) => {
    if (tui) {
      const handle = tui.notice(kind, text, options);
      if (options.code === 'retry') retry = handle;
      return handle;
    }
    log(`[${kind}] ${text}`);
    return null;
  };

  /** Take the retry notice down if one is up; `false` when there was none. */
  const dismissRetry = () => {
    if (retry === null) return false;
    tui?.dismissNotice(retry);
    retry = null;
    return true;
  };

  return { notify, dismissRetry };
}
