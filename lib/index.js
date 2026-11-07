/**
 * dsh-workspace-sort — Host plugin.
 *
 * Keeps the durable Workspace display order sorted:
 *   1. Workspaces that contain a running Session come first, by workspace title.
 *   2. Every other Workspace follows by its most recent Session activity,
 *      newest first (then by title).
 *
 * The sorter only moves whole Workspaces through
 * `ctx.workspaceRegistry.insertBefore`. Session order inside a Workspace is
 * never read for ordering and never written, so a busy session lifts its
 * Workspace, not the session itself.
 *
 * The workspace list the sidebar renders is the durable registry order, so the
 * sorted result is expressed by rewriting that order. No client half is
 * needed: the running Web client receives the resulting `order` frames.
 */

import { computeWorkspaceOrder, sameOrder } from './sort.mjs';

export const name = 'dsh-workspace-sort';

/** @type {string[]} */
export const inject = ['workspaceRegistry', 'sessionController'];

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  debounceMs: 350,
});

/** How many times a failed startup Session baseline is retried. */
const BASELINE_RETRIES = 5;
/** Delay before each baseline retry, by attempt index. */
const BASELINE_RETRY_DELAYS = [1_000, 3_000, 10_000, 30_000, 60_000];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, debounceMs?: number } | undefined} rawConfig
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger ?? {
    info: message => console.info(message),
    warn: message => console.warn(message),
  };
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  if (config.enabled === false) {
    logger.info('workspace-sort: disabled by config');
    return;
  }
  const debounceMs = Number.isFinite(config.debounceMs) && config.debounceMs >= 0
    ? config.debounceMs
    : DEFAULT_CONFIG.debounceMs;

  /** sessionId -> { updatedAt, running, blank, origin } */
  const sessions = new Map();

  let disposed = false;
  let timer;
  let applying = false;
  let queued = false;
  let baselineReady = false;
  let baselineAttempt = 0;
  let baselineAbort;

  const describe = error => (error instanceof Error ? error.message : String(error));

  const schedule = () => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile();
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  /** Merge one list row (or event-derived patch) into the metadata cache. */
  const remember = summary => {
    if (summary === null || typeof summary !== 'object') return;
    const sessionId = summary.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const current = sessions.get(sessionId);
    sessions.set(sessionId, {
      updatedAt: typeof summary.updatedAt === 'number'
        ? summary.updatedAt
        : (current?.updatedAt ?? 0),
      running: typeof summary.running === 'boolean'
        ? summary.running
        : (current?.running ?? false),
      blank: typeof summary.blank === 'boolean'
        ? summary.blank
        : (current?.blank ?? false),
      origin: typeof summary.origin === 'string' ? summary.origin : current?.origin,
    });
  };

  /**
   * Apply the currently desired Workspace order, moving one Workspace at a
   * time and always re-reading the committed order between moves.
   */
  const reconcile = async () => {
    if (disposed || !baselineReady) return;
    if (applying) {
      queued = true;
      return;
    }
    applying = true;
    try {
      const registry = ctx.workspaceRegistry;
      const currentWorkspaces = registry.list();
      const desired = computeWorkspaceOrder({
        workspaces: currentWorkspaces.map(workspace => ({
          id: workspace.id,
          title: workspace.title,
          sessionIds: workspace.sessionIds,
        })),
        sessions,
        archivedIds: registry.archivedSessionIds,
      });
      let current = currentWorkspaces.map(workspace => workspace.id);
      if (desired.length !== current.length || sameOrder(desired, current)) return;

      let moves = 0;
      for (let index = 0; index < desired.length; index++) {
        if (disposed) return;
        const target = desired[index];
        if (current[index] === target) continue;
        if (!current.includes(target)) {
          // The registry changed under us; recompute on the next pass.
          queued = true;
          return;
        }
        current = [...await registry.insertBefore(target, current[index])];
        moves += 1;
      }
      if (moves > 0) {
        logger.info(`workspace-sort: reordered ${moves} workspace(s)`);
      }
    } catch (error) {
      logger.warn(`workspace-sort: reorder pass failed: ${describe(error)}`);
    } finally {
      applying = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  };

  /** Load the Session list baseline through the Host Session controller. */
  const loadBaseline = async () => {
    baselineAbort?.abort();
    const controller = new AbortController();
    baselineAbort = controller;
    try {
      const value = await ctx.sessionController.list({}, controller.signal);
      if (disposed || controller.signal.aborted) return;
      for (const summary of value?.items ?? []) remember(summary);
      baselineReady = true;
      logger.info(`workspace-sort: session baseline loaded (${sessions.size} session(s))`);
      schedule();
    } catch (error) {
      if (disposed || controller.signal.aborted) return;
      logger.warn(`workspace-sort: session baseline failed: ${describe(error)}`);
      const delay = BASELINE_RETRY_DELAYS[Math.min(baselineAttempt, BASELINE_RETRY_DELAYS.length - 1)];
      baselineAttempt += 1;
      if (baselineAttempt <= BASELINE_RETRIES) {
        setTimeout(() => {
          if (!disposed) void loadBaseline();
        }, delay).unref?.();
      } else {
        logger.warn('workspace-sort: giving up on the session baseline; workspaces will keep their current order');
      }
    }
  };

  ctx.effect(() => {
    void loadBaseline();
    return () => {
      baselineAbort?.abort();
      baselineAbort = undefined;
    };
  }, 'workspace-sort: session baseline');

  ctx.effect(() => () => {
    disposed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }, 'workspace-sort: debounce timer');

  // A user-authored durable message advanced the Session's list activity.
  ctx.on('api-session/activity', (sessionId, updatedAt) => {
    if (typeof sessionId !== 'string') return;
    const current = sessions.get(sessionId);
    sessions.set(sessionId, {
      updatedAt: typeof updatedAt === 'number' ? updatedAt : (current?.updatedAt ?? 0),
      running: current?.running ?? false,
      blank: false,
      origin: current?.origin,
    });
    schedule();
  });

  // An Agent changed running state: this is what makes a Workspace "active".
  ctx.on('api-session/status', (sessionId, running) => {
    if (typeof sessionId !== 'string') return;
    const current = sessions.get(sessionId);
    sessions.set(sessionId, {
      updatedAt: current?.updatedAt ?? 0,
      running: running === true,
      blank: current?.blank ?? false,
      origin: current?.origin,
    });
    schedule();
  });

  // A Session became visible, or its Agent was created/disposed.
  ctx.on('api-session/added', summary => {
    remember(summary);
    schedule();
  });

  // A Session left the live registry.
  ctx.on('api-session/removed', sessionId => {
    if (typeof sessionId !== 'string') return;
    sessions.delete(sessionId);
    schedule();
  });

  // Workspace creations, deletions, renames, and manual reorders are durable
  // workspace-domain writes; re-evaluate the order after each of them.
  ctx.on('domain/changed', change => {
    if (change?.domain === 'workspace') schedule();
  });
}
