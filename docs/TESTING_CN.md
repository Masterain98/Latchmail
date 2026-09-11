[English](TESTING.md) · [简体中文](TESTING_CN.md)

# 测试

命令定义在 `package.json` 中：`typecheck`、`lint`、`test`、`test:integration`、`test:e2e`、`build`、`deploy:cloudflare` 以及聚合命令 `check`。除规范化、契约和会话外，单元测试还覆盖部署值校验、临时 Secret 清理、迁移登记和 SQL 拆分。Workers 运行时集成测试使用 Miniflare D1/R2 覆盖空库初始化、并发调用、旧库基线、部分结构拒绝、事务回滚/重试、API 鉴权、未登记收件、原始字节精确保留、调度解析、去重、动态标签、附件和保留期。合成 fixture 覆盖纯文本和附件 MIME。

`node scripts/measure-mail.mjs` 会测量本地 postal-mime 对 0.5、1、5 和 20 MiB 邮件的解析性能。这些数据只描述当前机器，不是 Cloudflare SLA。C01（外部 SMTP 路由）和 C02（实际平台故障/重试语义）需要经过授权的 staging 资源，目前仍由人工验证。

时间敏感服务接受显式 `now` 值；生命周期测试推进注入的时钟，而不是等待真实时间。网络投递应使用受控 HTTPS 端点测试 2xx、3xx、4xx、429 和 503。生产邮件绝不能变成测试 fixture。

`npm run check` 最后会使用确定性的非生产值生成清单并执行 Wrangler dry-run；不需要提交配置文件或提供 Cloudflare 凭据。没有授权资源时，实际控制台部署、DNS、Email Routing 和真实邮件行为仍记为 `MANUAL_PENDING`。
