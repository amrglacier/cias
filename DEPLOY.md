# CIAS 部署指南（纯小白版）

## 你需要的
- Cloudflare 账号（免费注册）
- 你的 GitHub 仓库：https://github.com/amrglacier/cias

---

## 第 1 步：登录 Cloudflare

1. 打开 https://dash.cloudflare.com/
2. 用邮箱注册/登录
3. 左侧菜单找到 **Workers & Pages** → 点击

---

## 第 2 步：部署前端（Pages）

1. 在 Workers & Pages 页面，点击 **Create application**
2. 选择 **Pages** → **Connect to Git**
3. 授权 GitHub → 选择仓库 **amrglacier/cias**
4. 配置如下：

```
Project name: cias-worker
Production branch: master
Build command: （留空）
Build output directory: frontend
Root directory: （留空）
```

5. 点击 **Save and Deploy**
6. 等待 30 秒部署完成

---

## 第 3 步：设置环境变量（重要！）

部署完成后，立刻设置环境变量：

1. 点击项目名进入项目页面
2. 顶部菜单 → **Settings** → **Environment variables**
3. 点击 **Add variable**，逐个添加：

| Variable name | Value |
|-------------|-------|
| `SUPABASE_URL` | `https://snycievdfcyoytthxspm.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNueWNpZXZkZmN5b3l0dGh4c3BtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDI4MDEyOCwiZXhwIjoyMDk5ODU2MTI4fQ.NJGxkf_wb_VlSUDJ-YwCzXZ_98BfzzGa0goONcCLDYM` |

> ⚠️ 第二个 Value 很长，是你的 Supabase Service Role Key。

4. 点击 **Save**
5. 回到项目页面，点击 **Retry deployment** 重新部署

---

## 第 4 步：部署后端（Workers）

1. 左侧菜单 → **Workers & Pages**
2. 点击 **Create application** → **Create Worker**
3. 编辑 `src/index.ts` 内容：
   - 点击 **Quick edit** 或直接编辑
   - 但这太复杂了，换另一种方式：

### 更简单的方式：用 wrangler 部署

打开你的电脑终端（Windows 用 CMD/PowerShell，Mac 用 Terminal）：

```bash
# 1. 先安装 wrangler（如果还没装）
npm install -g wrangler

# 2. 登录 Cloudflare（会打开浏览器让你点确认）
npx wrangler login

# 3. 进入项目目录
cd cias

# 4. 设置 Secrets（每个都要执行一次，会提示你输入值）
npx wrangler secret put SUPABASE_URL
# 输入：https://snycievdfcyoytthxspm.supabase.co

npx wrangler secret put SUPABASE_SERVICE_KEY
# 输入：eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNueWNpZXZkZmN5b3l0dGh4c3BtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDI4MDEyOCwiZXhwIjoyMDk5ODU2MTI4fQ.NJGxkf_wb_VlSUDJ-YwCzXZ_98BfzzGa0goONcCLDYM

npx wrangler secret put API_FOOTBALL_KEY
# 输入你的 API-Football Key

npx wrangler secret put ODDS_API_KEY
# 输入你的 Odds API Key

npx wrangler secret put ADMIN_API_KEY
# 输入一个你自己设定的管理密码（如：my-secret-admin-key-2026）

# 5. 部署后端
npx wrangler deploy
```

---

## 第 5 步：测试

部署完成后，你会得到两个地址：

- **前端**：`https://cias-worker.pages.dev`（手机浏览器入口）
- **后端**：`https://cias-worker.xxx.workers.dev`（API 地址）

用手机浏览器打开 `https://cias-worker.pages.dev` 即可使用。

---

## 常见问题

**Q: 页面空白怎么办？**
> 检查环境变量是否设置正确（SUPABASE_URL 和 SUPABASE_SERVICE_KEY）。

**Q: 显示 "Offline" 怎么办？**
> 后端 Worker 还没部署或环境变量缺失。

**Q: 怎么获取 API-Football Key？**
> 到 https://www.api-football.com/ 注册，免费额度够用。

**Q: 怎么获取 Odds API Key？**
> 到 https://the-odds-api.com/ 注册，免费额度够用。

---

## 需要帮忙？

如果以上步骤有任何一步卡住了，把错误截图发给我，我帮你解决。
