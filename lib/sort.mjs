/**
 * Pure ordering rules for the workspace sorter.
 *
 * The sorter is a display-order projection over three inputs:
 *   - the durable Workspace list (identity, title, accounted Session ids),
 *   - per-Session list metadata (last activity time, running flag, blankness,
 *     subagent origin),
 *   - the durable archived Session set.
 *
 * It returns the complete desired Workspace id order. It never looks at the
 * order of Sessions inside a Workspace, so applying the result cannot move a
 * Session row: only whole Workspace sections change position.
 */

/** Collator shared by every comparison: case-insensitive, numeric-aware. */
const TITLE_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/**
 * Compare two strings deterministically, independent of the platform locale.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compare two Workspace rows by display title, falling back to the id so the
 * order is total and stable even when titles collide.
 * @param {{ id: string, title: string }} left
 * @param {{ id: string, title: string }} right
 * @returns {number}
 */
export function compareByTitle(left, right) {
  const byTitle = TITLE_COLLATOR.compare(left.title, right.title);
  return byTitle !== 0 ? byTitle : compareIds(left.id, right.id);
}

/**
 * Whether one Session contributes to its Workspace's sort key at all.
 * Blank drafts and subagent-origin Sessions are not conversation activity the
 * user can see in the workspace list, so they neither date a Workspace nor
 * mark it active.
 * @param {{ blank?: boolean, origin?: string } | undefined} meta
 * @returns {boolean}
 */
function contributesActivity(meta) {
  if (meta === undefined) return false;
  if (meta.blank === true) return false;
  return meta.origin !== 'subagent';
}

/**
 * Derive the desired complete Workspace order.
 *
 * Workspaces containing at least one running (non-archived, non-blank,
 * non-subagent) Session lead, sorted by title. All remaining workspaces follow,
 * newest Session activity first, then by title; a workspace whose Sessions are
 * all archived or unknown keeps the oldest possible activity and therefore
 * falls to the end of that group.
 *
 * @param {object} input
 * @param {ReadonlyArray<{ id: string, title?: string, sessionIds?: readonly string[] }>} input.workspaces
 *   Workspace rows in their current durable order (only the set matters).
 * @param {ReadonlyMap<string, { updatedAt?: number, running?: boolean, blank?: boolean, origin?: string }>} input.sessions
 *   Per-Session list metadata keyed by Session id.
 * @param {ReadonlyArray<string>} [input.archivedIds]
 *   Durable archived Session ids.
 * @returns {string[]} the complete desired Workspace id order.
 */
export function computeWorkspaceOrder({ workspaces, sessions, archivedIds = [] }) {
  const archived = new Set(archivedIds);
  const rows = workspaces.map(workspace => {
    let latestAt = Number.NEGATIVE_INFINITY;
    let active = false;
    for (const sessionId of workspace.sessionIds ?? []) {
      if (archived.has(sessionId)) continue;
      const meta = sessions.get(sessionId);
      if (!contributesActivity(meta)) continue;
      if (meta.running === true) active = true;
      if (typeof meta.updatedAt === 'number' && meta.updatedAt > latestAt) latestAt = meta.updatedAt;
    }
    return {
      id: workspace.id,
      title: typeof workspace.title === 'string' ? workspace.title : '',
      active,
      latestAt,
    };
  });

  const activeRows = rows.filter(row => row.active).sort(compareByTitle);
  const idleRows = rows
    .filter(row => !row.active)
    .sort((left, right) => {
      if (right.latestAt !== left.latestAt) return right.latestAt - left.latestAt;
      return compareByTitle(left, right);
    });

  return [...activeRows, ...idleRows].map(row => row.id);
}

/**
 * Whether two id sequences are the same order.
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {boolean}
 */
export function sameOrder(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
