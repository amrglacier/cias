# CIAS - 协同研判自动化系统 (Collaborative Intelligence Analysis System)

> V1.4.2-SRS-FULL-PROD | 基于 Cloudflare Workers + Supabase 的零预算量化研判系统

## 系统架构

```
                    +-------------------+
                    | Cloudflare Cron   |
                    | Triggers          |
                    +--------+----------+
                             |
                             v
+----------------+   +------+----------+   +-----------------+
|  Data Agent    |<--|  System         |-->|  Logic Agent    |
|  (ETL/事实核验) |   |  (调度中心)      |   |  (量化引擎)     |
+-------+--------+   +------+----------+   +--------+--------+
        |                   |                        |
        v                   v                        v
+-------+--------+   +------+----------+   +--------+--------+
| match_facts    |   | Concurrency     |   | predictions     |
| odds_snapshots |   | Lock (DO/KV)    |   | logic_trace     |
| market_signals |   | Circuit Breaker |   | key_factors     |
+----------------+   +-----------------+   +-----------------+
                             |
                             v
                    +-------+----------+
                    | Review System    |
                    | (归因/迭代)       |
                    +------------------+
```

## 技术栈

| 层级 | 技术 | 说明 |
|:---|:---|:---|
| 计算层 | Cloudflare Workers | TypeScript, 10万次/天免费 |
| 调度层 | Cloudflare Cron Triggers | 原生定时任务 |
| 数据库 | Supabase (PostgreSQL) | JSONB 支持, 1GB 免费存储 |
| 并发控制 | Durable Objects + KV | 原子化锁机制 |
| 前端 | Cloudflare Pages | 静态 HTML/JS |

## 快速开始

### 1. 环境准备

```bash
# 安装依赖
npm install

# 复制环境变量模板
cp .env.example .dev.vars
# 编辑 .dev.vars，填入你的真实凭证
```

### 2. 数据库初始化

```bash
# 方式一：使用 Supabase CLI
supabase db push --db-url "postgresql://postgres:password@db.xxxx.supabase.co:5432/postgres"

# 方式二：手动执行迁移脚本
# 在 Supabase SQL Editor 中依次执行：
# 1. migrations/001_initial_schema.sql
# 2. migrations/002_atomic_delete_function.sql
```

### 3. 本地开发

```bash
# 启动本地 Worker 开发服务器
npm run dev

# 运行测试
npm test

# 类型检查
npm run type-check
```

### 4. 部署

```bash
# 设置 Secrets（生产环境）
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put API_FOOTBALL_KEY
wrangler secret put LLM_API_KEY
wrangler secret put ODDS_API_KEY

# 部署 Worker
npm run deploy

# 部署前端
cd frontend && npx wrangler pages deploy . --project-name=cias-dashboard
```

## 环境变量

