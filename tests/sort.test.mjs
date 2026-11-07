import test from 'node:test';
import assert from 'node:assert/strict';

import { computeWorkspaceOrder, sameOrder, compareByTitle } from '../lib/sort.mjs';

/**
 * Build a Session metadata map from plain objects.
 * @param {Record<string, object>} entries
 * @returns {Map<string, object>}
 */
function meta(entries) {
  return new Map(Object.entries(entries));
}

test('workspaces with a running session lead, sorted by title', () => {
  const workspaces = [
    { id: 'a', title: 'alpha', sessionIds: ['s-a'] },
    { id: 'b', title: 'Zulu', sessionIds: ['s-b'] },
    { id: 'c', title: 'Bravo', sessionIds: ['s-c'] },
  ];
  const sessions = meta({
    's-a': { updatedAt: 300, running: false },
    's-b': { updatedAt: 100, running: true },
    's-c': { updatedAt: 200, running: true },
  });

  assert.deepEqual(
    computeWorkspaceOrder({ workspaces, sessions }),
    ['c', 'b', 'a'],
  );
});

test('remaining workspaces sort by their newest session activity', () => {
  const workspaces = [
    { id: 'a', title: 'alpha', sessionIds: ['s-a1', 's-a2'] },
    { id: 'b', title: 'beta', sessionIds: ['s-b1'] },
    { id: 'c', title: 'gamma', sessionIds: ['s-c1'] },
  ];
  const sessions = meta({
    's-a1': { updatedAt: 100 },
    's-a2': { updatedAt: 900 },
    's-b1': { updatedAt: 500 },
    's-c1': { updatedAt: 700 },
  });

  assert.deepEqual(
    computeWorkspaceOrder({ workspaces, sessions }),
    ['a', 'c', 'b'],
  );
});

test('an active workspace is not lifted by its running session id only: the workspace moves, sessions keep their order', () => {
  const workspaces = [
    { id: 'a', title: 'alpha', sessionIds: ['s-a'] },
    { id: 'b', title: 'beta', sessionIds: ['s-b'] },
  ];
  const sessions = meta({
    's-a': { updatedAt: 1 },
    's-b': { updatedAt: 2, running: true },
  });

  // Only workspace ids are returned; the function never emits session ids.
  const order = computeWorkspaceOrder({ workspaces, sessions });
  assert.deepEqual(order, ['b', 'a']);
  for (const id of order) {
    assert.ok(id === 'a' || id === 'b');
  }
});

test('archived sessions do not date a workspace or mark it active', () => {
  const workspaces = [
    { id: 'a', title: 'alpha', sessionIds: ['s-a'] },
    { id: 'b', title: 'beta', sessionIds: ['s-b'] },
  ];
  const sessions = meta({
    's-a': { updatedAt: 900, running: true },
    's-b': { updatedAt: 100 },
  });

  assert.deepEqual(
    computeWorkspaceOrder({ workspaces, sessions, archivedIds: ['s-a'] }),
    ['b', 'a'],
  );
});

test('blank drafts and subagent sessions are ignored', () => {
  const workspaces = [
    { id: 'a', title: 'alpha', sessionIds: ['s-blank', 's-sub'] },
    { id: 'b', title: 'beta', sessionIds: ['s-b'] },
  ];
  const sessions = meta({
    's-blank': { updatedAt: 9_000, running: false, blank: true },
    's-sub': { updatedAt: 9_500, running: true, origin: 'subagent' },
    's-b': { updatedAt: 100 },
  });

  assert.deepEqual(computeWorkspaceOrder({ workspaces, sessions }), ['b', 'a']);
});

test('workspaces without usable sessions fall to the end, by title', () => {
  const workspaces = [
    { id: 'a', title: 'alpha', sessionIds: [] },
    { id: 'b', title: 'beta', sessionIds: ['s-unknown'] },
    { id: 'c', title: 'gamma', sessionIds: ['s-c'] },
  ];
  const sessions = meta({ 's-c': { updatedAt: 10 } });

  assert.deepEqual(computeWorkspaceOrder({ workspaces, sessions }), ['c', 'a', 'b']);
});

test('equal activity timestamps fall back to title, then id', () => {
  const workspaces = [
    { id: 'b', title: 'Same', sessionIds: ['s-b'] },
    { id: 'a', title: 'same', sessionIds: ['s-a'] },
  ];
  const sessions = meta({
    's-a': { updatedAt: 50 },
    's-b': { updatedAt: 50 },
  });

  assert.deepEqual(computeWorkspaceOrder({ workspaces, sessions }), ['a', 'b']);
});

test('active workspaces with identical titles keep a stable id order', () => {
  const workspaces = [
    { id: 'z', title: 'dup', sessionIds: ['s-z'] },
    { id: 'x', title: 'dup', sessionIds: ['s-x'] },
  ];
  const sessions = meta({
    's-z': { updatedAt: 1, running: true },
    's-x': { updatedAt: 2, running: true },
  });

  assert.deepEqual(computeWorkspaceOrder({ workspaces, sessions }), ['x', 'z']);
  assert.deepEqual(computeWorkspaceOrder({ workspaces, sessions }), ['x', 'z']);
});

test('sameOrder compares sequences, not sets', () => {
  assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameOrder(['a'], ['a', 'b']), false);
});

test('compareByTitle is case-insensitive and numeric-aware', () => {
  assert.ok(compareByTitle({ id: '1', title: 'item 2' }, { id: '2', title: 'Item 10' }) < 0);
  assert.ok(compareByTitle({ id: 'a', title: 'Beta' }, { id: 'b', title: 'alpha' }) > 0);
});
