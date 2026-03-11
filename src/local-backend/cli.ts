import { program } from 'commander';
import LocalIssueDB, { type StatusType, type PriorityType } from './database.js';
import { STATUS_COLORS, PRIORITY_COLORS } from './schemas.js';

let db: LocalIssueDB;

function initDB() {
  if (!db) {
    db = new LocalIssueDB('/tmp/symphony-local-issues.db');
  }
  return db;
}

program
  .name('symphony-local')
  .description('Local issue management for Symphony (no Linear required)')
  .version('1.0.0');

program
  .command('list')
  .description('List all issues with status and priority')
  .option('-s, --status <status>', 'Filter by status', ['backlog', 'todo', 'in-progress', 'reviewing', 'done', 'canceled'])
  .option('-p, --priority <priority>', 'Filter by priority', ['lowest', 'low', 'medium', 'high', 'highest'])
  .action((options) => {
    db = initDB();
    
    const issues = db.list({ 
      status: options.status?.[0] as StatusType | undefined,
      priority: options.priority?.[0] as PriorityType | undefined
    });

    console.log('\n===== SYMPHONY ISSUES =====\n');
    for (const issue of issues) {
      const color = STATUS_COLORS[issue.status as keyof typeof STATUS_COLORS];
      const priorityColor = PRIORITY_COLORS[issue.priority as keyof typeof PRIORITY_COLORS];
      
      console.log(`[${color}[m${issue.key} [dim](${issue.status}) [reset] | ${priorityColor}${issue.priority}[reset]`);
      console.log('  ' + issue.title);
      if (issue.description) {
        console.log('  ' + issue.description);
      }
      console.log('');
    }
    db.close();
  });

program
  .command('create <title>')
  .description('Create a new issue')
  .option('-s, --status <status>', 'Initial status', 'todo')
  .option('-p, --priority <priority>', 'Priority level', 'medium')
  .option('-d, --description <text>', 'Issue description')
  .action((title, options) => {
    db = initDB();
    
    const issue = db.create({
      title,
      description: options.description || '',
      status: options.status as StatusType,
      priority: options.priority as PriorityType,
      key: `SYM-${String(db.list().length + 1).padStart(3, '0')}`
    });

    console.log(`\n[green]Created issue ${issue.key}: ${issue.title}[reset]\n`);
    db.close();
  });

program
  .command('edit <id>')
  .description('Edit an issue by ID or key')
  .option('-t, --title <text>', 'Update title')
  .option('-d, --description <text>', 'Update description')
  .option('-s, --status <status>', 'Update status', ['backlog', 'todo', 'in-progress', 'reviewing', 'done', 'canceled'])
  .option('-p, --priority <priority>', 'Update priority', ['lowest', 'low', 'medium', 'high', 'highest'])
  .action((id, options) => {
    db = initDB();
    
    const existing = db.get(id);
    if (!existing) {
      console.log(`[red]Error: Issue ${id} not found [reset]\n`);
      return;
    }

    const updates: any = {};
    if (options.title !== undefined) updates.title = options.title;
    if (options.description !== undefined) updates.description = options.description;
    if (options.status?.[0]) updates.status = options.status[0] as StatusType;
    if (options.priority?.[0]) updates.priority = options.priority[0] as PriorityType;

    const updated = db.update(id, updates);
    console.log(`\n[green]Updated ${updated.key}: ${updated.title}[reset]\n`);
    db.close();
  });

program
  .command('delete <id>')
  .description('Delete an issue by ID or key')
  .action((id) => {
    db = initDB();
    
    const existing = db.get(id);
    if (!existing) {
      console.log(`[red]Error: Issue ${id} not found [reset]\n`);
      return;
    }

    db.delete(id);
    console.log(`\n[green]Deleted issue ${existing.key}: ${existing.title}[reset]\n`);
    db.close();
  });

program
  .command('stats')
  .description('Display dashboard statistics')
  .action(() => {
    db = initDB();
    
    const stats = db.getStats();
    const counts = JSON.stringify(stats.counts, null, 2);
    
    console.log(`\n===== SYMPHONY DASHBOARD STATS =====`);
    console.log(`Total Issues: ${stats.total}`);
    console.log(`Active: ${stats.active} | Completed: ${stats.completed}`);
    console.log('Status distribution:', counts);
    console.log('');
    db.close();
  });

program
  .command('activity [issue_id]')
  .description('Show activity log, optionally for specific issue')
  .action((issueId) => {
    db = initDB();
    
    const logs = db.getActivityLog(issueId);
    
    if (logs.length === 0) {
      console.log('\nNo activity logs found.\n');
      return;
    }

    console.log('\n===== ACTIVITY LOG =====\n');
    for (const log of logs) {
      const time = new Date(log.created_at).toLocaleTimeString();
      console.log(`[${time}] ${log.action}: ${log.description}`);
    }
    console.log('');
    db.close();
  });

program.parse(process.argv);

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
