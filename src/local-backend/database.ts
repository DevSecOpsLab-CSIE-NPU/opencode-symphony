import Database from 'better-sqlite3';
import { SQL_SCHEMA, type Issue, type StatusType, type PriorityType } from './schemas.js';

export class LocalIssueDB {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.exec(SQL_SCHEMA);
    this.initSeedData();
  }

  private initSeedData() {
    const count = this.db.prepare('SELECT COUNT(*) as c FROM issues').get() as { c: number };
    if (count.c === 0) {
      console.log('[LocalDB] Initializing with seed data...');
      const now = new Date().toISOString();
      this.db.exec(`
        INSERT INTO issues (id, key, title, description, status, priority, created_at, updated_at) VALUES
          ('seed-1', 'SYM-001', 'Setup Local Issue Dashboard', 'Create a terminal-based issue management system with vim-style shortcuts', 'in-progress', 'high', '${now}', '${now}'),
          ('seed-2', 'SYM-002', 'Add kanban view', 'Implement keyboard navigation for board view', 'todo', 'medium', '${now}', '${now}'),
          ('seed-3', 'SYM-003', 'Export analytics', 'Support export to JSON/CSV', 'backlog', 'low', '${now}', '${now}'),
          ('seed-4', 'SYM-004', 'Activity timeline', 'Show chronological activity log for issues', 'todo', 'medium', '${now}', '${now}'),
          ('seed-5', 'SYM-005', 'Live updates', 'WebSocket-based real-time sync', 'canceled', 'low', '${now}', '${now}')
      `);
    }
  }

  // CRUD operations
  list(options?: { status?: StatusType; priority?: PriorityType; sortBy?: string; sortOrder?: 'asc' | 'desc' }) {
    let query = 'SELECT * FROM issues WHERE 1=1';
    const params: any[] = [];

    if (options?.status) {
      query += ` AND status = ?`;
      params.push(options.status);
    }
    if (options?.priority) {
      query += ` AND priority = ?`;
      params.push(options.priority);
    }
    
    const sortField = ['status', 'priority', 'created_at', 'title'] as const;
    const orderDir = (options?.sortOrder || 'desc') === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${options?.sortBy && sortField.includes(options.sortBy) ? options.sortBy : 'created_at'} ${orderDir}`;

    return this.db.prepare(query).all(...params) as any[];
  }

  get(id: string): Issue | null {
    const stmt = this.db.prepare('SELECT * FROM issues WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return null;
    return this.rowToIssue(row);
  }

  create(data: Omit<Issue, 'id' | 'createdAt' | 'updatedAt'>): Issue {
    const id = this.generateKey();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO issues (id, key, title, description, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      data.key,
      data.title,
      data.description || '',
      data.status,
      data.priority,
      now,
      now
    );

    this.logActivity(id, 'created', `Issue created: ${data.key}`);

    return { ...data, id, createdAt: new Date(now), updatedAt: new Date(now) };
  }

  update(id: string, updates: Partial<Omit<Issue, 'id' | 'createdAt'>>): Issue | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: any[] = [now];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.status !== undefined) { 
      fields.push('status = ?'); 
      values.push(updates.status);
      this.logActivity(id, 'status_change', `Status changed to ${updates.status}`);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }

    if (fields.length === 0) return existing;

    values.push(id);
    this.db.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = this.get(id)!;
    return { ...updated, updatedAt: new Date(now) };
  }

  delete(id: string): boolean {
    const exists = this.get(id);
    if (!exists) return false;

    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
    this.logActivity(exists.key, 'deleted', `Issue deleted: ${exists.id}`);

    return true;
  }

  // Activity logging
  getActivityLog(issueId?: string) {
    let query = 'SELECT * FROM activity_log';
    if (issueId) {
      query += ` WHERE issue_id = '${issueId}'`;
    }
    query += ' ORDER BY created_at DESC';
    return this.db.prepare(query).all();
  }

  private logActivity(issueId: string, action: string, description: string) {
    const stmt = this.db.prepare(`
      INSERT INTO activity_log (id, issue_id, action, description, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const id = `act-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    stmt.run(id, issueId, action, description, new Date().toISOString());
  }

  // Utilities
  private generateKey(): string {
    let key: string;
    const exists = () => this.get(key);
    do {
      key = `issue-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    } while (exists());
    return key;
  }

  getStatusCounts() {
    const counts: Record<string, number> = {};
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as c FROM issues GROUP BY status
    `).all() as any[];
    for (const row of rows) {
      counts[row.status] = row.c;
    }
    return counts;
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM issues').get();
    const completed = this.db.prepare("SELECT COUNT(*) as c FROM issues WHERE status = 'done'").get();
    const inProgress = this.db.prepare("SELECT COUNT(*) as c FROM issues WHERE status IN ('todo', 'in-progress')").get();
    
    return {
      total: (total as any).c,
      completed: (completed as any).c,
      active: (inProgress as any).c,
      counts: this.getStatusCounts()
    };
  }

  close() {
    this.db.close();
  }
}

export default LocalIssueDB;
