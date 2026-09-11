[English](ARCHITECTURE.md) · [简体中文](ARCHITECTURE_CN.md)

# 架构

一个 Module Worker 导出 `fetch`、`email` 和 `scheduled`。React/Vite SPA 作为 Workers Static Assets 部署；`/api/*`、`/healthz` 和本地邮件模拟路径优先由 Worker 处理。D1 保存有界索引、当前关系、租约和任务状态；私有 R2 保存 `raw/`、不可变的 `content/` payload 以及解码后的 `attachments/`。

收件顺序为：校验启用的 Envelope 域名 → 快照当前登记信息和设置 → 将完整原始字节流式写入 R2 并计算哈希 → 通过 D1 批处理发布邮件、七天去重键和可选的等待中 Outbox → 使用 `waitUntil` 加速与 Cron 相同的维护函数。R2 和 D1 不被伪装成分布式事务；出现不明确写入时，会在清理候选对象前再次检查。

解析任务以全局租约逐封邮件处理，使用 run ID，写入每个附件和不可变 JSON payload，然后通过条件 D1 更新发布该 run。连续三次启动失败后，降级 payload 仍会引用完整的原始 EML。Webhook 任务独立租约，最多同时发送两个；进程终止后可以恢复。

保留期采用每封邮件的快照。在 `expires_at` 到期时，即使物理清理尚未发生，原始邮件和附件读取也会返回 410。每小时有界清理任务删除附件对象和原始 EML；永久删除邮件会立即取消投递，并为所有引用对象安排幂等清理。`content/` 会一直保留到邮件本身被删除。
