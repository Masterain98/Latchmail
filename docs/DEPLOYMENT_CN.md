[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT_CN.md)

# 部署

仅使用 Cloudflare 网页控制台的流程见 [网页控制台部署](DEPLOYMENT_CLOUDFLARE_DASHBOARD_CN.md)。下面的步骤使用经过授权的运维环境运行 Wrangler。

推荐生产方案：Workers Paid、一个 Worker、一个 D1 数据库、一个私有 R2 bucket 和一个 `* * * * *` Cron。创建彼此独立的 staging 和 production 资源，只替换 `wrangler.jsonc` 中的占位资源 ID/Origin，不要共享数据。

1. 安装 Node 22+，运行 `npm ci` 和 `npm run check`，创建 D1/R2 资源，并执行目标迁移命令。
2. 在 Cloudflare Dashboard 的目标 Worker **Settings → Variables and Secrets** 中，将 `ADMIN_PASSWORD` 和 `SESSION_SECRET` 设置为彼此独立、至少 32 个高熵字符的加密 Secret。可选地添加独立的 `ADMIN_API_TOKEN` 以启用 Bearer API。只有启用 Webhook 时才添加 `WEBHOOK_SIGNING_SECRET`；它必须是正好编码 32 个随机字节的标准 Base64。不要将这些值放到明文变量或 `wrangler.jsonc`。
3. CLI 方式可以运行 `wrangler secret put ADMIN_PASSWORD --env <environment>`、`wrangler secret put SESSION_SECRET --env <environment>`，以及可选的 `ADMIN_API_TOKEN` 和 `WEBHOOK_SIGNING_SECRET` 对应命令。
4. 设置真实的同源 HTTPS `APP_ORIGIN`，部署 staging，验证密码登录、Cookie/CSRF 写操作、可选 Bearer 访问和私有下载，再从经过批准的运维环境手动部署 production。
5. 对每个域名启用 Cloudflare Email Routing，避免无意覆盖现有邮件服务商。配置域名或显式子域名的 MX/路由，将 Catch-all 设置为 Send to Worker，然后在应用中登记并启用完全相同的域名。现有特定地址规则可能具有更高优先级。
6. 从独立外部邮箱向一个已登记地址和一个随机未登记地址发信。在认定云端验收完成前，确认 Worker → WebUI → HTTPS Webhook 链路和一次强制重试。

对于现有部署，在部署此版本前先添加 `ADMIN_PASSWORD` 和可选的 `ADMIN_API_TOKEN`。在回滚窗口内保留旧的 `ADMIN_TOKEN`，切换 API 客户端，并在验收通过后删除旧 Secret。保持 `SESSION_SECRET` 不变可以保留现有浏览器会话；轮换它会使所有会话失效。

附件保留期以及 Webhook URL/启用状态仍然是 D1 中的运行时应用设置，可以在 WebUI 中修改而无需重新部署 Worker。

本地 `.eml` 提交：运行 Wrangler，迁移本地 D1，添加启用的域名，然后执行 `npm run email:fixture -- tests/fixtures/attachment.eml sender@example.net asus@example.com`。登记界面支持常见 ASCII local-part；投递的国际化 local-part 不会被登记校验拒绝，而是按照明确的小写应用策略存储。
