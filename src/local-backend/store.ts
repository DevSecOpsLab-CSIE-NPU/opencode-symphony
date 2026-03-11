import fs from 'node:fs';
import path from 'node:path';
import type { Issue, StatusType, PriorityType } from './schemas.js';

interface StoreData {
  issues: Issue[];
  activity: ActivityRecord[];
}

export class LocalIssueStore {
  private storePath: string;
  private data: StoreData = { issues: [], activity: [] };

  constructor(dbPath: string = '/tmp/symphony-issues.json') {
    this.storePath = dbPath;
    this.loadData();
    
    if (this.data.issues.length === 0) {
      this.initSeedData();
    }
  }

  private loadData() {
    try {
      if (fs.existsSync(this.storePath)) {
        const content = fs.readFileSync(this.storePath, 'utf-8');
        const parsed = JSON.parse(content);
        this.data = { ...this.data, ...parsed };
      }
    } catch (e) {
      console.warn('[LocalStore] Failed to load data:', e);
      this.data = { issues: [], activity: [] };
    }
  }

  private initSeedData() {
    console.log('[LocalStore] Initializing with seed data...');
    
    const now = new Date().toISOString();
    this.data.issues = [
      { id: 'seed-1', key: 'SYM-001', title: 'Setup Local Issue Dashboard', description: 'Create a terminal-based issue management system with vim-style shortcuts', status: 'in-progress', priority: 'high', createdAt: new Date(now), updatedAt: new Date(now) },
      { id: 'seed-2', key: 'SYM-002', title: 'Add kanban view', description: 'Implement keyboard navigation for board view', status: 'todo', priority: 'medium', createdAt: new Date(now), updatedAt: new Date(now) },
      { id: 'seed-3', key: 'SYM-003', title: 'Export analytics', description: 'Support export to JSON/CSV', status: 'backlog', priority: 'low', createdAt: new Date(now), updatedAt: new Date(now) },
    ];
    this.save();
  }

  private save() {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[LocalStore Failed to save data:', e);
    }
  }

  list(options?: { status?: StatusType; priority?: PriorityType }): Issue[] {
    let issues = [...this.data.issues];

    if (options?.status) {
      issues = issues.filter(i => i.status === options.status);
    }
    if (options?.priority) {
      issues = issues.filter(i => i.priority === options.priority);
    }

    issues.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return issues;
  }

  get(id: string): Issue | null {
    const issue = this.data.issues.find(i => i.id === id);
    return issue || null;
  }

  create(data: Omit<Issue, 'id' | 'createdAt' | 'updatedAt'>): Issue {
    const id = this.generateKey();
    const now = new Date().toISOString();
    
    const newIssue = { ...data, id, createdAt: new Date(now), updatedAt: new Date(now) };
    this.data.issues.push(newIssue);
    this.save();

    this.logActivity(id, 'created', `Issue created: ${data.key}`);

    return newIssue as Issue;
  }

  update(id: string, updates: Partial<Omit<Issue, 'id' | 'createdAt'>>): Issue | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    
    this.data.issues = this.data.issues.map(i => 
      i.id === id ? { ...i, ...updates, updatedAt: new Date(now) } : i
    );
    this.save();

    if (updates.status !== undefined) {
      this.logActivity(id, 'status_change', `Status changed to ${updates.status}`);
    }

    return this.get(id)!;
  }

  delete(id: string): boolean {
    const exists = this.get(id);
    if (!exists) return false;

    this.data.issues = this.data.issues.filter(i => i.id !== id);
    this.save();

    this.logActivity(exists.key as any as string, 'deleted', `Issue deleted: ${exists.id}`);

    return true;
  }

  getActivityLog(issueId?: string): ActivityRecord[] {
    let logs = this.data.activity;
    
    if (issueId) {
      logs = logs.filter(log => log.issueId === issueId);
    }
    
    return logs.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ).slice(0, 50);
  }

  private logActivity(issueId: string, action: string, description: string) {
    const now = new Date().toISOString();
    const id = `act-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    
    this.data.activity.push({
      id, issueId, action, description, createdAt: now
    });
  }

  private generateKey(): string {
    let key: string;
    let attempts = 0;
    do {
      key = `issue-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      attempts++;
    } while (this.get(key) && attempts < 100);
    return key;
  }

  getStatusCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    
    for (const issue of this.data.issues) {
      counts[issue.status] = (counts[issue.status] || 0) + 1;
    }
    
    return counts;
  }

  getStats() {
    const completed = this.data.issues.filter(i => i.status === 'done').length;
    const active = this.data.issues.filter(i => 
      i.status !== 'done' && i.status !== 'canceled'
    ).length;
    
    return {
      total: this.data.issues.length,
      completed,
      active,
      counts: this.getStatusCounts()
    };
  }
}

interface ActivityRecord {
  id: string;
  issueId: string;
  action: string;
  description: string;
  createdAt: string;
}

export default LocalIssueStore;
