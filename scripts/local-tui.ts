#!/usr/bin/env bun

import TUIIssueDashboard from '../src/tui/dashboard.js';

async function main() {
  console.log('\n[green]🚀 Starting Symphony Local Issue Dashboard [reset]\n');
  console.log('[bold]Vim-style keyboard shortcuts:[/bold]');
  console.log('  j/k - Navigate up/down');
  console.log('  Tab - Switch views (List/Kanban/Timeline)');
  console.log('  c   - Create new issue');
  console.log('  e   - Edit selected issue');
  console.log('  d   - Delete selected issue');
  console.log('  Esc - Exit/Cancel\n');

  const dashboard = new TUIIssueDashboard();
  dashboard.render();
}

main().catch(console.error);
