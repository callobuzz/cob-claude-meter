import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TagStore, emptyMeta } from '../../src/core/tag-store.js';

describe('TagStore', () => {
  let dir: string;
  let store: TagStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-meter-tags-'));
    store = new TagStore(dir).load();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty meta for an unknown project', () => {
    expect(store.get('J:\\callobuzz\\app')).toEqual(emptyMeta());
  });

  it('stores a client name', () => {
    store.update('J:\\callobuzz\\app', { client: 'Acme Corp' });
    expect(store.get('J:\\callobuzz\\app').client).toBe('Acme Corp');
  });

  it('persists across instances', () => {
    store.update('J:\\callobuzz\\app', { client: 'Acme Corp', tags: ['retainer'] });

    const reloaded = new TagStore(dir).load();
    expect(reloaded.get('J:\\callobuzz\\app').client).toBe('Acme Corp');
    expect(reloaded.get('J:\\callobuzz\\app').tags).toEqual(['retainer']);
  });

  it('writes tags.json into the given directory', () => {
    store.update('J:\\app', { client: 'X' });
    expect(existsSync(join(dir, 'tags.json'))).toBe(true);
  });

  it('matches paths case-insensitively', () => {
    store.update('J:\\Callobuzz\\App', { client: 'Acme' });
    expect(store.get('j:\\callobuzz\\app').client).toBe('Acme');
  });

  it('ignores a trailing separator', () => {
    store.update('J:\\app\\', { client: 'Acme' });
    expect(store.get('J:\\app').client).toBe('Acme');
  });

  it('merges partial updates instead of replacing', () => {
    store.update('J:\\app', { client: 'Acme', tags: ['a'] });
    store.update('J:\\app', { alias: 'The App' });

    const meta = store.get('J:\\app');
    expect(meta.client).toBe('Acme');
    expect(meta.tags).toEqual(['a']);
    expect(meta.alias).toBe('The App');
  });

  it('treats an empty client string as unset', () => {
    store.update('J:\\app', { client: 'Acme' });
    store.update('J:\\app', { client: '  ' });
    expect(store.get('J:\\app').client).toBeNull();
  });

  it('trims whitespace around labels', () => {
    store.update('J:\\app', { client: '  Acme  ' });
    expect(store.get('J:\\app').client).toBe('Acme');
  });

  it('drops empty and duplicate tags', () => {
    store.update('J:\\app', { tags: ['Billable', '', '  ', 'billable', 'Urgent'] });
    expect(store.get('J:\\app').tags).toEqual(['Billable', 'Urgent']);
  });

  it('assigns a client to many projects at once', () => {
    store.bulkAssignClient(['J:\\a', 'J:\\b', 'J:\\c'], 'Acme Corp');
    expect(store.get('J:\\a').client).toBe('Acme Corp');
    expect(store.get('J:\\b').client).toBe('Acme Corp');
    expect(store.get('J:\\c').client).toBe('Acme Corp');
  });

  it('preserves existing tags during bulk client assignment', () => {
    store.update('J:\\a', { tags: ['keep-me'] });
    store.bulkAssignClient(['J:\\a'], 'Acme Corp');
    expect(store.get('J:\\a').tags).toEqual(['keep-me']);
  });

  it('lists clients in use, deduplicated and sorted', () => {
    store.update('J:\\a', { client: 'Zeta' });
    store.update('J:\\b', { client: 'Acme' });
    store.update('J:\\c', { client: 'Acme' });
    expect(store.listClients()).toEqual(['Acme', 'Zeta']);
  });

  it('lists tags in use, deduplicated and sorted', () => {
    store.update('J:\\a', { tags: ['zebra', 'alpha'] });
    store.update('J:\\b', { tags: ['alpha'] });
    expect(store.listTags()).toEqual(['alpha', 'zebra']);
  });

  it('supports hiding a project', () => {
    store.update('J:\\a', { hidden: true });
    expect(store.get('J:\\a').hidden).toBe(true);
  });

  it('survives a corrupt tags.json', () => {
    writeFileSync(join(dir, 'tags.json'), '{ not json', 'utf-8');
    const reloaded = new TagStore(dir).load();
    expect(reloaded.get('J:\\a')).toEqual(emptyMeta());
  });

  it('does not leak internal state through all()', () => {
    store.update('J:\\a', { tags: ['x'] });
    const snapshot = store.all();
    snapshot['j:\\a'].tags.push('mutated');
    expect(store.get('J:\\a').tags).toEqual(['x']);
  });
});