| 变量名 | 说明 | 获取方式 |
|:---|:---|:---|
| `SUPABASE_URL` | Supabase 项目 URL | Supabase 控制台 > Settings > API |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role Key | Supabase 控制台 > Settings > API |
| `API_FOOTBALL_KEY` | API-Football 密钥 | [api-sports.io](https://api-sports.io) |
| `LLM_API_KEY` | LLM API 密钥 | OpenAI / 其他 LLM 提供商 |
| `ODDS_API_KEY` | The Odds API 密钥 | [the-odds-api.com](https://the-odds-api.com) |

## API 端点

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/` | 健康检查 |
| GET | `/api/health` | 系统健康状态 |
| POST | `/api/matches` | 创建比赛记录 |
| POST | `/api/predict` | 运行完整 SOP 流程 |
| GET | `/api/predictions?matchId=` | 获取最新预测 |
| GET | `/api/prediction?matchId=` | 获取锁定预测 |
| GET | `/api/match-facts?matchId=` | 获取基本面数据 |
| POST | `/api/odds-snapshot` | 手动捕获赔率快照 |
| POST | `/api/review` | 执行赛后复盘 |
| GET | `/api/reviews?matchId=` | 获取复盘结果 |
| GET | `/api/in-play?matchId=` | 获取盘中预测记录 |
| POST | `/api/run-sop` | 按阶段执行 SOP |
| GET | `/api/config?key=` | 获取系统配置 |

## SOP 工作流（5阶段）

| 阶段 | 触发时间 | 动作 |
|:---|:---|:---|
| T0 | 赛前 2 小时 | 基本面治理 + 贝叶斯平滑 + 数据冻结 |
| INITIAL | T0 完成后 | Data Agent 产出 Evidence Pack → Logic Agent 量化计算 |
| CROSS_DISCUSSION | INITIAL 后 | 交叉讨论（最多 2 轮）→ 对齐或强制降级 |
| PERIODIC | 盘中每小时 | 赔率快照 → 信号检测 → 轻量重算 |
| FUSE | 开赛前 15 分钟 | 宪法校验 → 熔断 → 锁定 FINAL |

## Cron Triggers

| Cron | 频率 | 功能 |
|:---|:---|:---|
| `0 */2 * * *` | 每 2 小时 | T0 基本面 + T1~Tn 盘中监测 |
| `*/15 * * * *` | 每 15 分钟 | 赔率快照采集 |
| `0 */6 * * *` | 每 6 小时 | 赛后复盘 |

## 核心算法

### 贝叶斯平滑（SRS 3.2.1）

```
Metric_adj = Metric_raw / SmoothedAvgRate
```

当对手比赛样本 < 5 场时，使用联赛平均值作为先验概率。

### 核心公式（SRS 3.2.2）

```
OWF = (xG_h_adj * w1 + xG_a_adj * w2) * W_th * Motiv
K1  = (Conc_h_adj * w3 + Conc_a_adj * w4 + Ref_st * w8) * (1 - Inj_h)
Wr  = BaseRate + Ref_st + Err_rate
```

### 并发锁（SRS 3.3）

- Durable Object 实现互斥锁
- 原子删除：`DELETE ... ORDER BY created_at ASC LIMIT 1`（通过 `delete_oldest_inplay_prediction` RPC）
- Cron Trigger 串行处理同一 `match_id`

## 项目结构

```
cias/
├── migrations/              # Supabase 数据库迁移
│   ├── 001_initial_schema.sql
│   └── 002_atomic_delete_function.sql
├── src/
│   ├── types/               # TypeScript 类型定义
│   ├── config/              # 默认配置
│   ├── db/                  # 数据库客户端 + Repository + Durable Objects
│   ├── agents/              # Data Agent + Logic Agent + 核心算法
│   ├── system/              # 调度中心 + 宪法校验 + 熔断器
│   ├── review/             # 复盘子系统
│   ├── prompts/            # LLM Prompt 模板
│   └── index.ts            # Worker 入口
├── frontend/               # Cloudflare Pages 前端
├── test/                    # 单元测试
├── wrangler.toml            # Cloudflare 配置
├── package.json
├── tsconfig.json
└── .env.example             # 环境变量模板
```

## 验收标准对照

| SRS 要求 | 实现状态 |
|:---|:---|
| `logic_trace` 体现贝叶斯平滑逻辑 | ✅ `bayesianApplied` + `unadjustedWarning` 字段 |
| `direction_judgment` 无数字 | ✅ 宪法校验 + `generateDirectionJudgment` 过滤数字 |
| 运行于 Cloudflare + Supabase | ✅ Workers + Supabase PostgreSQL |
| 无 Render 依赖 | ✅ 纯 Cloudflare + Supabase |
| 模拟并发无死锁 | ✅ Durable Object + `FOR UPDATE SKIP LOCKED` |
| 盘中记录 ≤ 5 | ✅ `INPLAY_MAX_RECORDS = 5` + 原子删除 |
| 交叉讨论 2 轮未对齐触发 `forced_degrade` | ✅ `CROSS_DISCUSSION_MAX_ROUNDS = 2` |
| 复盘能读取初盘、终盘及最近 5 次记录 | ✅ `getInPlayPredictions` + 版本链 |
| Cloudflare 额度未超额 | ✅ 熔断器 + API 预算监控 |
| Supabase 存储 < 1GB | ✅ 原子删除 + 盘中记录限制 |

## 许可证

MIT
