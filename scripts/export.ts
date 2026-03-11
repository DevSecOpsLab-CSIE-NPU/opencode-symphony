#!/usr/bin/env bun

/**
 * Export Analytics to JSON/CSV
 */

import type { Issue, StatusType } from '../src/local-backend/schemas.js';
import LocalIssueStore from '../src/local-backend/store.js';

const store = new LocalIssueStore();

function exportToJSON() {
  console.log('=== Exporing Issues to JSON ===\n');
  
  const allIssues = store.list({ sortBy: 'created_at', sortOrder: 'desc' });
  const stats = store.getStats();
  
  const exportData = {
    exportedAt: new Date().toISOString(),
    statistics: stats,
    issues: allIssues
  };

  console.log(JSON.stringify(exportData, null, 2));
}

function exportToCSV() {
  console.log('=== Exporting to CSV ===\n');
  
  const headers = ['Key', 'Status', 'Priority', 'Title', 'Description', 'Created At'];
  console.log(headers.join(','));
  
  const issues = store.list({ sortBy: 'created_at', sortOrder: 'desc' });
  
  for (const issue of issues) {
    const row = [
      issue.key,
      issue.status,
      issue.priority,
      issue.title.replace(/,/g, ' '),
      (issue.description || '').replace(/,/g, ' '),
      new Date(issue.createdAt).toLocaleString()
    ];
    console.log(row.join(','));
  }
  
  console.log(`\nExported ${issues.length} issues to CSV format\n`);
}

function exportStats() {
  console.log('=== Dashboard Statistics ===\n');
  
  const stats = store.getStats();
  
  const tableData = [
    ['Metric', 'Value'],
    ['Total Issues', `${stats.total}`],
    ['Active (Todo/In Progress)', `${stats.active}`],
    ['Completed (Done)', `${stats.completed}`],
    ['Status Distribution', JSON.stringify(stats.counts, null, 2)],
  ];

  for (const row of tableData) {
    const label = row[0].padEnd(25);
    const value = typeof row[1] === 'object' 
      ? JSON.stringify(row[1], null, 2).split('\n').map((line, i) => i === 0 ? ` ${line}` : `   ${line}`).join('\n')
      : row[1];
    console.log(`${label}${value}`);
  }

  console.log('');
}

// CLI arguments
const args = process.argv.slice(2);
const command = args[0] || 'all';

switch (command) {
  case 'json':
    exportToJSON();
    break;
  case 'csv':
    exportToCSV();
    break;
  case 'stats':
    exportStats();
    break;
  default:
    console.log('📊 Local Issue Dashboard Export Tool\n');
    console.log('Usage: bun export.ts [command]');
    console.log('\nCommands:');
    console.log('  json   - Export full data to JSON');
    console.log('  csv    - Export issues to CSV format');
    console.log('  stats  - Display dashboard statistics\n');
    
    exportToJSON();
    console.log('\n' + '='.repeat(50) + '\n');
    exportStats();
}
