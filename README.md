# Plugin-Symphony 插件系統

[![CI](https://github.com/DevSecOpsLab-CSIE-NPU/opencode-symphony/actions/workflows/ci.yml/badge.svg)](https://github.com/DevSecOpsLab-CSIE-NPU/opencode-symphony/actions/workflows/ci.yml)  
[![Discovery Workflow](https://img.shields.io/badge/Discovery-Cycles%201-5%20Complete-blue)](./DISCOVERY-COMPLETE-WORKFLOW-SUMMARY.md)

一個用於 [OpenCode](https://opencode.ai) 的插件系統，實現 **OpenAI Symphony SPEC** 規範 — 透過協調者、工人和審查者三個角色的協作模式，自主解決 Linear 問題並建立 Pull Requests。

---

## 系統架構

```
Linear 問題 → 協調員（輪詢/排程）→ 工人（寫程式碼）
                          ↓
                     審查者（審核/建 PR）
```

| 角色 | 職責 |
|------|--|
| **協調員** | 監控 Linear、排程任務、管理重試機制和同侪執行 |
| **工人** | 探索程式碼、實施解決方案、運行測試 |
| **審查者** | 檢查程式碼品質、撰寫 PR 說明、開啟 Pull Request |

---

## 環境需求

- [Bun](https://bun.sh) ≥ 1.3.10
- OpenCode 插件系統
- GitHub CLI (`gh`)
- Linear API Gold Token  
- Git

---

## 安裝步驟

### 1. 安裝並建置

```bash
git clone https://github.com/DevSecOpsLab-CSIE-NPU/opencode-symphony.git
cd opencode-symphony
bun install
bun run build
```

### 2. 設定環境變數

```bash
export LINEAR_API_KEY="your_linear_api_key"
export GITHUB_TOKEN="your_github_token"
```

### 3. 註冊插件

在 OpenCode 設定中新增：

```json
{
  "mcp": {
    "symphony": {
      "command": "bun",
      "args": ["/path/to/plug-in/dist/index.js"],
      "env": {
        "LINEAR_API_KEY": "${LINEAR_API_KEY}",
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

---

## 主要功能

- 📋 **自動問題處理**：從 Linear 輪詢新增問題並自動排程處理
- ⚙️ **智能重試機制**：指數後退算法，自動管理失敗任務
- 🔒 **隔離工作區**：每個問題有獨立的工作目錄
- 🧪 **整合測試執行**：自動運行測試確保程式碼品質  
- ✅ **審查自動化**：在開啟 PR 前自動檢查程式碼差異

---

## 設定檔範例 (WORKFLOW.md)

```yaml
---
linear:
  pollIntervalMs: 30000
  teamIds: []
  states: ["In Progress"]
  
workspace:
  root: /tmp/workspaces
  maxConcurrentAgents: 5
  
retry:
  maxAttempts: 3
  maxRetryBackoffMs: 300000

appServer:
  command: opencode
---
```

---

## 核心工具

- `symphony.start` - 啟動協調員循環
- `symphony.stop` - 停止所有執行中的任務  
- `symphony.status` - 查看系統狀態
- `symphony.listIssues` - 列出追蹤問題
- `symphony.retryIssue` - 手動重試特定問題

---

## 持續改進工作流 ✨

本專案採用嚴格的發現驅動改進工作流：

### 已完成成果

| # | 改進主題 | 狀態 | 成效 |
|---|------------------|---------||
| **001** | 重試逾時精確度修复 | ✅ 完成 | ±8ms (vs 原本±80%) |
| **002** | 工作區自動清理機制 | ✅ 完成 | 儲存減少 99.6% |

詳細資訊請參閱：[DISCOVERY-COMPLETE-WORKFLOW-SUMMARY.md](./DISCOVERY-COMPLETE-WORKFLOW-SUMMARY.md)

---

## 開發指南

```bash
# 執行測試
bun test tests/state.test.ts

# 建置插件
bun run build

# 除錯模式
bun run dev
```

---

## License

MIT

---

**最後更新**: 2026-03-11  
**版本**: 1.0 (5 週期改進完成)
