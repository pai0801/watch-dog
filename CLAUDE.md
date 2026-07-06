# Watch-Dog

---

## Dev 啟動

\`\`\`bash
# 只啟動本地服務 (http://192.168.1.200:8789)
DEV_PORT=8789 ./dev-tunnel.sh

# 啟動 + ngrok tunnel
DEV_PORT=8789 ./dev-tunnel.sh ngrok

# 停止服務
./dev-tunnel.sh stop
\`\`\`

### 環境

| 項目 | 值 |
|------|-----|
| **Port** | 8789 |
| **Network URL** | http://192.168.1.200:8789 |

---

## 專案資訊

- **GitHub**: git@github.com:paipeter0801/watch-dog.git


## Dev Brain (Development Experience Database)

You have access to the `dev-brain` MCP server — a shared knowledge base of development experiences.

**Mandatory behaviors:**

1. **When you encounter a bug, error, or performance issue:** Call `search_experience` with a description of the problem BEFORE attempting to fix it. Learn from past solutions.

2. **After you successfully solve a non-trivial problem:** Call `record_experience` to save what you learned. Include a clear problem description, the solution, relevant tags, and context.

3. **Tags should be lowercase and specific:** e.g., `["bugfix", "python", "flask"]`, `["perf", "sql", "postgresql"]`, `["refactor", "react"]`

**When in doubt, record it.** It is better to have too many experiences than to lose institutional knowledge.
