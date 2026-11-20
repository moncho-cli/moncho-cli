import { callOllama } from '../api/ollama.js';
import { CONTEXT_MAX_LENGTH } from '../config/constants.js';
import { ContextWindow } from './context-window.js';
import { registerContextWindow, registerTaskPulse } from '../utils/host.js';
import { createTaskPulse, formatPulseLimitNotice } from '../utils/task-pulse.js';
import { createUsageMeter } from '../utils/usage-stats.js';
import { createWorkingClock } from '../utils/working-time.js';
import { createCompactionRunner, createSummaryCallModel } from './compaction-runner.js';
import { formatFailureNotice } from './notice-overlay.js';
import { runTurn } from './turn-runner.js';
import { runToolBatch, storeFinalResponse } from './manager-turn.js';
import {
  accountUsage,
  accountWorkTime,
  announceChunksChange,
  announceContextChange,
  announceNotice,
  announceRetry,
  timeCallModel,
  workingTotals,
} from './manager-hooks.js';

/**
 * The conversation: its state, and the seam the turn runner drives.
 *
 * The context is an array of chunks (app/context-window.js), so the token count of
 * the window and its compaction at CONTEXT_MAX_LENGTH are backed by real state;
 * `getMessages()`/`reset()` remain as compatibility shims.
 *
 * The class owns everything that outlives a turn — the window, the usage meter, the
 * working clock, the model-call pulse, the compaction runner, the tool functions —
 * plus the hooks the host needs. The *control flow of one turn* lives in
 * `app/turn-runner.js`, which calls the members below; the hooks and the accounting
 * are one-line delegations to `app/manager-hooks.js`, and the turn's two side effects
 * to `app/manager-turn.js`. That split is what keeps every module here under the line
 * budget and lets a turn be tested against a stub session.
 *
 * Four responsibilities are documented where they are used: the tool-call `intent`
 * (printed *and* persisted in the result chunk), a failure told apart by whether it was
 * *recovered* (`app/notice-overlay.js`), one assistant message's tool calls as a batch
 * (`docs/agent/tool-multicall`), and the model-call pulse (`docs/context/call-pulse`) —
 * host state, never a chunk, its line paused so the count does not ride the request.
 * Every model call and every tool batch is timed (`docs/context/working-time`): host
 * state like the pulse, with only the committed part accounted per model in the usage
 * table the session file keeps.
 */
