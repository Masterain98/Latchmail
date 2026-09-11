[English](TESTING.md) · [简体中文](TESTING_CN.md)

# 测试

命令定义在 `package.json` 中：`typecheck`、`lint`、`test`、`test:integration`、`test:e2e`、`build` 以及聚合命令 `check`。单元测试覆盖规范化、加号/点号身份、Envelope/登记边界、契约、会话和重试常量。Workers 运行时集成测试会应用真实 D1 迁移，并使用 Miniflare D1/R2 覆盖 API 鉴权、未登记收件、原始字节精确保留、调度解析、并发安全去重身份、收件后动态标签、重复附件名、不同哈希、逻辑过期和物理原始邮件/附件清理，同时保留结构化内容。合成 fixture 覆盖纯文本和附件 MIME。

`node scripts/measure-mail.mjs` 会测量本地 postal-mime 对 0.5、1、5 和 20 MiB 邮件的解析性能。这些数据只描述当前机器，不是 Cloudflare SLA。C01（外部 SMTP 路由）和 C02（实际平台故障/重试语义）需要经过授权的 staging 资源，目前仍由人工验证。

时间敏感服务接受显式 `now` 值；生命周期测试推进注入的时钟，而不是等待真实时间。网络投递应使用受控 HTTPS 端点测试 2xx、3xx、4xx、429 和 503。生产邮件绝不能变成测试 fixture。
