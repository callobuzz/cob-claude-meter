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
    expect(store.get('C:\\work\\app')).toEqual(emptyMeta());
  });

  it('stores a client name', () => {
    store.update('C:\\work\\app', { client: 'Acme Corp' });
    expect(store.get('C:\\work\\app').client).toBe('Acme Corp');
  });

  it('persists across instances', () => {
    store.update('C:\\work\\app', { client: 'Acme Corp', tags: ['retainer'] });

    const reloaded = new TagStore(dir).load();
    expect(reloaded.get('C:\\work\\app').client).toBe('Acme Corp');
    expect(reloaded.get('C:\\work\\app').tags).toEqual(['retainer']);
  });

  it('writes tags.json into the given directory', () => {
    store.update('C:\\app', { client: 'X' });
    expect(existsSync(join(dir, 'tags.json'))).toBe(true);
  });

  it('matches paths case-insensitively', () => {
    store.update('C:\\Work\\App', { client: 'Acme' });
    expect(store.get('c:\\work\\app').client).toBe('Acme');
  });

  it('ignores a trailing separator', () => {
    store.update('C:\\app\\', { client: 'Acme' });
    expect(store.get('C:\\app').client).toBe('Acme');
  });

  it('merges partial updates instead of replacing', () => {
    store.update('C:\\app', { client: 'Acme', tags: ['a'] });
    store.update('C:\\app', { alias: 'The App' });

    const meta = store.get('C:\\app');
    expect(meta.client).toBe('Acme');
    expect(meta.tags).toEqual(['a']);
    expect(meta.alias).toBe('The App');
  });

  it('treats an empty client string as unset', () => {
    store.update('C:\\app', { client: 'Acme' });
    store.update('C:\\app', { client: '  ' });
    expect(store.get('C:\\app').client).toBeNull();
  });

  it('trims whitespace around labels', () => {
    store.update('C:\\app', { client: '  Acme  ' });
    expect(store.get('C:\\app').client).toBe('Acme');
  });

  it('drops empty and duplicate tags', () => {
    store.update('C:\\app', { tags: ['Billable', '', '  ', 'billable', 'Urgent'] });
    expect(store.get('C:\\app').tags).toEqual(['Billable', 'Urgent']);
  });

  it('assigns a client to many projects at once', () => {
    store.bulkAssignClient(['C:\\a', 'C:\\b', 'C:\\c'], 'Acme Corp');
    expect(store.get('C:\\a').client).toBe('Acme Corp');
    expect(store.get('C:\\b').client).toBe('Acme Corp');
    expect(store.get('C:\\c').client).toBe('Acme Corp');
  });

  it('preserves existing tags during bulk client assignment', () => {
    store.update('C:\\a', { tags: ['keep-me'] });
    store.bulkAssignClient(['C:\\a'], 'Acme Corp');
    expect(store.get('C:\\a').tags).toEqual(['keep-me']);
  });

  it('lists clients in use, deduplicated and sorted', () => {
    store.update('C:\\a', { client: 'Zeta' });
    store.update('C:\\b', { client: 'Acme' });
    store.update('C:\\c', { client: 'Acme' });
    expect(store.listClients()).toEqual(['Acme', 'Zeta']);
  });

  it('lists tags in use, deduplicated and sorted', () => {
    store.update('C:\\a', { tags: ['zebra', 'alpha'] });
    store.update('C:\\b', { tags: ['alpha'] });
    expect(store.listTags()).toEqual(['alpha', 'zebra']);
  });

  it('supports hiding a project', () => {
    store.update('C:\\a', { hidden: true });
    expect(store.get('C:\\a').hidden).toBe(true);
  });

  it('survives a corrupt tags.json', () => {
    writeFileSync(join(dir, 'tags.json'), '{ not json', 'utf-8');
    const reloaded = new TagStore(dir).load();
    expect(reloaded.get('C:\\a')).toEqual(emptyMeta());
  });

  it('does not leak internal state through all()', () => {
    store.update('C:\\a', { tags: ['x'] });
    const snapshot = store.all();
    snapshot['c:\\a'].tags.push('mutated');
    expect(store.get('C:\\a').tags).toEqual(['x']);
  });
});