export class ConversationManager {
  constructor(toolFunctions, getTools, getAbortSignal = () => null, options = {}) {
    this.toolFunctions = toolFunctions;
    this.getTools = getTools; // Function that returns current tools array
    this.getAbortSignal = getAbortSignal; // Function that returns the active task's AbortSignal
    this.log = options.log || ((message) => console.log(message));
    this.onContextChange = options.onContextChange || null;
    // The conversation itself changed (a chunk landed, a compaction rewrote the
    // window). Distinct from `onContextChange`, which is the *meter* and also fires
    // before a call that adds nothing: the host saves the session on this hook
    // (app/session-autosave.js), so it must not fire on a bare repaint.
    this.onChunksChange = options.onChunksChange || null;
    // The user's own message is announced before the model is called, so both
    // front ends can echo it: the transcript is otherwise one-sided.
    this.onUserMessage = options.onUserMessage || null;
    // Transient notices (app/notice-overlay.js): a recovered failure is shown in
    // the overlay and expires, instead of staying in the transcript forever.
    this.onNotice = options.onNotice || null;
    // Which model answered: the key the usage table is kept under.
    this.model = options.model || null;
    // Token accounting per model (utils/usage-stats.js).
    this.usage = createUsageMeter({ models: options.usage || {} });
    // The working-time clock (utils/working-time.js): only the spans the model spent
    // thinking and the spans a tool batch spent resolving are counted.
    this.working = options.working || createWorkingClock(options.workingOptions || {});
    // How many tool calls of one assistant message run at once.
    this.maxParallelToolCalls = options.maxParallelToolCalls ?? null;
    // The pre-dispatch gate (app/tool-guard.js): the mode rules that decide which
    // calls may run at all. `null` keeps every call allowed, exactly as before the
    // intent modes existed (`docs/interface/modes`).
    this.toolGate = typeof options.toolGate === 'function' ? options.toolGate : null;
    // How many times one turn may be refused for asking for tools before it has
    // addressed the user (`docs/agent/approach-gate`). The rule is read by the turn
    // loop; `0` — the default — leaves a session unpoliced, which is what keeps every
    // existing wiring and stub session behaving exactly as it did.
    this.approachMaxRefusals = Number.isFinite(options.approachMaxRefusals)
      ? Math.max(0, Math.floor(options.approachMaxRefusals))
      : 0;
    // The model-call pulse (utils/task-pulse.js): an injected counter keeps the
    // tests deterministic, and it is the object `update_task` resets through the
    // host registry.
    this.pulse = options.pulse || createTaskPulse(options.pulseLimit ? { limit: options.pulseLimit } : {});
    // The provider call, injectable (a stub drives tests/turn-runner.test.js) and
    // adapted to one signature: `(messages, tools, signal, options)`.
    this.callModel = this.timedCallModel(options.callModel || ((messages, tools, signal, callOptions) =>
      callOllama(messages, tools, false, signal, callOptions)));
    this.formatFailure = options.formatFailure || formatFailureNotice;

    this.contextWindow = options.contextWindow || new ContextWindow({
      maxTokens: options.maxTokens || CONTEXT_MAX_LENGTH,
      configuredTokens: options.configuredTokens ?? null,
      realTokens: options.realTokens ?? null,
      source: options.contextSizeSource,
      tools: () => this.getTools()
    });
    // Expose the live window and the live pulse to stateless tools
    // (compact_context, update_task).
    registerContextWindow(this.contextWindow);
    registerTaskPulse(this.pulse);
    this.compactionRunner = createCompactionRunner({
      window: this.contextWindow,
      log: (line) => this.log(line),
      notify: () => this.notifyContextChange(),
      callModel: createSummaryCallModel({ meter: (response, promptTokens) => this.recordUsage(response, promptTokens) }),
      // The summariser is a provider call like any other, so it is timed like one
      // and its time is attributed to the model that answered.
      working: this.working,
      meterTime: (span) => this.recordWorkTime(span),
    });
  }

  /**
   * Wrap the provider call in a *thinking* span, so the wall clock the model spent
   * answering is counted even when the call ends in a failure (the span is closed in
   * a `finally`), and accounted against the model that answered.
   *
   * A call is counted for tokens when its answer lands; the time is counted around
   * it, which is the same moment for a success and the honest moment for a retry
   * that eventually threw.
   */
  timedCallModel(callModel) {
    return timeCallModel(this, callModel);
  }

  /**
   * Account one closed span against the model whose work it was.
   *
   * The committed time lands in the usage table (`utils/usage-stats.js#applyTime`),
   * which is what the session file keeps, so `/usage` and a resumed session report
   * the time the same way they report the tokens.
   */
  recordWorkTime({ kind = 'thinking', ms = 0 } = {}) {
    return accountWorkTime(this, { kind, ms });
  }

  /** Ordered array of context chunks. */
  get chunks() {
    return this.contextWindow.chunks;
  }

  /** The per-model token table (a snapshot), for storage and `/usage`. */
  usageTable() {
    return this.usage.table();
  }

  /**
   * The working-time totals the host paints: everything already accounted in the
   * usage table (a resumed session included) **plus** the spans still open, so the
   * number a row shows is current instead of one span stale.
   */
  workingTotals() {
    return workingTotals(this);
  }

  /** The pulse's view for the host: count, limit and remaining calls. */
  pulseStats() {
    return this.pulse.stats();
  }

  /**
   * Count one finished provider call against the model that answered it.
   *
   * The context window says how full the request is; this is the accounting record
   * the session keeps (`utils/usage-stats.js`). The provider's own counters are
   * used when it reports them, and the measured prompt plus answered text are the
   * fallback — flagged as an estimate, never passed off as exact.
   */
  recordUsage(response, promptTokens = 0) {
    return accountUsage(this, response, promptTokens);
  }

  /**
   * Announce the window's current stats to the host.
   *
   * The token meter is a *view* of the window, so it must follow every change to it
   * instead of being repainted once per turn by the host loop: the user has to see a
   * turn approach the budget while it is still running. Presentation only — a
   * listener that throws must never cost the user their turn.
   */
  notifyContextChange() {
    return announceContextChange(this);
  }

