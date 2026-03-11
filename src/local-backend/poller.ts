/**
 * Local Issue Poller - Replacement for Linear polling
 * 
 * This replaces the Linear polling mechanism with local SQLite database.
 * Issues are managed through the TUI dashboard and automatically fed to Orchestrator.
 */

import type { LinearIssue, IssueId, IsoDateTime } from '../src/orchestrator/types.js';
import LocalIssueDB from '../local-backend/database.js';

export class LocalIssuePoller {
  private db: LocalIssueDB;
  private lastPolledAt: Date | null = null;

  constructor() {
    this.db = new LocalIssueDB('/tmp/symphony-local-issues.db');
  }

  /**
   * Poll local issues instead of Linear API
   */
  async poll(): Promise<LinearIssue[] | null> {
    const issues = await this.fetchActiveIssues();
    
    if (issues.length === 0) return null;
    
    this.lastPolledAt = new Date();

    // Convert to internal format and emit events
    for (const issue of issues) {
      console.log(`[LocalPoller] Polling local issue: ${issue.key} - "${issue.title}"`);
    }

    return issues.map(this.toLinearIssue);
  }

  /**
   * Fetch active issues from local database
   */
  private async fetchActiveIssues() {
    const allIssues = this.db.list({ sortBy: 'created_at', sortOrder: 'asc' });
    
    // Filter out completed/canceled issues for polling, but keep in database
    return allIssues.filter(i => 
      i.status !== 'done' && 
      i.status !== 'canceled'
    );
  }

  /**
   * Convert local issue format to LinearIssue format
   */
  private toLinearIssue(issue: any): LinearIssue {
    const stateType = this.getStatusType(issue.status);

    return {
      id: issue.id as IssueId,
      key: issue.key as string & { __brand: 'IssueKey' },
      title: issue.title,
      url: `local:/issues/${issue.key}`,
      ...(issue.description && { description: issue.description }),
      state: {
        id: this.localStatusToUuid(issue.status),
        name: convertStatusName(issue.status),
        type: stateType,
      },
      priority: getPriorityValue(issue.priority),
      assignee: null, // No assignment in local system yet
      labels: [], // Could be added later
      updatedAt: issue.updated_at as IsoDateTime,
      createdAt: issue.created_at as IsoDateTime,
    };
  }

  private getStatusType(status: string): 'backlog' | 'started' | 'completed' | 'canceled' {
    switch (status) {
      case 'backlog':
      case 'todo':
        return 'backlog';
      case 'in-progress':
      case 'reviewing':
        return 'started';
      case 'done':
        return 'completed';
      case 'canceled':
        return 'canceled';
      default:
        return 'started';
    }
  }

  private localStatusToUuid(status: string): string {
    const map = 
{'backlog': '00000000-0000-0000-0000-000000000001', 'todo': '00000000-0000-0000-0000-000000000002', 'in-progress': '00000000-0000-0000-0000-000000000003', reviewing: '00000000-0000-0000-0000-000000000004', done: '00000000-0000-0000-0000-000000000005', canceled: '00000000-0000-0000-0000-000000000006'};
return map[status as keyof typeof map] || '00000000-0000-0000-0000-000000000000';
  }

  getStatusCounts() {
    return this.db.getStats();
  }

  getActiveIssuesList() {
    return this.db.list({ sortBy: 'created_at', sortOrder: 'asc' });
  }

  close() {
    this.db.close();
  }
}

// Convert status name for user display
function convertStatusName(status: string): string {
  const map = 
{'backlog': 'Backlog', 'todo': 'Todo', 'in-progress': 'In Progress', reviewing: 'Reviewing', done: 'Done', canceled: 'Canceled'};
return map[status as keyof typeof map] || status.charAt(0).toUpperCase() + status.slice(1);
}

function getPriorityValue(priority: string): number {
  const map = 
{'highest': 4, high: 3, medium: 2, low: 1, lowest: 0};
return (map[priority as keyof typeof map] ?? 2) + 1; // Convert to Linear scale (1-4)
}

export default LocalIssuePoller;
