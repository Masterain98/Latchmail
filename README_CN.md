[English](README.md) · [简体中文](README_CN.md)

# Latchmail

Latchmail 是一个部署在 Cloudflare 上的单管理员、仅收件 Catch-all 邮箱。已启用域名下的任意地址都能接收；地址登记只提供当前标签和备注，不是地址白名单。邮件先把完整原始 EML 可靠写入私有 R2，再通过 D1 可恢复任务解析、展示并投递完整 Webhook。

## 功能

- 一个 Module Worker 同时处理 HTTP、Email Routing 和每分钟 Cron
- D1 管理域名、标签、完整地址登记、邮件索引、租约、Outbox 与维护状态
- R2 私有保存 raw EML、不可变 payload JSON 和全部普通/CID 附件
- React/Vite 中英文管理端：自动识别浏览器语言并记住显式选择，支持搜索、组合筛选、已读、归档、删除、正文、附件，以及带 48 小时发送诊断的独立 Webhook 工作区
- `payload` JSON + `raw_email` EML 两部分流式 multipart Webhook，HMAC-SHA256 签名，有限自动重试和人工重投
- 1～3650 天附件/raw 保留快照，逻辑到期立即拒绝读取，Cron 幂等物理删除
- Cookie/CSRF/Bearer 鉴权、持久化登录限速、Webhook 目标校验、隔离邮件 HTML

不包含发信、回复、转发、SMTP/IMAP/POP、多用户、公开临时邮箱、AI、验证码提取或 Push。

## 本地启动

要求 Node.js 22+。

```bash
npm ci
copy .dev.vars.example .dev.vars
npm run dev
```

在 `.dev.vars` 中设置相互独立的 `ADMIN_PASSWORD` 和 `SESSION_SECRET`。`ADMIN_API_TOKEN` 是可选的，用于启用 Bearer API 鉴权；仅在启用 Webhook 时才需要 `WEBHOOK_SIGNING_SECRET`，其值必须是恰好 32 个随机字节的标准 Base64。本地 Worker 使用自动生成且被忽略的部署清单，并自动初始化 D1 结构。浏览器打开 `http://127.0.0.1:8787`。新增并启用 `example.com` 后，可在另一个终端提交合成邮件：

```bash
npm run email:fixture -- tests/fixtures/attachment.eml sender@example.net asus@example.com
```

开发时也可分别运行 `npm run dev:web` 与 `npm run dev:worker`，Vite 会把 API 代理到本地 Worker。

## 验证

```bash
npm run check
npm run test:e2e
node scripts/measure-mail.mjs
```

`check` 串行执行类型、lint、单元测试、Workers D1/R2 集成测试、前端构建和 Wrangler dry-run。真实 MX/Email Routing、SMTP 故障语义和外部 HTTPS Webhook 仍需在已授权 staging 环境完成。

## Webhook 结构

Latchmail 发送完整邮件 Webhook 时使用一次 `POST multipart/form-data`，固定包含两个 part：

- `payload`：`application/json; charset=utf-8`，描述事件、邮件元数据、解析结果和附件索引
- `raw_email`：`message/rfc822`，完整原始 EML；附件已经包含在 EML 中，不会作为额外 part 重复发送

`payload` 的核心结构如下：

```json
{
  "schema_version": "1.0",
  "event": "email.received",
  "event_id": "uuid",
  "occurred_at": "2026-09-11T09:30:00.000Z",
  "data": {
    "message_id": "uuid",
    "domain": "example.com",
    "received_at": "2026-09-11T09:30:00.000Z",
    "envelope": {
      "from": "sender@example.net",
      "to": "team@example.com",
      "to_normalized": "team@example.com"
    },
    "registration": null,
    "parse_status": "ready",
    "parse_error": null,
    "headers": [{ "name": "Subject", "value": "Hello" }],
    "rfc_message_id": "<message@example.net>",
    "from": { "address": "sender@example.net", "name": null },
    "to": [{ "address": "team@example.com", "name": null }],
    "cc": [],
    "reply_to": [],
    "bcc_observed": [],
    "subject": "Hello",
    "text": "Plain text body",
    "html": null,
    "attachments": [],
    "raw_email": {
      "part_name": "raw_email",
      "filename": "message-id.eml",
      "content_type": "message/rfc822",
      "size_bytes": 1234,
      "sha256": "hex-encoded-sha256",
      "expires_at": "2026-10-11T09:30:00.000Z"
    }
  }
}
```

请求还带有 `X-Inbox-Event-Id`、`X-Inbox-Delivery-Id`、`X-Inbox-Timestamp`、`X-Inbox-Payload-SHA256` 和 `X-Inbox-Signature: v1,<base64>`。签名输入是 `event_id.delivery_id.timestamp.payload_sha256`，使用配置的 32 字节密钥执行 HMAC-SHA256。接收端应先校验原始 payload 字节、签名、时间窗口和 SHA-256，再解析 JSON，并以 `event_id` 做幂等去重。

任意 2xx 表示成功；网络错误、超时、408、425、429 和 5xx 会重试，其余 4xx 终止自动重试。重试最多 8 次，最长 24 小时或直到原始邮件过期。完整字段和示例接收器见 [Webhook 协议](docs/WEBHOOK_CN.md)。

## 部署

Latchmail 不提交 Wrangler 配置文件，也不要求部署用户修改仓库文件。先在自己的账户中创建任意合适名称的 D1 数据库和私有 R2 bucket，再配置以下 Workers Builds 变量：

- 必需填写 `LATCHMAIL_D1_DATABASE_NAME`、`LATCHMAIL_D1_DATABASE_ID`、`LATCHMAIL_R2_BUCKET_NAME` 和精确的 HTTPS `APP_ORIGIN`。
- `ENVIRONMENT` 可选，默认 `production`；Workers Builds 会提供所连接的 Worker 名称，外部 CLI 部署时也可以设置 `LATCHMAIL_WORKER_NAME`。
- 将 `ADMIN_PASSWORD` 和 `SESSION_SECRET` 保存为加密构建 Secret；`ADMIN_API_TOKEN` 与 `WEBHOOK_SIGNING_SECRET` 仍为可选项。

将 Builds 的部署命令设置为 `npm run deploy:cloudflare`。该命令会校验变量、构建 WebUI、生成被忽略的临时部署清单和 Secrets 文件、上传 Worker，并删除临时文件。首次访问时，Worker 通过 D1 绑定以事务方式应用尚未执行的编号迁移；不需要手动执行 SQL，也不存在传统数据库连接字符串。`latchmail-db`、`latchmail-mail` 等资源名仅是建议示例，并非强制值。

完整网页操作请参阅 [Cloudflare 网页控制台部署指南](docs/DEPLOYMENT_CLOUDFLARE_DASHBOARD_CN.md)，本地 CLI 部署请参阅 [运维部署指南](docs/DEPLOYMENT_CN.md)。不要覆盖仍在使用的现有 MX。

详细资料：[架构](docs/ARCHITECTURE_CN.md) · [API](docs/API_CN.md) · [WebUI 多语言](docs/I18N_CN.md) · [品牌素材](docs/BRAND_ASSETS_CN.md) · [Webhook](docs/WEBHOOK_CN.md) · [部署](docs/DEPLOYMENT_CN.md) · [Cloudflare 网页控制台部署](docs/DEPLOYMENT_CLOUDFLARE_DASHBOARD_CN.md) · [运维](docs/OPERATIONS_CN.md) · [测试](docs/TESTING_CN.md)

MIT licensed.
