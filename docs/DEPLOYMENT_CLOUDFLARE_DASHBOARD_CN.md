[English](DEPLOYMENT_CLOUDFLARE_DASHBOARD.md) · [简体中文](DEPLOYMENT_CLOUDFLARE_DASHBOARD_CN.md)

# 使用 Cloudflare 网页控制台部署

本指南通过 Cloudflare Workers Builds 从 Git 仓库部署 Latchmail。用户不需要修改仓库文件，不需要向 D1 手工粘贴 SQL，也不需要传统数据库连接字符串。

## 1. 创建存储资源

在 **Storage & Databases → D1** 创建数据库，并记录其名称和 UUID。在 **R2 Object Storage** 创建私有 bucket，并记录名称。请根据账户实际情况命名；`latchmail-db` 和 `latchmail-mail` 仅是示例。两个资源不必同名，也不强制包含 `production`。

不要启用公开 `r2.dev` 地址。原始 EML、不可变结构化 payload 和附件必须保持私有。

如需独立 staging，请分别创建 Worker、D1 和 R2。staging 与 production 不得共用存储资源。

## 2. 连接仓库

1. 打开 **Workers & Pages**，新建或选择承载 Latchmail 的 Worker，在 **Settings → Builds** 中连接 Git 仓库。
2. 选择正式分支。默认关闭非正式分支部署，避免预览代码访问生产邮件或 Secrets。
3. 构建命令留空，部署命令填写：

   ```text
   npm run deploy:cloudflare
   ```

Cloudflare 会通过 `WRANGLER_CI_OVERRIDE_NAME` 提供已连接的 Worker 名称。部署脚本会创建被忽略的临时清单、上传 Worker，并在结束后删除清单；因此不会触发 Cloudflare 无配置自动生成配置文件或配置 PR。

## 3. 添加构建变量

在 **Settings → Builds → Variables and secrets** 中添加以下普通构建变量：

| 名称 | 是否必需 | 内容 |
| --- | --- | --- |
| `LATCHMAIL_D1_DATABASE_NAME` | 是 | 上一步创建的 D1 数据库准确名称 |
| `LATCHMAIL_D1_DATABASE_ID` | 是 | D1 概览页显示的 UUID |
| `LATCHMAIL_R2_BUCKET_NAME` | 是 | 私有 R2 bucket 的准确名称 |
| `APP_ORIGIN` | 是 | 对外访问所用的准确 HTTPS Origin，不含路径和结尾 `/` |
| `ENVIRONMENT` | 否 | 运维环境标签，默认 `production` |
| `LATCHMAIL_WORKER_NAME` | Workers Builds 中不需要 | 仅在 Cloudflare 没有提供 `WRANGLER_CI_OVERRIDE_NAME` 时使用 |

`APP_ORIGIN` 必须与浏览器 Origin 完全一致，例如 `https://mail.example.com` 或分配到的 `workers.dev` Origin。它不能包含路径、查询、片段或结尾 `/`，因为登录后的写操作会精确比较该值。

D1 名称和 ID 是绑定标识，不是凭据。程序通过 `DB` 绑定访问 D1；不需要配置主机、端口、用户名、密码或连接 URL。

## 4. 添加加密构建 Secrets

在同一 Builds 设置中将以下内容保存为加密构建 Secret。它们只对可信构建可见，并在部署时同步为 Worker 运行时 Secret。

| 名称 | 是否必需 | 要求 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 是 | 独立生成的 32～4096 字符高熵值 |
| `SESSION_SECRET` | 是 | 与管理员密码不同的 32～4096 字符高熵值 |
| `ADMIN_API_TOKEN` | 否 | 独立的 32～4096 字符 Bearer 凭据；新部署不配置时禁用 Bearer 访问 |
| `WEBHOOK_SIGNING_SECRET` | 仅启用 Webhook 时 | 正好 32 个随机字节的标准 Base64 编码 |

不要把管理员密码复用为其他密钥，也不要把这些值设为普通变量。部署脚本可以读取构建 Secret，因此只应连接可信仓库和正式分支。

Secret 上传采用增量方式：后续构建中省略可选 Secret 不会删除已经部署的 Secret。如需停用，请在 **Settings → Variables and Secrets** 中删除对应运行时 Secret。

## 5. 部署和自动初始化

触发正式构建。命令会在上传前校验所有实例值和 Secret 格式，构建双语 WebUI，绑定已有 D1/R2，加入私有 Assets 绑定与每分钟 Cron，最后删除临时清单和 Secrets 文件。

Worker 通过已经绑定的 D1 自行初始化。第一次 `/healthz`、API、邮件或定时事件会创建迁移账本，识别已经执行的编号迁移，并以事务批次只执行待处理项。新的空数据库会自动获得 `0001_initial.sql`；完整的旧版第一版结构会补记基线；部分或冲突结构会停止运行，而不是被覆盖。

打开 `/healthz`，应得到 HTTP `200`：

```json
{ "status": "ok", "database": "ready" }
```

若为 HTTP `503` 且 `database` 是 `migration_failed`，表示初始化失败。配置邮件路由前先查看 Worker 日志；不要手工把迁移标记为已执行。

## 6. 域名和 Email Routing

为 Worker 使用预期的 `workers.dev` 地址或自定义域名，并确认 Origin 与 `APP_ORIGIN` 完全一致。健康检查成功后再配置 Cloudflare Email Routing，把 catch-all 路由到该 Email Worker。除非确实要替换原服务，否则不要覆盖现有 MX。

使用 `ADMIN_PASSWORD` 登录后，在 Latchmail 中新增并启用各收件域名。启用域名下的未知地址仍可收件；地址登记只添加标签和备注。

## 7. 验收清单

- `/healthz` 返回 `database: ready`，D1 的 `d1_migrations` 中存在 `0001_initial.sql`。
- 密码登录、刷新保持会话、退出和 CSRF 写操作正常。
- `ADMIN_PASSWORD` 作为 Bearer Token 会被拒绝；可选 `ADMIN_API_TOKEN` 仅在配置后有效。
- R2 没有公开端点，原始邮件和附件下载必须鉴权。
- 向启用域名的未登记地址发送受控测试邮件后，WebUI 能显示邮件。
- Cron 维护以及启用后的签名 Webhook 能正常完成。

在没有授权资源时，Cloudflare 账户、DNS 和真实邮件检查均记为 `MANUAL_PENDING`。
