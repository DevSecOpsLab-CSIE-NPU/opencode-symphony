# Symphony Local Issue Dashboard 🎯

本地問題管理系統 - **無需 Linear，完全自主控制**

## 📋 功能特色

- ✅ **交互式 Terminal UI (TUI)** - Vim/OpenCode 風格的快捷鍵操作
- ✅ **多視圖切換**：List | Kanban Board | Activity Timeline
- ✅ **即時更新** - WebSocket 驅動的实时状态同步
- ✅ **完整 CRUD** - 創建/編輯/刪除/過濾/排序所有功能
- ✅ **數據存儲** - SQLite 數據庫，本地持久化
- ✅ **導出功能** - 支援 JSON/CSV 格式匯出手冊和統計

## 🚀 快速開始

### 安裝依賴

```bash
cd /home/fychao/plugin-symphony/opencode-symphony

# TUI 工具箱
bun add blessed ink commander better-sqlite3
```

### 使用命令列工具 (CLI)

#### 列出所有問題

```bash
npx tsx dist/local-cli.js list

# 過濾特定狀態
npx tsx dist/local-cli.js list -s todo

# 過濾優先級
npx tsx dist/local-cli.js list -p high
```

#### 創建新問題

```bash
npx tsx dist/local-cli.js create "實現儀表板 UI" \
  --status=todo \
  --priority=high \
  --description="建立交互式 TUI 界面，支援 Vim 風格快捷鍵操作"
```

#### 編輯問題

```bash
# 使用 ID 或 Key (SYM-001)
npx tsx dist/local-cli.js edit SYM-001 -t "更新標題" -s in-progress
```

#### 刪除問題

```bash
npx tsx dist/local-cli.js delete SYM-001
```

#### 查看統計

```bash
npx tsx dist/local-cli.js stats
```

#### 活動記錄

```bash
# 所有行動記錄
npx tsx dist/local-cli.js activity

# 特定問題的記錄
npx tsx dist/local-cli.js activity SYM-001
```

## 🎮 Terminal UI Dashboard (交互式介面)

### 啟動 TUI

```bash
npx local-tui
```

### ⌨️ 快捷鍵操作 (Vim/OpenCode 風格)

#### 主要功能鍵

| 健位 | 功能 | 說明 |
|------|------|----|
| `j` / `k` | **上下移動** | 選取不同項目 |
| `h` / `l` | **左右移動** | 切換視圖/面板 |
| `gg` | **跳至開頭** | 快速回到頂部 |
| `G` | **跳至結尾** | 立即查看最後一筆 |
| `/` | **搜尋過濾** | 文字搜尋功能 |
| `Esc` | **退出/取消** | 退回到上層視圖 |

#### CRUD 操作

| 健位 | 功能 | 說明 |
|------|------|----|
| `c` | **創建 (Create)** | 建立新問題 |
| `e` | **編輯 (Edit)** | 修改現有項目 |
| `d` | **刪除 (Delete)** | 刪除選中項目 |
| `Enter` | **查看詳情** | 切換至詳情視圖 |

#### 視圖導航

| 健位 | 功能 | 說明 |
|------|------|----|
| `Tab` | **切換視圖** | List → Kanban → Timeline |
| `1` | **List View** | 列表視圖 (預設) |
| `2` | **Kanban Board** | 看板視圖 (按狀態分組) |
| `3` | **Timeline** | 活動時間軸 |

#### 過濾器操作

| 鍵位 | 功能 | 說明 |
|------|------|----|
| `F` | **快速過濾** | 按下後輸入關鍵字 |
| `Shift+Tab` | **清除過濾** | 返回完整列表 |
| `Sort` | **排序切換** | 按創建時間/標題/狀態排序 |

### 🎨 視圖說明

#### 1️⃣ List View (List)

- **預設顯示所有活躍問題**
- 彩色標記：**黃色=todo / 藍色=in-progress / 綠色=done**
- 可選按優先級排序：`Highest → High → Medium → Low`

#### 2️⃣ Kanban Board

```
| Backlog | In Progress | Done | Canceled |
+---------+-------------+------+----------+
| SYM-003 | SYM-001     | ...  | ...      |
|         |             |      |          |
| SYM-007 | SYM-015     |      |          |
```

- **鍵盤操作**：
  - `j/k` - 在列中上下移動
  - `h/l` - 在不同列之間切換
  - `d` - 拖曳 (drag-d) 問題到另一列
  - `t` - 直接更狀態

#### 3️⃣ Activity Timeline

- **時間軸視圖**，按順序展示所有操作記錄
- 支援過濾特定問題的活動
- 可導出活動歷史供審計用途

## 📦 導出功能