  /**
   * Announce that the *conversation* changed: the hook the host autosaves on.
   *
   * `onContextChange` is a view (the meter follows the window, and it is repainted
   * before a call that adds nothing), while this is the event the session record
   * cares about — one chunk landed, or a compaction rewrote the whole array. So a
   * session file is current while a long turn is still running, instead of only once
   * it ends (`app/session-autosave.js`).
   *
   * Presentation-adjacent and just as forgiving: a hook that throws must never cost
   * the user their turn, and without one nothing happens at all.
   */
  notifyChunksChanged(reason = 'chunk') {
    return announceChunksChange(this, reason);
  }

  /**
   * Show a transient notice: the overlay's business, never the transcript's.
   *
   * Presentation only, exactly like `onUserMessage` and `onContextChange`: a hook
   * that throws must never cost the user their turn. Without a hook the message is
   * dropped rather than written to the transcript, because that is the bug this
   * hook exists to fix.
   */
  notifyNotice(kind, text, options = {}) {
    return announceNotice(this, kind, text, options);
  }

  /** Report one retried attempt (the `onRetry` hook of api/ollama.js). */
  notifyRetry(report = {}) {
    return announceRetry(this, report);
  }

  /**
   * One agent model call: count it for the pulse, and raise the single notice that
   * says the hard limit has been passed. The call is *counted*, never refused — the
   * only way the model can reset the pulse is by calling a tool, so refusing the
   * call would deadlock the turn (`docs/context/call-pulse`).
   *
   * @returns {object[]} the call's prelude messages — today an empty array, because
   *   the pulse line is paused and `message()` answers `null` for it
   */
  beginModelCall() {
    const state = this.pulse.tick();
    if (state.crossed) {
      this.notifyNotice('warn', formatPulseLimitNotice(state), { code: 'pulse-limit' });
    }
    return [this.pulse.message()];
  }

  /**
   * Run one turn to completion (app/turn-runner.js#runTurn), which is the loop that
   * asks for a request, runs the tool batches it answers with, and ends on the first
   * tool-free reply — or on an abort or a failure.
   */
  async processInput(userInput) {
    return runTurn(this, userInput);
  }

  /** Put the model-call pulse back to 0 (an item completed, a compaction, …). */
  resetPulse(reason = 'manual') {
    return this.pulse.reset(reason);
  }

  /**
   * Compact the window when it exceeds CONTEXT_MAX_LENGTH (or when forced).
   *
   * The step itself lives in `app/compaction-runner.js`; the summary call is a
   * *neutral* one (it opts out of the agent system prompt), so the summariser does
   * not answer as the agent, and it is metered like any other provider call.
   */
  async maybeCompact(signal, options = {}) {
    const result = await this.compactionRunner.run(signal, options);
    // A compaction replaced the older share with one summary chunk: the array the
    // session record holds is a different one now.
    if (result?.compacted) this.notifyChunksChanged('compaction');
    return result;
  }

  /**
   * Run the tool calls of one assistant message as a batch
   * (`app/manager-turn.js#runToolBatch`, `docs/agent/tool-multicall`).
   *
   * The options come from the turn loop: `content` is the prose the model wrote
   * **next to** its calls, kept on the same assistant chunk, and `gate` overrides the
   * session gate for this one batch, which is how the approach rule refuses a whole
   * batch without the manager knowing what an approach is
   * (`docs/agent/approach-gate`).
   *
   * @returns {Promise<boolean>} true when a tool asked for a deferred compaction.
   */
  async handleToolCalls(toolCalls, signal, options = {}) {
    return runToolBatch(this, toolCalls, signal, options);
  }

  /** Store, print and announce the tool-free reply that ends a turn. */
  async handleFinalResponse(content) {
    return storeFinalResponse(this, content);
  }

  /** Compatibility shim: the context window as a plain message array. */
  getMessages() {
    return this.contextWindow.chunks;
  }

  reset() {
    this.contextWindow.clear();
  }
}

// The marker itself lives in ./compaction-request.js (a pure string check);
// re-exported here because this is the module the loop and the docs name.
export { detectCompactionRequest } from './compaction-request.js';
