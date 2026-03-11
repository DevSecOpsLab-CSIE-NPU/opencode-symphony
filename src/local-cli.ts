#!/usr/bin/env bun

/**
 * Local Issue Dashboard CLI Tool
 * 
 * Command-line interface for managing issues without Linear dependency
 */

import { program } from 'commander';
import type { StatusType, PriorityType } from './src/local-backend/schemas.js';
import LocalIssueStore from './src/local-backend/store.js';

let store: LocalIssueStore;

function getStore() {
  if (!store) {
    store = new LocalIssueStore('/tmp/symphony-cli.db');
  }
  return store;
}

const statusOptions = ['backlog', 'todo', 'in-progress', 'reviewing', 'done', 'canceled'] as const;
const priorityOptions = ['lowest', 'low', 'medium', 'high', 'highest'] as const;

program
  .name('symphony-local')
  .description('Local issue management CLI - No Linear dependency needed')
  .version('1.0.0');

program
  .command('list')
  .description('List all issues with status and priority')
  .option('-s, --status <status>', 'Filter by status', statusOptions)
  .option('-p, --priority <priority>', 'Filter by priority', priorityOptions)
  .option('--all', 'Show all issues including completed/canceled')
  .action((options) => {
    const s = getStore();
    
    let issues = s.list({ 
      status: (options.status as StatusType | undefined),
      priority: (options.priority as PriorityType | undefined)
    });

    const countBefore = issues.length;
    if (!options.all) {
      issues = issues.filter(i => i.status !== 'completed' && i.status !== 'canceled');
    }

    console.log('\n=== SYMPHONY ISSUES ===\n');
    
    for (const issue of issues) {
      const statusColor = getStatusColor(issue.status);
      const priorityColor = getPriorityColor(issue.priority);
      
      console.log(`[${statusColor}${issue.key}[reset] [dim](${issue.status})[reset] | ${priorityColor}${issue.priority.toUpperCase()}[reset]`);
      console.log('  ' + issue.title);
      if (issue.description) {
        console.log('  [dim]' + issue.description + '[reset]');
      }
      console.log('');
    }

    console.log(`[${issues.length} issues found${countBefore !== issues.length ? ` (filtered from ${countBefore})` : ''}]\n`);
  });

program
  .command('create <title>')
  .description('Create a new issue')
  .option('-s, --status <status>', 'Initial status', 'todo')
  .option('-p, --priority <priority>', 'Priority level', 'medium')
  .option('-d, --description <text>', 'Issue description')
  .action((title, options) => {
    const s = getStore();
    
    const issue = s.create({
      title,
      description: options.description || '',
      status: options.status as StatusType,
      priority: options.priority as PriorityType,
      key: `SYM-${String(s.list().length + 1).padStart(3, '0')}`
    });

    console.log(`\n[${getPriorityColor(issue.priority)}Created issue ${issue.key}: ${issue.title}[reset]\n`);
  });

program
  .command('edit <id>')
  .description('Edit an issue by ID or key (e.g., SYM-001)')
  .option('-t, --title <text>', 'Update title')
  .option('-d, --description <text>', 'Update description')
  .option('-s, --status <status>', 'Update status', statusOptions)
  .option('-p, --priority <priority>', 'Update priority', priorityOptions)
  .action((id, options) => {
    const s = getStore();
    
    let issueId: string | null = null;
    let existing: any = null;

    // Try exact match first
    existing = s.get(id);
    if (existing) {
      issueId = existing.id;
    } else {
      // Try by key match
      const allIssues = s.list();
      const byKey = allIssues.find(i => i.key === id);
      if (byKey) {
        issueId = byKey.id;
        existing = byKey;
      }
    }

    if (!issueId) {
      console.log(`\n[${getPriorityColor('canceled')}Error: Issue ${id} not found[reset]\n`);
      return;
    }

    const updates: any = {};
    if (options.title !== undefined && options.title.length > 0) updates.title = options.title;
    if (options.description !== undefined && options.description.length > 0) updates.description = options.description;
    if (options.status?.[0] && statusOptions.includes(options.status[0])) updates.status = options.status[0];
    if (options.priority?.[0] && priorityOptions.includes(options.priority[0])) updates.priority = options.priority[0];

    const updated = s.update(issueId, updates);
    
    if (updated) {
      console.log(`\n[${getPriorityColor('high')}Updated ${updated.key}: ${updated.title}[reset]\n`);
    }
  });

program
  .command('delete <id>')
  .description('Delete an issue by ID or key')
  .action((id) => {
    const s = getStore();
    
    let issueId: string | null = null;
    let existing: any = null;

    // Try exact match first
    existing = s.get(id);
    if (existing) {
      issueId = existing.id;
    } else {
      // Try by key match
      const allIssues = s.list();
      const byKey = allIssues.find(i => i.key === id);
      if (byKey) {
        issueId = byKey.id;
        existing = byKey;
      }
    }

    if (!issueId) {
      console.log(`\n[${getPriorityColor('canceled')}Error: Issue ${id} not found[reset]\n`);
      return;
    }

    s.delete(issueId);
    console.log(`\n[${getPriorityColor('high')}Deleted issue ${existing.key}: ${existing.title}[reset]\n`);
  });

program
  .command('stats')
  .description('Display dashboard statistics')
  .action(() => {
    const s = getStore();
    
    const stats = s.getStats();
    const counts = JSON.stringify(stats.counts, null, 2);
    
    console.log(`\n=== SYMPHONY DASHBOARD STATS ===`);
    console.log('Total Issues:', stats.total);
    console.log('Active:', stats.active);
    console.log('Completed:', stats.completed);
    console.log('Status Distribution:', counts);
    console.log('');
  });

program
  .command('activity [issue_id]')
  .description('Show activity log, optionally for specific issue')
  .action((issueId) => {
    const s = getStore();
    
    let logs = s.getActivityLog(issueId);
    
    if (logs.length === 0) {
      console.log('\nNo activity logs found.\n');
      return;
    }

    console.log('\n=== ACTIVITY LOG ===\n');
    for (const log of logs.slice(0, 50)) {
      const time = new Date(log.createdAt).toLocaleTimeString();
      console.time(`[${time}] ${log.action}:`);
    }
    console.log('');
    
    // Actually output the logs properly
    console.log('\n=== ACTIVITY LOG ===\n');
    for (const log of logs.slice(0, 50)) {
      const time = new Date(log.createdAt).toLocaleTimeString();
      console.log(`[${time}] ${log.action.padEnd(20)} ${log.description}`);
    }
    console.log('');
  });

// Helper function to get status color
function getStatusColor(status: string): string {
  const colors: Record<string, string> = 
{'backlog': 'gray', 'todo': 'yellow', 'in-progress': 'blue', reviewing: 'cyan', done: 'green', canceled: 'red'};
return colors[status] || 'white';
}

// Helper function to get priority color
function getPriorityColor(priority: string): string {
  const colors = 
{'highest': 'brightRed', 'high': 'red', 'medium': 'yellow', low: 'gray', lowest: 'dim'};
return colors[priority] || 'white';
}

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

program.parse(process.argv);
