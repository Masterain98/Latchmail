[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT_CN.md)

# 运维部署

建议的正式结构是一个 Worker、一个 D1 数据库、一个私有 R2 bucket 和自动生成的每分钟 Cron。资源名称由用户自定；`latchmail-db`、`latchmail-mail` 等仅为建议，不是要求。

## 前置条件

部署前创建 D1 和 R2，并保持 R2 私有。记录 D1 名称与 UUID，以及 R2 bucket 名称。为 `npm run deploy:cloudflare` 配置以下进程环境：

| 变量 | 是否必需 | 含义 |
| --- | --- | --- |
| `LATCHMAIL_WORKER_NAME` | Workers Builds 之外需要 | 已有或准备创建的 Worker 名称 |
| `LATCHMAIL_D1_DATABASE_NAME` | 是 | 已有 D1 数据库名称 |
| `LATCHMAIL_D1_DATABASE_ID` | 是 | 已有 D1 UUID |
| `LATCHMAIL_R2_BUCKET_NAME` | 是 | 已有私有 R2 bucket 名称 |
| `APP_ORIGIN` | 是 | WebUI 的准确 HTTPS Origin，不含结尾 `/` |
| `ENVIRONMENT` | 否 | 运维环境标签，默认 `production` |

将 `ADMIN_PASSWORD` 和 `SESSION_SECRET` 设置为相互独立的 32～4096 字符值。`ADMIN_API_TOKEN` 可选。仅在启用 Webhook 时需要 `WEBHOOK_SIGNING_SECRET`，其值必须是正好 32 个随机字节的标准 Base64。部署命令会校验但不会打印这些值，并通过被忽略的临时 Secrets 文件上传。

在 Workers Builds 之外运行时，应通过 Wrangler 交互登录，或提供标准的 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN`。这些是 Cloudflare CLI 凭据，不是 Latchmail 运行时绑定。只授予发布 Worker 和绑定已有资源所需的权限；运行时 D1 初始化不需要该 Token 执行迁移。

## 部署

运行：

```bash
npm ci
npm run check
npm run deploy:cloudflare
```

命令会构建 WebUI，在被忽略的 `.wrangler/` 目录中生成临时部署清单，上传 Worker 和运行时 Secrets，并删除两个临时文件。仓库中没有需要定制的 Wrangler 配置。

部署后请求 `/healthz`。Worker 通过 `DB` 绑定以事务方式创建或升级数据库结构，只有打包的编号迁移全部就绪后才返回 `database: ready`。不得修改已经执行的迁移；应添加下一个编号 SQL 文件，并在 Worker 迁移列表中登记。测试会拒绝未登记的迁移。

staging 必须使用独立 Worker、D1、R2 和独立环境值，不要让预览环境共享生产邮件。保持 `SESSION_SECRET` 不变可以保留浏览器会话；轮换它会使全部会话失效。修改 `ADMIN_PASSWORD` 会改变后续登录密码，`ADMIN_API_TOKEN` 可以独立轮换。

## 发布与回滚

迁移在发布过程中必须兼容上一 Worker 版本。运行时迁移器把每个编号文件与对应账本记录放在同一个 D1 事务中。失败迁移会回滚，并在后续调用中重试；部分或冲突的第一版结构会停止运行。

`/healthz` 成功后，依次验证密码登录、Cookie/CSRF 写操作、可选 Bearer 访问、私有下载、Cron 和受控 Webhook，再接入 Email Routing。除非确实要替换，否则保留现有 MX。

没有授权凭据时，Cloudflare 账户、DNS 和真实邮件验证记为 `MANUAL_PENDING`。
