# CIAS - 协同研判自动化系统

> **版本**: V1.5.0 | **架构**: Cloudflare Workers + Supabase | **方案**: 纯数学规则引擎（无 LLM）

---

## 快速开始

### 1. 环境要求

- Node.js 18+
- Cloudflare 账户
- Supabase 账户
- API-Football Key（RapidAPI 或直连）

### 2. 初始化

```bash
git clone https://github.com/amrglacier/cias.git
cd cias
npm install

# 复制环境变量模板
cp .env.example .dev.vars
# 编辑 .dev.vars 填入真实的 API Key
```

### 3. 本地开发

```bash
# 启动后端 Worker（localhost:8787）
npm run dev

# 运行测试
npm test

# 类型检查
npm run type-check
```

### 4. 部署

```bash
# 部署后端 Worker（首次需设置 Secrets）
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put API_FOOTBALL_KEY
npx wrangler secret put ODDS_API_KEY
npx wrangler secret put ADMIN_API_KEY

npm run deploy

# 部署前端（Cloudflare Pages）
cd frontend
node scripts/build-worker.js  # 生成 _worker.js
npx wrangler pages deploy . --project-name=cias-worker
```

---

## 项目概述

CIAS（Collaborative Intelligence Analysis System）是一个足球赛事量化预测系统，基于 13 个因子（F1-F13）的数学模型，通过贝叶斯平滑和纯规则引擎进行赛前预测。

**核心特性**:
- 自动采集五大联赛赛程、球队统计、伤病、裁判信息
- 贝叶斯平滑处理对手强度调整
- 纯数学公式计算预测结果（主推 + 备选）
- 每 30 分钟采集赔率快照，检测 Sharp/Steam 信号
- 赛后自动复盘归因，持续迭代因子权重
- 移动优先的响应式 Web 界面

**技术栈**:
| 层级 | 技术 |
|:---|:---|
| 后端 | Cloudflare Workers + TypeScript |
| 数据库 | Supabase (PostgreSQL) |
| 前端 | Cloudflare Pages (HTML + Pages Functions) |
| 测试 | Vitest (45 个单元测试) |

---

## 系统架构

```
┌──────────────────┐
│ Cloudflare Pages │ ← 前端 (mobile-first)
│ frontend/        │
└────────┬─────────┘
         │ /api/* (代理)
┌────────▼─────────┐
│ Cloudflare Worker│ ← 后端 (Cron + API)
│ src/             │
└────────┬─────────┘
         │
┌────────▼─────────┐
│ Supabase         │ ← 数据存储
│ PostgreSQL       │
└──────────────────┘
```

---

## API 认证

从 V1.5.0 开始，所有写操作（POST/PUT/DELETE）需要 Bearer Token 认证：

```bash
curl -X POST https://<your-worker>/api/config/betting-window \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{...}'
```

通过 `wrangler secret put ADMIN_API_KEY` 设置管理密钥。

---

## 前端入口

系统有两个前端版本：

| 版本 | 文件 | 用途 |
|:---|:---|:---|
| 桌面端 | `frontend/index.html` | 传统响应式布局 |
| 移动端 | `frontend/page.html` | Mobile-first + PWA |

部署时 `_worker.js` 使用 `page.html` 作为源文件。

---

## CI/CD

项目已配置 GitHub Actions CI 流水线（`.github/workflows/ci.yml`）：
- 每次 push/PR 自动运行类型检查和测试

---

## 完整文档

详见 [TECH_DOCS.md](TECH_DOCS.md) — 包含详细的架构、API 接口、部署运维、常见问题等。

## License

MIT
