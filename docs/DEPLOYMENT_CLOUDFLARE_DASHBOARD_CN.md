[English](DEPLOYMENT_CLOUDFLARE_DASHBOARD.md) · [简体中文](DEPLOYMENT_CLOUDFLARE_DASHBOARD_CN.md)

# 通过 Cloudflare 网页控制台部署 Latchmail

本文面向不在本地运行 Wrangler 部署命令、而是通过 Cloudflare 网页控制台和 Git 仓库完成部署的场景。推荐使用 Cloudflare Workers Builds 从 GitHub 自动构建；数据库、R2、Secrets、域名和 Email Routing 均在控制台配置。

官方参考：[Workers Dashboard 入门](https://developers.cloudflare.com/workers/get-started/dashboard/) · [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [D1 入门](https://developers.cloudflare.com/d1/get-started/) · [Workers 版本与部署](https://developers.cloudflare.com/workers/versions-and-deployments/)

## 1. 部署前准备

确认仓库包含以下内容：

- `wrangler.jsonc`
- `migrations/0001_initial.sql`
- `src/worker/index.ts`
- `src/web/`
- `package.json` 和 `package-lock.json`

生产环境建议使用以下资源名称：

| 资源 | 建议名称 | 用途 |
| --- | --- | --- |
| Worker | `latchmail` | 生产 Worker |
| D1 | `latchmail-production` | 邮件索引、设置和任务状态 |
| R2 | `latchmail-production` | 原始 EML、解析 payload 和附件 |

staging 使用独立的 Worker、D1 和 R2，不要与生产环境共享数据。

## 2. 在控制台创建 D1 和 R2

### 创建 D1

1. 打开 Cloudflare Dashboard → **Storage & Databases → D1**。
2. 选择 **Create database**，名称填写 `latchmail-production`。
3. 打开数据库详情，复制 Database ID。
4. 将这个 ID 写入仓库 `wrangler.jsonc` 的 production `database_id`。
5. 将修改提交到 Git 仓库。不要把 D1 数据库 ID 与 Secret 混淆；ID 可以公开，Secret 不可以。

### 创建 R2

1. 打开 **R2 Object Storage**。
2. 选择 **Create bucket**，名称填写 `latchmail-production`。
3. 选择合适的存储位置和默认存储类别。
4. 保持 R2 bucket 私有，不要启用公开 `r2.dev` 访问。
5. 将 bucket 名称写入 `wrangler.jsonc` 的 production `bucket_name` 并提交。

生产配置中的绑定名称必须保持不变：

- D1：`DB`
- R2：`MAIL_STORAGE`
- 静态资源：`ASSETS`

如果控制台要求手工添加绑定，在 Worker 的 **Settings → Bindings** 中使用以上变量名。绑定名称错误会导致 Worker 构建成功但运行时无法访问数据库或对象存储。

## 3. 配置正式域名变量

在 `wrangler.jsonc` 的 production 环境中设置真实的同源 HTTPS 地址，例如：

```jsonc
"vars": {
  "APP_ORIGIN": "https://inbox.example.com",
  "ENVIRONMENT": "production"
}
```

`APP_ORIGIN` 必须与浏览器地址的 Origin 完全一致，不能带路径，也不要使用末尾 `/`。登录后的写操作会校验这个值。

普通变量可以保存在 `wrangler.jsonc`；密码、API Token 和签名密钥不能写入该文件。

## 4. 在 Cloudflare 控制台设置 Secrets

1. 打开 **Workers & Pages**。
2. 选择 `latchmail` Worker。
3. 进入 **Settings → Variables and Secrets**。
4. 选择 **Add**，类型选择 **Secret**。
5. 添加以下 Secret：

| 名称 | 必需 | 规则 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 是 | 至少 32 个字符，使用高熵随机值 |
| `SESSION_SECRET` | 是 | 与管理员密码独立的高熵随机值 |
| `ADMIN_API_TOKEN` | 否 | 需要自动化 Bearer API 时配置独立 Token |
| `WEBHOOK_SIGNING_SECRET` | 启用 Webhook 时 | 标准 Base64，正好编码 32 个随机字节 |

保存后点击 **Deploy**，让 Secret 绑定进入 Worker 版本。Secret 的值在 Worker 运行时通过 `env.ADMIN_PASSWORD` 等名称读取，但不会显示在代码仓库或控制台列表中。

如果使用 staging，必须在 `latchmail-staging` Worker 上重复设置一套独立 Secrets。不要在 staging 和 production 之间复用会话密钥或管理员密码。

## 5. 初始化 D1 数据库

网页控制台可以直接执行 SQL：

1. 打开 **Storage & Databases → D1 → `latchmail-production`**。
2. 进入 **Console / SQL**。
3. 打开仓库中的 [`migrations/0001_initial.sql`](../migrations/0001_initial.sql)。
4. 将完整 SQL 粘贴到 D1 Console，执行一次。
5. 确认 `app_settings` 表存在，并且只有一行 `singleton=1`。

不要重复执行同一份初始化 SQL。它会创建表和索引；D1/R2 数据不属于 Worker 版本回滚范围。以后新增迁移时，必须按新的编号单独执行，并记录执行时间和目标数据库。

## 6. 使用 Workers Builds 从 Git 部署

1. 打开 **Workers & Pages → Create application**。
2. 选择 **Import an existing Git repository**，授权并选择 Latchmail 仓库。
3. 生产 Worker 名称填写 `latchmail`。
4. 构建设置使用：

   - Build command：`npm ci && npm run build`
   - Deploy command：`npx wrangler deploy --env production`
   - Root directory：仓库根目录
   - Node.js：22 或更高版本

5. 确认构建使用仓库内的 `wrangler.jsonc`，并且 production 的 D1 ID、R2 bucket 名称和 `APP_ORIGIN` 已经是正式值。
6. 选择 **Save and Deploy**。
7. 在 Worker 的 **Deployments → Version history** 中确认新版本已部署到 100% 流量。

不要在构建命令中打印 Secret，也不要把 Secret 放进 GitHub Actions、普通 `vars` 或前端构建变量。Cloudflare 文档说明，Secrets 会以加密环境绑定的形式提供给 Worker。

如果团队不使用 Workers Builds，也可以在 Worker 的 **Edit Code** 中部署，但本项目包含 Vite 构建产物、D1/R2 绑定和静态资源，建议使用 Git 构建以保证构建结果可重复。

## 7. 配置自定义域名和 Email Routing

### 自定义域名

1. 打开 `latchmail` Worker → **Settings → Domains & Routes**。
2. 添加正式自定义域名，例如 `inbox.example.com`。
3. 确认该域名与 `APP_ORIGIN` 完全一致。
4. 等待 TLS 状态正常后再测试登录。

### Email Routing Catch-all

1. 打开对应域名 → **Email Routing**。
2. 确认域名已经启用 Email Routing。
3. 创建或编辑 Catch-all 规则。
4. 动作选择 **Send to a Worker**，目标选择 `latchmail`。
5. 确认没有意外覆盖现有的 MX 或更高优先级的特定地址规则。
6. 回到 Latchmail WebUI，在设置页添加并启用同一个域名。

## 8. 首次部署验证

按以下顺序验证：

1. 访问 `https://inbox.example.com/healthz`，应返回 HTTP 200 和 `{"status":"ok"}`。
2. 打开 WebUI，输入 `ADMIN_PASSWORD`。
3. 在浏览器 Network 面板确认 `POST /api/auth/login` 返回 200，并设置 `__Host-latchmail-session` Cookie。
4. 刷新页面，确认仍保持登录；退出后再次访问应回到登录页。
5. 在 WebUI 添加并启用一个测试域名。
6. 从外部邮箱向一个已登记地址发送邮件，确认：
   - Email Routing 将邮件交给 Worker；
   - WebUI 能看到邮件；
   - D1 出现消息索引；
   - R2 出现原始 EML 和解析 payload；
   - 原始 EML/附件下载需要登录。
7. 再向同一启用域名下的随机未登记地址发信，确认仍然可以收件。
8. 如果配置了 Webhook，确认接收端验证签名、原始字节完整性和 `event_id` 幂等。
9. 如果配置了 `ADMIN_API_TOKEN`，使用该 Token 调用受保护 API；确认 `ADMIN_PASSWORD` 作为 Bearer Token 会被拒绝。

示例：

```bash
curl -i https://inbox.example.com/healthz
curl -i https://inbox.example.com/api/domains \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>"
```

## 9. 回滚和变更注意事项

- Worker 代码回滚：打开 **Deployments → Version history**，选择已验证的旧版本并重新部署。
- D1 和 R2 数据不会随 Worker 版本自动回滚。不要在迁移已经执行后直接回滚到不兼容的旧代码。
- 修改管理员密码：更新 `ADMIN_PASSWORD` Secret 并部署新版本；现有 Cookie 会话仍由 `SESSION_SECRET` 控制。
- 让所有浏览器会话立即失效：轮换 `SESSION_SECRET`，然后部署。
- 现有版本从 `ADMIN_TOKEN` 迁移时，先添加新版本需要的 `ADMIN_PASSWORD` 和 `ADMIN_API_TOKEN`，验证新版本成功后再删除旧 Secret。
- 发生邮件事故时，先暂停 Email Routing 或 Catch-all，保留 D1/R2 数据，再进行代码回滚和端到端验证。

## 10. 控制台部署完成清单

- [ ] D1 `latchmail-production` 已创建并执行初始化 SQL
- [ ] 私有 R2 bucket 已创建
- [ ] `DB`、`MAIL_STORAGE`、`ASSETS` 绑定名称正确
- [ ] production `APP_ORIGIN` 已替换为正式 HTTPS Origin
- [ ] `ADMIN_PASSWORD` 和 `SESSION_SECRET` 已作为加密 Secret 配置
- [ ] 可选 `ADMIN_API_TOKEN` / `WEBHOOK_SIGNING_SECRET` 已按需配置
- [ ] Workers Builds 成功并部署了最新版本
- [ ] 自定义域名 TLS 正常
- [ ] Email Routing Catch-all 指向正确 Worker
- [ ] 登录、刷新、退出和 CSRF 写操作已验证
- [ ] 已完成真实外部邮件、随机地址、R2/D1 和 Webhook 验收