### 匯出 JSON (完整數據)

```bash
cp /tmp/symphony-local-issues.db symphony_issues_backup.json
bun tools/export-to-json.ts
```

### 匯出 CSV (統計報告)

```bash
bun tools/export-stats.ts --format=csv --output=stats.csv
```

## 🗄️ 數據庫架構

本專案使用 SQLite 進行本地存儲：

```sql
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,      -- UUID
  key TEXT UNIQUE NOT NULL, -- e.g., "SYM-001"
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  
  CHECK (status IN ('backlog', 'todo', 'in-progress', 'reviewing', 'done', 'canceled')),
  CHECK (priority IN ('lowest', 'low', 'medium', 'high', 'highest'))
);

-- Activity log for timeline view
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  action TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);
```

## 🔧 與 OpenCode 整合

### Step 1: 使用本地後端替代 Linear

編輯 `WORKFLOW.md`，移除 Linear 依賴：

```yaml
linear:
  # 移除或註解掉此處的配置
  pollIntervalMs: 0  # 不輪詢外部服務

workspace:
  root: /tmp/symphony-workspaces
  maxConcurrentAgents: 3

# ...其他配置保持不變
```

### Step 2: TUI Dashboard 作為任務管理介面

1. **啟動 TUI dashboard**：`npx local-tui`
2. **在另一終端運行 orchestrator**：
   ```bash
   bun run src/index.ts start
   ```
3. **透過 TUI 創建新問題** → Orchestrator 自動監聽新增任務
4. **查看狀態更新和活動記錄**

### Step 3: 自訂 MCP Tools (進階)

添加 `symphony-local-issues` tool：

```typescript
// src/local-mcp/index.ts
export const tools = [
  {
    name: 'create-local-issue',
    description: 'Create a new issue in local dashboard',
    inputSchema: z.object({
      title: z.string(),
      description: z.string().optional(),
      status: z.enum(['backlog', 'todo', 'in-progress']),
      priority: z.enum(['low', 'medium', 'high']),
    }),
  },
  // ...更多工具
];
```

## 📚 文件結構

```
opencode-symphony/
├── src/local-backend/
│   ├── schemas.ts          # 數據庫 Schema 定義
│   ├── database.ts         # SQLite CRUD operations
│   └── cli.ts              # CLI tool (symphony-local)
├── scripts/local-tui.ts    # Interactive Dashboard
├── WORKFLOW.md             # Workflow configuration
└── README.md               # This file
```

## 🔄 快速遷移自 Linear

1. **停止 Linear polling**:
   ```yaml
   linear:
     pollIntervalMs: 0  # <- 設置為 0 來禁用
   ```

2. **初始化本地數據庫** (首次運行)：
   ```bash
   npx tsx dist/local-cli.js create "遷移任務" -s todo -p high
   ```

3. **手動創建初始問題列表**:
   ```bash
   npx tsx dist/local-cli.js list | xargs -L1 echo "Running: ..."
   # 或者使用批量導入腳本
   bun tools/import-from-linear.ts
   ```

4. **驗證工作流運行**：
   ```bash
   # Start orchestrator in one terminal
   bun run src/index.ts start
   
   # View dashboard in another
   npx local-tui
   ```

## 💡 最佳實踐

### 捷徑組合

- `gg` + `j/k` - **快速定位特定項目的列表位置**
- `Tab` → `F` → `/keyword` - **搜尋過濾特定關鍵字問題**
- `q` - **退出 TUI 界面** (標準退出鍵)

### UI 設計原則

- **顏色可視化**: Status-based color coding, priority-based highlighting
- **鍵盤優先**: 最小化滑鼠操作，提高效率
- **即時反饋**: Toast notification on create/edit/delete actions
- **多視圖切換**: List / Kanban / Timeline 快速切換

## 🤝 貢獻指南

### 新增快捷鍵功能

```typescript
// src/tui/key-bindings.ts
const bindings = {
  'j': () => moveCursor('down'),
  'k': () => moveCursor('up'),
  'c': () => openCreateModal(),
  'Escape': () => closeModal(), // ESC to close modal, also for back navigation
  // ...其他捷徑
};

export async function handleKey(key) {
  const handler = bindings[key];
  if (handler && typeof handler === 'function') {
    await handler();
  }
}
```

### 新增視圖模式

編輯 `src/tui/views.ts`，新增新的 `ViewComponent`:

```typescript
const views: Record<string, ViewComponent> = {
  list: ListView,
  kanban: KanbanBoard,
  timeline: ActivityTimeline,
  settings: SettingsPanel, // New view
};
```

## 📝 License

MIT License - See LICENSE file for details.

---
**版本**: v1.0 | 更新日期：2026-03-10