import blessed from 'blessed';
import type { Issue, StatusType, PriorityType } from '../local-backend/schemas.js';
import LocalIssueDB from '../local-backend/database.js';

// Terminal UI Issue Dashboard - Vim/OpenCode 風格快捷鍵
// m = move (drag-d) | c = create | e = edit | d = delete | tab = switch view | q = quit

const SCREEN_WIDTH = process.stdout.columns || 80;
const SCREEN_HEIGHT = Math.min(process.stdout.rows || 24, 60);

class TUIIssueDashboard {
  private screen;
  private db: LocalIssueDB;
  private selectedView: 'list' | 'kanban' | 'timeline' = 'list';
  private cursorIndex = 0;
  private listData: Issue[] = [];
  private kanbanColumns = ['backlog', 'todo', 'in-progress', 'reviewing', 'done', 'canceled'];
  private currentColumn = 0;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
    });

    this.db = new LocalIssueDB('/tmp/symphony-local-issues.ui');
    
    // Create layouts
    this.createTitleBar();
    this.createViews();
    this.createStatusBar();
    this.createKeybindingsHelp();

    // Start with List view
    this.renderListView();
    this.loadIssues();

    // Event handling
    this.screen.key(['c', 'escape', 'q', 'Ctrl+c'], () => {
      this.onQuit();
    });

    this.screen.key(['Tab'], () => {
      this.cycleViews();
    });

    this.screen.key(['j'], () => {
      this.moveCursor('down');
    });

    this.screen.key(['k'], () => {
      this.moveCursor('up');
    });

  }

  private createTitleBar() {
    const title = blessed.listitem({
      top: 0,
      width: '100%',
      height: 1,
      label: '[magenta]🎯 Symphony Dashboard [yellow](Vim-Style TUI)[white] Tab=j/k to switch views',
      tags: true,
    });
    
    this.screen.append(title);
  }

  private createViews() {
    // Container for all views
    const container = blessed.box({
      top: 2,
      bottom: 3,
      left: 0,
      width: '100%',
      height: '-4',
      padding: 1,
    });

    // List View
    this.listView = blessed.table({
      parent: container,
      label: '[bold]List View [white]</>',
      labels: true,
      data: [['Key', 'Status', 'Priority', 'Title']],
      keys: true,
      bold: true,
      width: 1,
      height: 1,
    });

    // Kanban Board View (hidden by default)
    this.kanbanView = blessed.box({
      parent: container,
      label: '[bold]Kanban Board [white]</>',
      keys: true,
      width: '100%',
      height: 'shrink',
      hidden: true,
    });

    // Timeline View (hidden by default) 
    this.timelineView = blessed.box({
      parent: container,
      label: '[bold]Activity Timeline [white]</>',
      keys: true,
      width: '100%',
      height: 'shrink',
      hidden: true,
    });

    this.screen.append(container);
  }

  private createStatusBar() {
    const statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
    });

    this.screen.append(statusBar);

    // Key bindings help panel (bottom-left)
    const keyHelp = blessed.list({
      parent: statusBar,
      top: 0,
      left: 0,
      width: '50%',
      height: 1,
      label: '[dim]j/k navigate | c=create | e=edit | d=delete | tab=switch view',
      tags: true,
    });

    this.screen.append(keyHelp);

    // Stats indicator (bottom-right)
    const keyHelp2 = blessed.list({
      parent: statusBar,
      top: 0,
      left: '50%',
      width: '50%',
      height: 1,
      align: 'right',
      label: '[white]Total: 0 | Todo: 0 | Done: 0',
      tags: true,
    });

    this.screen.append(keyHelp2);
    this.statusBar = { keyHelp, keyHelp2 };
  }

  private createKeybindingsHelp() {
    const helpBox = blessed.box({
      top: '75%',
      left: 0,
      width: '100%',
      height: 1,
      border: {
        type: 'line',
      },
      label: '[bold]Vim OpenCode Keybindings</>',
    });

    this.screen.append(helpBox);
  }

  private loadIssues() {
    const issues = this.db.list({ sortBy: 'created_at', sortOrder: 'desc' });
    this.listData = issues;
    
    // Update list view
    if (this.listView) {
      this.renderListView();
      this.updateStatusBar();
    }

    if (selectedView === 'kanban') {
      this.renderKanban();
    } else if (this.selectedView === 'timeline') {
      this.renderTimeline();
    }
  }

  private renderListView() {
    const rows = [['Key', 'Status', 'Priority', 'Title']];
    
    for (const issue of this.listData) {
      const statusColor = getStatusColor(issue.status);
      const priorityColor = getPriorityColor(issue.priority);
      
      rows.push([
        issue.key,
        `[${statusColor}${issue.status}[white]`,
        `[${priorityColor}${issue.priority.toUpperCase()}[reset]`,
        `${this.cursorIndex === this.listData.indexOf(issue) ? '▶' : ' '} ${issue.title}`,
      ]);
    }

    this.listView.setData(rows);
    this.cursorIndex = 0;
  }

  private renderKanban() {
    const board = blessed.box({
      top: 2,
      left: 0,
      width: '100%',
      height: 'shrink',
      tags: true,
    });

    const headers = ['Backlog', 'Todo', 'In Progress', 'Done'];
    board.setLabel(`[bold]Kanban View - Columns: ${headers.join(' | ')} `);

    this.screen.append(board);

    // Render columns with issues
    let colIndex = 0;
    for (const header of headers) {
      const colContent = [`${header}\n`];
      
      for (const issue of this.listData) {
        if (issue.status === getKanbanStatus(header)) {
          colContent.push(`  • ${issue.key}: ${issue.title} [gray](${issue.priority})[reset]\n`);
        }
      }

      const col = blessed.box({
        label: `${colIndex === this.currentColumn ? '▶' : ' '}${header}\n`,
        width: headers.length > 3 ? 20 : 25,
        height: 'shrink',
        padding: 1,
      });

      col.append(colContent);
      board.append(col);
    }
  }

  private renderTimeline() {
    const logs = this.db.getActivityLog();
    
    if (logs.length === 0) {
      this.timelineView.setContent('No activity records yet.\n');
      return;
    }

    let content = '[bold]Activity Log[/]\n\n';
    for (const log of logs.slice(0, 20)) {
      const time = new Date(log.created_at).toLocaleTimeString();
      content += `[${time}] [dim]>${log.action}:[reset] ${log.description}\n`;
      this.timelineView.append(content);
    }
    
    const footer = `\n[gray]Total records: ${logs.length}`;
    this.timelineView.append(footer);
  }

  private onTab() {
    this.cycleViews();
  }

  private cycleViews() {
    const views = ['list', 'kanban', 'timeline'] as const;
    const currentIndex = views.indexOf(this.selectedView);
    const nextIndex = (currentIndex + 1) % views.length;
    
    this.selectedView = views[nextIndex];
    this.reloadView();
  }

  private reloadView() {
    // Hide all views first
    if (this.listView) this.listView.hidden = true;
    if (this.kanbanView) this.kanbanView.hidden = true;
    if (this.timelineView) this.timelineView.hidden = true;

    // Show current view
    if (!this.selected) {
      this.loadIssues();
    } else if (this.selected === 'list') {
      this.renderListView();
      this.listView.hidden = false;
    } else {
      this.loadIssues();
    }

    this.screen.render();
  }

  private moveCursor(direction: 'up' | 'down') {
    const totalItems = this.listData.length;
    
    if (totalItems === 0) return;

    if (direction === 'down') {
      if (this.cursorIndex < totalItems - 1) {
        this.cursorIndex++;
      } else {
        this.cursorIndex = 0; // Loop back to top
      }
    } else {
      if (this.cursorIndex > 0) {
        this.cursorIndex--;
      } else {
        this.cursorIndex = totalItems - 1; // Loop to bottom
      }
    }

    this.renderListView();
    this.screen.render();
  }

  private onQuit() {
    console.log('\n[green]Quitting TUI Dashboard [reset]\n');
    this.db.close();
    process.exit(0);
  }

  private updateStatusBar() {
    const stats = this.db.getStats();
    const total = stats.total;
    const todo = stats.counts.todo || 0;
    const done = (stats.counts.done || 0) + (stats.counts.canceled || 0);
    
    this.screen.children[this.screen.children.length - 2].setLabel(`[dim]j/k navigate | c=create | e=edit | d=delete | tab=switch view`);
    this.screen.children[this.screen.children.length - 1].setLabel(`[yellow]Total: ${total} [white]| Todo: ${todo} [white]| Done: ${done}`);
  }

  public render() {
    const screen = blessed.screen({
      autoExit: true,
    });

    // Create main layout elements here
    this.render();
    
    this.screen.loadKeyBindings();
    this.renderListView();
    this.updateStatusBar();
    
    this.screen.render();
  }
}

// Status color helper
function getStatusColor(status: string): string {
  const colors: Record<string, string> = 
{'backlog': 'gray', 'todo': 'yellow', 'in-progress': 'blue', reviewing: 'cyan', done: 'green', canceled: 'red'};
return colors[status] || 'white';
}

// Priority color helper function
function getPriorityColor(priority: string): string {
  const colors =
  {'highest': 'brightRed', 'high': 'red', 'medium': 'yellow', low: 'gray', lowest: 'dim'};
return colors[priority] || 'white';
}

// Kanban column status mapping function
function getKanbanStatus(name: string): StatusType {
  const map = {'Backlog': 'backlog', 'Todo': 'todo', 'In Progress': 'in-progress', Done: 'done'};
return map[name as keyof typeof map] || 'todo';
}

// Main entry point
const dashboard = new TUIIssueDashboard();
dashboard.render();
export default TUIIssueDashboard;
