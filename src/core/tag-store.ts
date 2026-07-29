import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface ProjectMeta {
  /** Client this project is billed to. One client, many projects. */
  client: string | null;
  /** Free-form labels: "internal", "fixed-bid", "maintenance". */
  tags: string[];
  /** Display name override, for when the folder name is not the project name. */
  alias: string | null;
  /** Hidden projects stay in the data but drop out of the default view. */
  hidden: boolean;
}

interface TagFile {
  version: number;
  projects: Record<string, ProjectMeta>;
}

const TAG_VERSION = 1;

export function emptyMeta(): ProjectMeta {
  return { client: null, tags: [], alias: null, hidden: false };
}

/**
 * Persists per-project client + tag assignments.
 *
 * This is the one piece of genuinely user-authored data in the tool — every
 * other number is derived from logs and can be rebuilt by rescanning. It lives
 * in its own file so a container can mount it and survive an image rebuild.
 */
export class TagStore {
  private readonly dir: string;
  private readonly filePath: string;
  private projects: Record<string, ProjectMeta> = {};

  constructor(dir: string) {
    this.dir = dir;
    this.filePath = join(dir, 'tags.json');
  }

  /** Paths are compared case-insensitively — Windows treats J:\App and J:\app as one. */
  private static key(projectPath: string): string {
    return projectPath.replace(/[\\/]+$/, '').toLowerCase();
  }

  load(): this {
    if (!existsSync(this.filePath)) return this;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as TagFile;
      if (parsed.version === TAG_VERSION && parsed.projects) {
        for (const [k, v] of Object.entries(parsed.projects)) {
          this.projects[TagStore.key(k)] = { ...emptyMeta(), ...v };
        }
      }
    } catch {
      // Unreadable tag file: start clean rather than crash the dashboard.
    }
    return this;
  }

  get(projectPath: string): ProjectMeta {
    return this.projects[TagStore.key(projectPath)] ?? emptyMeta();
  }

  /** Applies a partial update and persists it. Returns the merged result. */
  update(projectPath: string, patch: Partial<ProjectMeta>): ProjectMeta {
    const key = TagStore.key(projectPath);
    const current = this.projects[key] ?? emptyMeta();

    const next: ProjectMeta = {
      client: patch.client !== undefined ? normalizeLabel(patch.client) : current.client,
      tags: patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags,
      alias: patch.alias !== undefined ? normalizeLabel(patch.alias) : current.alias,
      hidden: patch.hidden !== undefined ? Boolean(patch.hidden) : current.hidden,
    };

    this.projects[key] = next;
    this.save();
    return next;
  }

  /** Assigns one client to many projects in a single write. */
  bulkAssignClient(projectPaths: string[], client: string | null): void {
    const value = normalizeLabel(client);
    for (const p of projectPaths) {
      const key = TagStore.key(p);
      this.projects[key] = { ...(this.projects[key] ?? emptyMeta()), client: value };
    }
    this.save();
  }

  /** Every client name in use, sorted. */
  listClients(): string[] {
    const set = new Set<string>();
    for (const meta of Object.values(this.projects)) {
      if (meta.client) set.add(meta.client);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** Every tag in use, sorted. */
  listTags(): string[] {
    const set = new Set<string>();
    for (const meta of Object.values(this.projects)) {
      for (const tag of meta.tags) set.add(tag);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  all(): Record<string, ProjectMeta> {
    return structuredClone(this.projects);
  }

  getFilePath(): string {
    return this.filePath;
  }

  private save(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    const payload: TagFile = { version: TAG_VERSION, projects: this.projects };
    const tmpPath = join(this.dir, `tags-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }
}

function normalizeLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  return out;
}
