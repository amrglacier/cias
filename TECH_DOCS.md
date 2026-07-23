# CIAS 项目技术文档

> **版本**: V1.5.0 | **最后更新**: 2026-07-24 | **文档面向**: 接手开发的工程师

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构](#2-系统架构)
3. [技术栈与外部依赖](#3-技术栈与外部依赖)
4. [项目目录结构](#4-项目目录结构)
5. [核心概念与数据流](#5-核心概念与数据流)
6. [数据库设计](#6-数据库设计)
7. [SOP 五阶段工作流](#7-sop-五阶段工作流)
8. [Cron 定时任务](#8-cron-定时任务)
9. [核心算法说明](#9-核心算法说明)
10. [前端架构](#10-前端架构)
11. [API 接口文档](#11-api-接口文档)
12. [部署与运维](#12-部署与运维)
13. [本地开发指南](#13-本地开发指南)
14. [常见修改场景](#14-常见修改场景)
15. [已知限制与注意事项](#15-已知限制与注意事项)

---

## 1. 项目概述

CIAS（Collaborative Intelligence Analysis System，协同研判自动化系统）是一个体育赛事量化预测系统。它基于软件需求说明书（SRS）V1.4.2 设计，采用**方案 B**（纯数学规则引擎 + 真实数据采集，不使用 LLM）。

**核心能力**:
- 自动采集五大联赛（英超、西甲、意甲、德甲、法甲）赛程、球队统计数据、伤病、裁判信息
- 使用贝叶斯平滑算法处理对手强度调整
- 通过纯数学公式计算预测结果（主推 + 备选）
- 每 30 分钟采集赔率快照，检测 Sharp/Steam 信号
- 赛后自动复盘归因，持续迭代因子权重
- 移动优先的响应式 Web 界面

**设计理念**:
- 零预算运行（Cloudflare 免费额度 + Supabase 免费额度）
- 全 Serverless 架构，无服务器维护
- 自动化运行，Cron 驱动全流程

---

## 2. 系统架构

```
                     ┌─────────────────┐
                     │ Cloudflare Cron  │
                     │ (3个定时任务)     │
                     └────────┬────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Worker (后端)    │
                    │   src/index.ts    │
                    │                   │
                    │  ┌─────────────┐  │
                    │  │ 调度中心    │  │
                    │  │orchestrator │  │
                    │  └──┬───┬─────┘  │
                    │     │   │        │
                    │  ┌──▼┐ ┌▼──┐     │
                    │  │Data│ │Logic│    │
                    │  │Agent│ │Agent│   │
                    │  └──┬──┘ └─┬──┘    │
                    │     │     │        │
                    │  ┌──▼─────▼──┐     │
                    │  │  Review   │     │
                    │  │  归因引擎  │     │
                    │  └───────────┘     │
                    └────────┬──────────┘
                             │
              ┌──────────────▼──────────────┐
              │     Supabase (PostgreSQL)   │
              │  9张表 + 2视图 + 2函数      │
              └─────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Cloudflare Pages│
                    │  (前端 + API代理) │
                    │  frontend/       │
                    │  _worker.js      │
                    └─────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───┐  ┌──────▼─────┐  ┌────▼──────┐
     │API-Football│  │The Odds API│  │ Supabase  │
     │ (RapidAPI) │  │            │  │  REST API │
     │赛程/统计/伤病│  │赔率数据    │  │  数据读写  │
     └────────────┘  └────────────┘  └───────────┘
```

### 两层 Worker 架构

系统有**两个**独立的 Worker：

| Worker | 部署位置 | 作用 | 代码位置 |
|:---|:---|:---|:---|
| **后端 Worker** (`cias-worker`) | Cloudflare Workers | Cron 定时任务 + API 路由 + 业务逻辑 | `src/index.ts` |
| **前端 Worker** (`cias-frontend`) | Cloudflare Pages Functions | API 代理（直连 Supabase）+ HTML 渲染 | `frontend/_worker.js` |

> **重要**: 前端 Worker 存在的原因是后端 Worker 的 `workers.dev` 域名在中国大陆被 DNS 污染（GFW）。前端 Worker 部署在 `pages.dev` 域名上，目前可正常访问。前端 Worker 通过 Supabase REST API 直接读取数据，不依赖后端 Worker。

---

## 3. 技术栈与外部依赖

### 技术栈

| 层级 | 技术 | 版本 | 说明 |
|:---|:---|:---|:---|
| 运行时 | Cloudflare Workers | - | 后端计算，免费 10 万次/天 |
| 调度 | Cloudflare Cron Triggers | - | 3 个定时任务 |
| 数据库 | Supabase (PostgreSQL) | - | 免费版，1GB 存储 |
| 并发控制 | Durable Objects + KV | - | 原子锁 |
| 前端 | Cloudflare Pages | - | 静态 HTML + Pages Functions |
| 语言 | TypeScript | 5.5+ | 后端类型安全 |
| 测试 | Vitest | 2.0+ | 45 个单元测试 |
| 构建 | Wrangler | 3.60+ | Cloudflare CLI |

### 外部 API 依赖

| API | 用途 | 计费 | Key 存放位置 |
|:---|:---|:---|:---|
| **API-Football** (via RapidAPI) | 赛程、球队统计、伤病、裁判、阵型 | 免费版 100 次/天 | Worker Secret `API_FOOTBALL_KEY` |
| **The Odds API** | 赔率数据（H2H 市场） | 免费版 500 次/月 | Worker Secret `ODDS_API_KEY` |

### npm 依赖

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240620.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "wrangler": "^3.60.0"
  }
}
```

依赖非常精简，只有 Supabase 客户端一个生产依赖。

---

## 4. 项目目录结构

```
cias/
├── .dev.vars                    # 本地开发环境变量（不提交 Git）
├── .env.example                 # 环境变量模板
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── wrangler.toml                # Cloudflare Worker 配置（含 Cron）
├── README.md
├── TECH_DOCS.md                 # ← 本文档
│
├── migrations/                  # Supabase 数据库迁移脚本
│   ├── 001_initial_schema.sql   # 8 张核心表 + RLS + 触发器
│   ├── 002_atomic_delete_function.sql  # 原子删除函数 + 2 个视图
│   ├── 003_matches_and_betting_config.sql  # matches 表 + 购彩配置
│   └── 004_team_stats_cache.sql     # team_stats_cache 表（静态数据缓存，12h TTL）
│
├── src/                         # 后端 Worker 源码
│   ├── index.ts                 # 入口：HTTP 路由 + Cron 调度
│   ├── types/
│   │   └── index.ts             # 全部 TypeScript 类型定义（13 个因子、预测、复盘等）
│   ├── config/
│   │   └── defaults.ts          # 默认配置：因子权重、系统常量、赔率区间分类、购彩窗口配置
│   ├── db/
│   │   ├── client.ts            # Supabase 客户端工厂
│   │   ├── repository.ts        # 数据访问层（所有 DB 操作）
│   │   └── durable-objects.ts   # 并发锁 Durable Object
│   ├── agents/
│   │   ├── data-agent.ts        # Data Agent：基本面采集 + 证据包构建 + 赔率快照
│   │   ├── logic-agent.ts       # Logic Agent：预测计算引擎
│   │   ├── logic-engine.ts      # 纯数学公式引擎
│   │   ├── algorithms.ts        # 贝叶斯平滑 + 天气/裁判/战意/伤停算法
│   │   └── api-football-fetcher.ts  # API-Football + The Odds API 数据拉取
│   ├── system/
│   │   ├── orchestrator.ts      # 调度中心：SOP 五阶段编排
│   │   ├── constitution.ts      # 宪法校验（方向判断格式、对冲要求等）
│   │   └── circuit-breaker.ts   # 熔断器（API 预算监控）
│   ├── review/
│   │   └── attribution.ts       # 复盘归因 + 权重迭代
│   └── prompts/
│       └── logic-agent-prompt.ts  # LLM Prompt 模板（方案 B 未使用，保留备用）
│
├── frontend/                    # 前端（Cloudflare Pages）
│   ├── _worker.js               # 自动生成的 Pages Worker（API 代理 + HTML）
│   ├── page.html                # ← 可编辑的 HTML 源模板
│   ├── index.html               # 旧版静态页面（已弃用）
│   └── README.md
│
├── scripts/
│   └── build-worker.js          # 构建脚本：page.html → _worker.js
│
├── test/
│   └── cias.test.ts             # 45 个单元测试
│
└── seed_*.py / seed_*.json      # 种子数据脚本（开发用）
```

### 文件重要性分级

| 重要程度 | 文件 | 说明 |
|:---|:---|:---|
| 核心必读 | `src/index.ts` | 入口，理解路由和 Cron |
| 核心必读 | `src/system/orchestrator.ts` | SOP 五阶段编排 |
| 核心必读 | `src/types/index.ts` | 所有类型定义和 13 个因子 |
| 核心必读 | `src/config/defaults.ts` | 默认配置和算法常量 |
| 重要 | `src/agents/algorithms.ts` | 核心算法实现 |
| 重要 | `src/agents/api-football-fetcher.ts` | 外部 API 数据拉取 |
| 重要 | `src/review/attribution.ts` | 复盘归因逻辑 |
| 重要 | `frontend/page.html` | 前端 UI 源码 |
| 参考 | `migrations/*.sql` | 数据库结构 |

---

## 5. 核心概念与数据流

### 13 个预测因子

系统使用 13 个因子（F1-F13）进行预测计算：

| 因子 | 名称 | 符号 | 影响目标 | 默认权重 | 数据来源 |
|:---|:---|:---|:---|:---|:---|
| F1 | 主队调整 xG | `xG_h_adj` | OWF（进攻权重） | 0.35 | API-Football 球队统计 |
| F2 | 客队调整 xG | `xG_a_adj` | OWF | 0.25 | API-Football 球队统计 |
| F3 | 主队调整失球率 | `Conc_h_adj` | K1（防守权重） | 0.20 | API-Football 球队统计 |
| F4 | 客队调整失球率 | `Conc_a_adj` | K1 | 0.10 | API-Football 球队统计 |
| F5 | 主队伤停影响 | `Inj_h` | OWF | 0.15 | API-Football 伤病接口 |
| F6 | 客队伤停影响 | `Inj_a` | K1 | 0.15 | API-Football 伤病接口 |
| F7 | 天气衰减 | `W_th` | OWF×K1 | 0.95-1.0 | API-Football（默认 1.0） |
| F8 | 裁判严格度 | `Ref_st` | Wr（风险权重） | 0.02/级 | API-Football 裁判接口 |
| F9 | 战意系数 | `Motiv` | OWF | 0.9-1.1 | 规则计算（德比/争冠/保级） |
| F10 | 赔率区间偏差 | `Bias_zone` | 概率校准 | -0.05~0.03 | The Odds API |
| F11 | Sharp/Steam 信号 | `Mkt_sig` | OWF 微调 | -0.04~0.04 | The Odds API |
| F12 | 历史误差率 | `Err_rate` | Wr | 0.05 | 复盘系统累积 |
| F13 | 阵型克制 | `Form_ctr` | OWF 微调 | -0.03~0.03 | API-Football 阵容接口 |

### 核心公式

```
OWF = (xG_h_adj * w1 + xG_a_adj * w2) * W_th * Motiv
K1  = (Conc_h_adj * w3 + Conc_a_adj * w4 + Ref_st * step) * (1 - Inj_h)
Wr  = BaseRate + Ref_st + Err_rate
```

- **OWF**（Offensive Weighted Factor）：进攻加权因子，决定预测进球数
- **K1**（Defensive Factor）：防守因子，修正失球预期
- **Wr**（Risk Weight）：风险权重，影响置信度校准

### 完整数据流

```
1. Cron 触发（每2小时）
   │
   ├─→ 拉取赛程 → 存入 matches 表
   │
   ├─→ 对进入赛前窗口的比赛：
   │   ├─→ Phase 1 (T0): 采集基本面数据
   │   │   ├─→ API-Football: 球队统计、伤病、裁判、阵型
   │   │   ├─→ 贝叶斯平滑处理
   │   │   └─→ 存入 match_facts 表（status='frozen'）
   │   │
   │   ├─→ Phase 2 (Initial): 构建证据包 + 数学计算
   │   │   ├─→ Data Agent 构建 EvidencePack
   │   │   ├─→ Logic Agent 执行公式计算
   │   │   └─→ 存入 predictions 表（version_tag='INITIAL'）
   │   │
   │   └─→ Phase 3 (Cross-Discussion): 交叉讨论
   │       ├─→ 检测 Data Agent 与 Logic Agent 的差异
   │       ├─→ 最多 2 轮讨论
   │       └─→ 对齐或强制降级（forced_degrade）
   │
   ├─→ 对进入截止窗口的比赛：
   │   └─→ Phase 5 (Final): 宪法校验 → 锁定预测
   │       └─→ predictions 表 is_lock=true, version_tag='FINAL'
   │
   └─→ 对进行中的比赛：
       └─→ Phase 4: 赔率信号检测 → 轻量重算

2. Cron 触发（每15分钟）
   └─→ 采集赔率快照 → 检测 Sharp/Steam 信号

3. Cron 触发（每6小时）
   ├─→ 拉取已完赛比赛比分
   └─→ Phase Review: 复盘归因
       ├─→ 对比预测与实际结果
       ├─→ 确定归因代码（A1/A2/C1/C2/D1-D4）
       ├─→ 累积误差趋势 → 权重迭代
       └─→ 命中率低于 30% → 暂停自动调整
```

---

## 6. 数据库设计

### 表结构总览

共 9 张表 + 2 个视图 + 2 个函数：

```
┌──────────────────────────────────────────────────┐
│                   Supabase                        │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────┐    ┌──────────────┐               │
│  │ matches  │    │ match_facts  │               │
│  │ (赛程)   │    │ (基本面数据)  │               │
│  └────┬─────┘    └──────┬───────┘               │
│       │                 │                        │
│       │     ┌───────────┼───────────┐            │
│       │     │           │           │            │
│       │  ┌──▼──────┐ ┌──▼─────┐ ┌──▼────────┐   │
│       │  │odds_     │ │market_ │ │predictions │   │
│       │  │snapshots │ │signals │ │(预测结果)   │   │
│       │  └──────────┘ └────────┘ └──────┬─────┘   │
│       │                                │          │
│       │                    ┌───────────┘          │
│       │                    │                      │
│       │              ┌─────▼──────┐               │
│       │              │review_     │               │
│       │              │results     │               │
│       │              └────────────┘               │
│       │                                           │
│  ┌────▼──────┐  ┌───────────┐  ┌──────────────┐ │
│  │api_usage_ │  │weight_    │  │system_config │ │
│  │log        │  │adjustments│  │(键值配置)     │ │
│  └───────────┘  └───────────┘  └──────┬───────┘ │
│                                        │          │
│                              ┌─────────▼───────┐ │
│                              │ error_count     │ │
│                              │ (误差累积)       │ │
│                              └─────────────────┘ │
│                                                  │
│  Views: v_latest_predictions, v_review_summary   │
│  Functions: delete_oldest_inplay_prediction,     │
│             update_updated_at                    │
└──────────────────────────────────────────────────┘
```

### 各表说明

| 表名 | 用途 | 关键字段 | 迁移文件 |
|:---|:---|:---|:---|
| `matches` | 赛程信息 | match_id (PK), home_team, away_team, kickoff_time, status | 003 |
| `match_facts` | 基本面数据（13 因子原始值） | match_id (PK), home_xg_adj, away_xg_adj, status | 001 |
| `predictions` | 预测结果 | id (PK), match_id (FK), primary_result, version_tag, is_lock | 001 |
| `odds_snapshots` | 赔率快照 | id (PK), match_id (FK), home_odds, is_sharp_move | 001 |
| `market_signals` | 市场信号 | id (PK), match_id (FK), signal_type | 001 |
| `review_results` | 复盘结果 | id (PK), match_id (FK), attribution_code, is_upset | 001 |
| `weight_adjustments` | 权重调整记录 | factor_id, old_weight, new_weight, adjustment_pct | 001 |
| `system_config` | 系统配置（键值存储） | key (PK), value (JSONB) | 001 |
| `error_count` | 误差累积跟踪 | factor_id, error_type | 001 |
| `api_usage_log` | API 调用配额跟踪 | api_name, remaining, total | 001 |
| `team_stats_cache` | 静态球队统计缓存（12h TTL，避免重复 API 调用） | cache_key (PK), team_name, xg_raw, cached_at | 004 |

### 外键关系

```
matches.match_id ──┬──→ match_facts.match_id
                   ├──→ predictions.match_id
                   ├──→ odds_snapshots.match_id
                   └──→ market_signals.match_id

predictions.id ──→ review_results.prediction_id
odds_snapshots.id ──→ market_signals.odds_snapshot_id
```

所有外键均带 `ON DELETE CASCADE`，删除 match_facts 记录会级联清理相关数据。

### RLS（行级安全）

所有表都启用了 RLS，仅允许 `service_role` 访问。这意味着只有使用 Service Role Key 的请求才能读写数据，前端 Worker 使用的是 Service Role Key 直连 Supabase REST API。

### 关键配置项（system_config 表）

| key | 说明 | 默认值 |
|:---|:---|:---|
| `factor_weights` | 13 个因子的权重 | 见 `defaults.ts` |
| `review_config` | 复盘系统配置 | hitrate_threshold=30, trend_error_count=3 |
| `betting_window_config` | 购彩时间窗口配置 | start=2h, end=15min, fundamentals_delay=0.5h, final_lock=15min, 5 大联赛 |

---

## 7. SOP 五阶段工作流

SOP（Standard Operating Procedure）是系统的核心工作流，分为 5 个阶段：

### 阶段概览

| 阶段 | 名称 | 触发时机 | 版本标签 | 代码位置 |
|:---|:---|:---|:---|:---|
| Phase 1 | T0 基本面治理 | 赛前 N 小时（可配置，默认 2h） | - | `orchestrator.ts:runPhase1_T0()` |
| Phase 2 | 初始预测 | T0 完成后 | `INITIAL` | `orchestrator.ts:runPhase2_Initial()` |
| Phase 3 | 交叉讨论 | Phase 2 完成后 | - | `orchestrator.ts:runPhase3_CrossDiscussion()` |
| Phase 4 | 盘中监测 | 比赛进行中（Cron 驱动） | `PERIODIC` | `orchestrator.ts:runPhase4_InPlayMonitoring()` |
| Phase 5 | 终盘锁定 | 购彩结束前 N 分钟（可配置，默认 15min） | `FINAL` | `orchestrator.ts:runPhase5_FinalPublish()` |

### 各阶段详细说明

**Phase 1 - T0 基本面治理**
- Data Agent 调用 API-Football 获取：球队统计、伤病、裁判、阵型
- 对 xG 和失球率执行贝叶斯平滑（对手强度调整）
- 将数据冻结（`match_facts.status = 'frozen'`）
- **T0 后禁止调用除 Odds API 外的任何外部接口**

**Phase 2 - 初始预测**
- Data Agent 构建证据包（EvidencePack）
- Logic Agent 读取 `*_adj` 调整后数据，执行数学公式计算
- 产出预测结果（主推 + 备选），存入 predictions 表

**Phase 3 - 交叉讨论**
- 检测 Data Agent 证据与 Logic Agent 预测之间的差异
- 最多 2 轮讨论，每轮 System 询问 Logic Agent
- 对齐 → `alignment_status = 'aligned'`
- 未对齐 → `alignment_status = 'forced_degrade'`，强制保留对冲

**Phase 4 - 盘中监测**
- 每 30 分钟由 Cron 触发赔率采集
- 检测 Sharp Move（>=5%变动）或 Steam Move（>=8%快速变动）
- 有信号 → 轻量重算，产出 `PERIODIC` 版本
- 最多保留 5 条 PERIODIC 记录，超出自动删除最旧的

**Phase 5 - 终盘锁定**
- 宪法校验（方向判断格式、对冲要求等）
- 熔断器检查（API 预算是否耗尽）
- 锁定预测（`is_lock = true, version_tag = 'FINAL'`）
- 锁定后不可修改

---

## 8. Cron 定时任务

在 `wrangler.toml` 中配置了 3 个 Cron：

| Cron 表达式 | 频率 | 功能 | 处理函数 |
|:---|:---|:---|:---|
| `0 */2 * * *` | 每 2 小时 | 拉取赛程 + 基本面采集 + 初始预测 + 交叉讨论 + 终盘锁定 + 盘中监测 | `runScheduledFundamentalsAndMonitoring()` |
| `*/30 * * * *` | 每 30 分钟 | 赔率快照采集 + 信号检测 | `runScheduledOddsCapture()` |
| `0 */6 * * *` | 每 6 小时 | 拉取完赛比分 + 赛后复盘归因 | `runScheduledReview()` |

### Cron 1 详细逻辑（最核心）

```
runScheduledFundamentalsAndMonitoring():
  1. 从 API-Football 拉取未来赛程 → 存入 matches 表
  2. 从 API-Football 拉取已完赛比赛 → 更新比分
  3. 读取购彩窗口配置（start_hours_before_kickoff 等）
     - fundamentals_delay_after_start_hours: 基本面治理延迟（默认0.5h）
     - final_lock_minutes_before_end: 终盘锁定提前量（默认15min）
  4. 遍历即将开始的比赛：
     a. 若在基本面触发窗口内（距开球 <= start_hours - delay_hours）且未采集过基本面：
        → 执行 Phase 1 (T0) + Phase 2 (Initial) + Phase 3 (Cross-Discussion)
        注：基本面治理在购彩开始后延迟 N 小时触发，避开数据延迟和拥堵
     b. 若在终盘锁定窗口内（距开球 <= end_minutes + lock_minutes 且 > end_minutes）且未锁定：
        → 执行 Phase 5 (Final Publish)
        注：终盘锁定在购彩结束前 N 分钟触发
  5. 遍历进行中比赛（status='in_play'）：
     → 执行 Phase 4 (In-Play Monitoring)
     → 刷新动态因子（伤病、阵容、裁判、天气），静态数据走缓存
```

### Cron 执行环境

Cron 在 Cloudflare 服务端执行，**不受 GFW 影响**，即使 `workers.dev` 域名被墙，Cron 定时任务仍正常运行。

---

## 9. 核心算法说明

### 贝叶斯平滑（SRS 3.2.1）

**目的**: 当对手比赛样本不足时，使用联赛平均值作为先验，避免极端值。

```typescript
// algorithms.ts
function bayesianSmooth(metricRaw, oppMatches, oppAvgRate, leagueAvgRate) {
  if (oppMatches < 5) {
    // 贝叶斯先验：融合对手数据与联赛平均
    smoothedRate = (oppMatches * oppAvgRate + 5 * leagueAvgRate) / (oppMatches + 5);
  } else {
    smoothedRate = oppAvgRate;
  }
  adjusted = metricRaw / smoothedRate;
  return { adjusted, priorApplied: oppMatches < 5 };
}
```

### 预测公式（SRS 3.2.2）

```
OWF = (xG_h_adj * w1 + xG_a_adj * w2) * W_th * Motiv
K1  = (Conc_h_adj * w3 + Conc_a_adj * w4 + Ref_st * step) * (1 - Inj_h)
Wr  = BaseRate + Ref_st + Err_rate
```

- `OWF` 决定预测进球数
- `K1` 修正防守端
- `Wr` 影响风险置信度

### 赔率区间分类

```typescript
// defaults.ts
function classifyOddsZone(homeOdds) {
  if ([1.44, 2.22, 3.33].some(v => Math.abs(homeOdds - v) < 0.02))
    return 'death_odds';      // 死亡赔率（特殊偏差区）
  if (homeOdds < 1.5) return 'strong_favorite';
  if (homeOdds < 1.8) return 'favorite';
  if (homeOdds < 2.5) return 'balanced';
  if (homeOdds < 3.5) return 'underdog';
  return 'big_underdog';
}
```

### 复盘归因代码

| 代码 | 含义 | 归因方 | 触发条件 |
|:---|:---|:---|:---|
| A1 | 方向判断错误（接近） | Logic | 结果错但总进球差 <= 1 |
| A2 | 方向判断错误（偏离大） | Logic | 结果错且总进球差 > 1 |
| C1 | 忽略 Sharp 信号 | Logic | 有信号但未跟随，结果本应对 |
| C2 | 错误跟随 Steam 信号 | Logic | 跟随了信号但结果相反 |
| D1 | 冷门未预测到 | Logic | 实际冷门，预测未覆盖 |
| D2 | 数据源冲突 | Data | L3 源被 L1 源否定 |
| D3 | 忽略赔率偏差 | Logic | 死亡赔率区间偏差未校准 |
| D4 | 未调整数据膨胀 | Data/Logic | 未调整数据导致 OWF 膨胀 |

### 权重迭代规则

- 单场比赛不触发权重调整
- **趋势触发**: 同一因子连续 3 次同类错误 → 调整权重
- **调整幅度**: 每次最多 10%
- **熔断**: 日命中率 < 30% → 暂停自动调整，需人工审计

---

## 10. 前端架构

### 概述

前端是一个移动优先的响应式 Web 应用，部署在 Cloudflare Pages 上。

### 文件结构

```
frontend/
├── page.html        # ← 可编辑的 HTML 源模板（修改 UI 改这个文件）
├── _worker.js       # 自动生成的 Pages Worker（不要手动编辑）
├── index.html       # 旧版页面（已弃用）
└── README.md
scripts/
└── build-worker.js  # 构建脚本：page.html → _worker.js
```

### 构建流程

```
page.html (可编辑源码)
    │
    │  node scripts/build-worker.js
    │
    ▼
_worker.js (自动生成)
    ├── Supabase 直连 API 代理（/api/* 路由）
    └── HTML 渲染（根路径返回完整页面）
```

**修改前端 UI 的正确流程**:
1. 编辑 `frontend/page.html`
2. 运行 `node scripts/build-worker.js`
3. 部署: `npx wrangler pages deploy frontend --project-name=cias-frontend`
4. 提交 Git

> **不要**手动编辑 `_worker.js`，它是由构建脚本自动生成的。

### 前端 Worker 的双重职责

`_worker.js` 同时处理两类请求：

| 请求路径 | 处理方式 |
|:---|:---|
| `/api/*` | 直接查询 Supabase REST API（使用 Service Role Key），返回 JSON |
| `/` 或其他 | 返回完整 HTML 页面（内联 CSS + JS） |

### UI 设计

- **主题**: 深色毛玻璃（`#0a0e14` 背景 + `backdrop-filter: blur(20px)`）
- **导航**: 底部固定导航栏，5 个标签
- **布局**: `max-width: 640px` 居中，移动端满屏
- **安全区**: 支持 `env(safe-area-inset-*)` 适配刘海屏

### 5 个标签页

| 标签 | 功能 | 对应 API |
|:---|:---|:---|
| 预测 | 查看/搜索预测结果 | `/api/prediction`, `/api/all-predictions`, `/api/odds-snapshots` |
| 复盘 | 复盘统计和详情 | `/api/reviews?limit=20` |
| 赛程 | 即将进行的比赛 | `/api/upcoming-matches` |
| 基本面 | 比赛基本面数据 | `/api/all-match-facts` |
| 设置 | 购彩时间配置、因子权重 | `/api/config/betting-window`, `/api/config` |

---

## 11. API 接口文档

### 后端 Worker API（`cias-worker.274135814.workers.dev`，大陆被墙）

| 方法 | 路径 | 说明 | 代码位置 |
|:---|:---|:---|:---|
| GET | `/` | 健康检查 | `index.ts:56` |
| GET | `/api/health` | 系统健康状态 | `index.ts:466` |
| POST | `/api/matches` | 创建比赛记录 | `index.ts:357` |
| POST | `/api/predict` | 运行完整 SOP 流程 | `index.ts:367` |
| GET | `/api/predictions?matchId=` | 获取最新预测 | `index.ts:378` |
| GET | `/api/prediction?matchId=` | 获取锁定预测 | `index.ts:389` |
| GET | `/api/match-facts?matchId=` | 获取基本面数据 | `index.ts:403` |
| POST | `/api/odds-snapshot` | 手动捕获赔率 | `index.ts:414` |
| POST | `/api/review` | 执行赛后复盘 | `index.ts:424` |
| GET | `/api/reviews?matchId=&limit=` | 获取复盘结果 | `index.ts:440` |
| GET | `/api/in-play?matchId=` | 获取盘中预测 | `index.ts:454` |
| POST | `/api/run-sop` | 按阶段执行 SOP | `index.ts:476` |
| GET | `/api/config?key=` | 获取系统配置 | `index.ts:572` |
| GET/POST | `/api/config/betting-window` | 获取/更新购彩窗口 | `index.ts:586-633` |
| POST | `/api/migrate` | 检查/创建 matches 表 | `index.ts:517` |

### 前端 Worker API（`cias-frontend.pages.dev`，大陆可访问）

前端 Worker 提供了**独立的** API 端点，直连 Supabase REST API：

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/health` | 健康检查（直连 Supabase） |
| GET | `/api/predictions?matchId=` | 获取预测（最新10条） |
| GET | `/api/prediction?matchId=` | 获取锁定预测 |
| GET | `/api/all-predictions` | 获取所有未归档预测（最多50条） |
| GET | `/api/match-facts?matchId=` | 获取单场基本面数据 |
| GET | `/api/all-match-facts` | 获取所有基本面数据 |
| GET | `/api/odds-snapshots?matchId=` | 获取赔率快照（最多10条） |
| GET | `/api/reviews?limit=&matchId=` | 获取复盘结果 |
| GET | `/api/config?key=` | 获取系统配置 |
| GET | `/api/config/betting-window` | 获取购彩窗口配置 |
| POST | `/api/config/betting-window` | 更新购彩窗口配置 |
| GET | `/api/upcoming-matches` | 获取即将进行的比赛（最多20场） |

> 前端 Worker 的 API 是只读的（除了购彩窗口配置），主要用于展示数据。写入操作由后端 Worker 的 Cron 任务自动完成。

---

## 12. 部署与运维

### 当前部署信息

| 资源 | 地址/ID | 说明 |
|:---|:---|:---|
| 前端 URL | `https://cias-frontend.pages.dev` | 大陆可访问 |
| 后端 Worker URL | `https://cias-worker.274135814.workers.dev` | 大陆被墙，Cron 不受影响 |
| Supabase | `https://snycievdfcyoytthxspm.supabase.co` | Region: ap-northeast-1 |
| GitHub | `https://github.com/amrglacier/cias` | master 分支 |
| Cloudflare Account ID | `83ebec4f09f46db3fa7a18d2055d15a2` | |
| KV Namespace ID | `a7ea4fdc865b48539de35920bcac4a56` | 并发锁 |

### 部署后端 Worker

```bash
# 1. 设置 Secrets（首次或更新 Key 时）
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put API_FOOTBALL_KEY
npx wrangler secret put ODDS_API_KEY

# 2. 部署
npm run deploy
# 或
npx wrangler deploy
```

### 部署前端

```bash
# 1. 修改 UI 后先构建
node scripts/build-worker.js

# 2. 部署到 Cloudflare Pages
npx wrangler pages deploy frontend --project-name=cias-frontend --commit-dirty=true
```

### 查看后端日志

```bash
npx wrangler tail
```

### 数据库管理

- Supabase 控制台: `https://supabase.com/dashboard/project/snycievdfcyoytthxspm`
- SQL Editor: 在控制台执行 SQL（如需建表、修改结构）
- 表编辑器: 可视化查看和编辑数据

### Secrets 配置（wrangler.toml 中声明的）

| Secret 名称 | 说明 | 当前值存放 |
|:---|:---|:---|
| `SUPABASE_URL` | Supabase 项目 URL | Worker Secret |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role JWT | Worker Secret |
| `API_FOOTBALL_KEY` | API-Football (RapidAPI) Key | Worker Secret |
| `ODDS_API_KEY` | The Odds API Key | Worker Secret |
| `LLM_API_KEY` | LLM API Key（方案 B 未使用） | 未设置 |

> 前端 Worker 的 Supabase URL 和 Key 硬编码在 `_worker.js` 中（因为 Pages Functions 不支持 wrangler secret）。

---

## 13. 本地开发指南

### 环境要求

- Node.js 18+
- npm 或 pnpm
- Cloudflare 账户（用于 wrangler）
- Supabase 账户

### 初始化

```bash
# 克隆仓库
git clone https://github.com/amrglacier/cias.git
cd cias

# 安装依赖
npm install

# 复制环境变量
cp .env.example .dev.vars
# 编辑 .dev.vars，填入真实的 API Key
```

### 本地运行后端 Worker

```bash
npm run dev
# 启动 wrangler dev，监听 localhost:8787
```

### 本地运行测试

```bash
npm test           # 运行一次
npm run test:watch # 持续监听
```

### 类型检查

```bash
npm run type-check
```

### 修改前端 UI

```bash
# 1. 编辑前端源码
# 用编辑器打开 frontend/page.html，修改 HTML/CSS/JS

# 2. 构建生成 _worker.js
node scripts/build-worker.js

# 3. 验证语法
node -c frontend/_worker.js

# 4. 本地预览（可选）
cd frontend && npx wrangler pages dev .

# 5. 部署
npx wrangler pages deploy frontend --project-name=cias-frontend --commit-dirty=true
```

### 数据库变更

如需修改表结构：
1. 在 `migrations/` 目录新建 SQL 文件（如 `004_add_new_feature.sql`）
2. 在 Supabase Dashboard > SQL Editor 中执行
3. 如需在代码中同步，更新 `src/types/index.ts` 和 `src/db/repository.ts`

---

## 14. 常见修改场景

### 场景 1: 修改购彩时间窗口

购彩时间窗口已做成可配置参数，有两种修改方式：

**方式 A - 通过前端 UI**:
- 打开 `https://cias-frontend.pages.dev`
- 进入「设置」标签
- 修改开始/截止时间，点击保存

**方式 B - 通过 API**:
```bash
curl -X POST https://cias-frontend.pages.dev/api/config/betting-window \
  -H "Content-Type: application/json" \
  -d '{"start_hours_before_kickoff": 3, "end_minutes_before_kickoff": 30, "fundamentals_delay_after_start_hours": 0.5, "final_lock_minutes_before_end": 15, "league_ids": [39,140,135,78,61], "season": "2025"}'
```

### 场景 2: 添加新联赛

修改 `src/config/defaults.ts` 中的 `DEFAULT_BETTING_WINDOW_CONFIG`:

```typescript
api_football_league_ids: [39, 140, 135, 78, 61, /* 新联赛 ID */],
target_leagues: [..., /* 新联赛标识 */],
```

然后重新部署后端 Worker。

### 场景 3: 调整因子权重

权重存储在 `system_config` 表的 `factor_weights` 键中。有两种修改方式：

**方式 A - 直接改数据库**:
```sql
UPDATE system_config SET value = jsonb_set(value, '{w1}', '0.40') WHERE key = 'factor_weights';
```

**方式 B - 修改代码默认值**:
修改 `src/config/defaults.ts` 中的 `DEFAULT_FACTOR_WEIGHTS`，然后重新部署。

### 场景 4: 修改 Cron 频率

编辑 `wrangler.toml`:

```toml
[triggers]
crons = [
  "0 */2 * * *",    # 修改这个表达式
  "*/15 * * * *",
  "0 */6 * * *"
]
```

然后重新部署后端 Worker。

### 场景 5: 修改前端 UI

1. 编辑 `frontend/page.html`
2. 运行 `node scripts/build-worker.js`
3. 部署: `npx wrangler pages deploy frontend --project-name=cias-frontend --commit-dirty=true`

### 场景 6: 切换到方案 A（接入 LLM）

当前使用方案 B（纯数学），如需切换到方案 A：

1. 在 `src/agents/logic-agent.ts` 中将 stub 函数替换为 LLM 调用
2. 设置 `LLM_API_KEY` 和 `LLM_API_BASE` Secret
3. `src/prompts/logic-agent-prompt.ts` 中已有 Prompt 模板
4. 重新部署后端 Worker

---

## 15. 已知限制与注意事项

### 网络限制

- **`workers.dev` 在大陆被 DNS 污染**: 后端 Worker 域名无法从大陆直接访问。但 Cron 任务在 Cloudflare 服务端执行，不受影响。
- **`pages.dev` 目前可访问**: 前端通过 Pages Functions 代理直连 Supabase，绕过了 GFW。
- **如 `pages.dev` 也被墙**: 需要绑定自定义域名（需在 Cloudflare Dashboard 操作）。

### API 配额限制

| API | 免费额度 | 当前使用 |
|:---|:---|:---|
| Cloudflare Workers | 10 万次/天 | 3 个 Cron，约 100-200 次/天 |
| Supabase | 500MB 存储，API 无限 | 存储量极小 |
| API-Football | 100 次/天 | 每个 Cron 周期约 5-20 次 |
| The Odds API | 500 次/月 | 每 30 分钟采集，约 500-1000 次/月 |

> The Odds API 免费额度可能不够用，需要监控 `api_usage_log` 表的 remaining 字段。接近耗尽时系统熔断器会暂停非核心请求。

### 数据精度

- API-Football 的 `goals.for.average.total` 是场均进球，用作 xG 的近似值（非真正的 xG）
- 裁判数据可能不完整（部分联赛无裁判统计）
- 伤病数据依赖 API-Football 的实时更新，可能有延迟

### 架构限制

- 前端 Worker 的 Supabase Key 硬编码在 `_worker.js` 中（Pages Functions 不支持 wrangler secret）。如需更换 Key，需要重新构建并部署前端。
- 后端 Worker 和前端 Worker 是两个独立的部署，修改后端逻辑不影响前端，反之亦然。
- Cron 任务是串行的（同一 Cron 不会并发执行），但不同 Cron 可能同时运行。

### 方案 B 的限制

方案 B（纯数学规则）不使用 LLM，因此：
- 交叉讨论阶段是规则匹配，不是真正的自然语言讨论
- 方向判断（`direction_judgment`）由规则生成，非 LLM 生成
- 复盘归因是规则判断，非语义分析

如需更智能的分析，可切换到方案 A（接入 LLM）。

---

## 附录: 快速验证清单

部署完成后，按以下步骤验证系统是否正常运行：

1. **前端可访问**: 打开 `https://cias-frontend.pages.dev`，应看到深色 UI 和健康状态绿点
2. **数据可读取**: 点击「全部」按钮，应显示预测数据（或"暂无预测数据"提示）
3. **Cron 在运行**: 在 Cloudflare Dashboard > Workers > cias-worker > Triggers 中查看 Cron 执行日志
4. **数据库有数据**: 在 Supabase Dashboard > Table Editor 中检查 `matches` 表是否有赛程数据
5. **API Key 有效**: 在 `api_usage_log` 表中查看 remaining 值，确认 API 配额未耗尽

---

> 如有疑问，参考源代码中的注释（每个文件头部都有 SRS 章节引用），或查看 `README.md` 的快速开始指南。
