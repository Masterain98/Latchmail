[English](ARCHITECTURE.md) · [简体中文](ARCHITECTURE_CN.md)

# 架构

一个 Module Worker 导出 `fetch`、`email` 和 `scheduled`。React/Vite SPA 作为 Workers Static Assets 部署；`/api/*`、`/healthz` 和本地邮件模拟路径优先由 Worker 处理。D1 保存有界索引、当前关系、租约和任务状态；私有 R2 保存 `raw/`、不可变的 `content/` payload 以及解码后的 `attachments/`。

仓库不包含部署清单。构建时根据实例变量生成被忽略的临时清单，并使用固定的 `DB`、`MAIL_STORAGE` 和 `ASSETS` 绑定。在 API、邮件或定时操作使用 D1 前，共用初始化器会读取与 Wrangler 兼容的 `d1_migrations` 账本并执行待处理的编号 SQL。每项迁移和账本写入位于同一个 D1 批处理事务中；并发初始化器只会有一个提交，其余实例读取已提交账本。完整旧版结构可以补记基线，部分结构则停止运行。

项目有意不使用 Workers KV。会话采用签名 Cookie，静态文件使用 Workers Assets；启用域名、登录限速、去重、租约和设置都需要权威的 D1 状态。最终一致的 KV 副本会增加失效处理，目前也没有证据表明它能改善实际瓶颈。

收件顺序为：校验启用的 Envelope 域名 → 快照当前登记信息和设置 → 将完整原始字节流式写入 R2 并计算哈希 → 通过 D1 批处理发布邮件、七天去重键和可选的等待中 Outbox → 使用 `waitUntil` 加速与 Cron 相同的维护函数。R2 和 D1 不被伪装成分布式事务；出现不明确写入时，会在清理候选对象前再次检查。

解析任务以全局租约逐封邮件处理，使用 run ID，写入每个附件和不可变 JSON payload，然后通过条件 D1 更新发布该 run。连续三次启动失败后，降级 payload 仍会引用完整的原始 EML。Webhook 任务独立租约，最多同时发送两个；进程终止后可以恢复。

保留期采用每封邮件的快照。在 `expires_at` 到期时，即使物理清理尚未发生，原始邮件和附件读取也会返回 410。每小时有界清理任务删除附件对象和原始 EML；永久删除邮件会立即取消投递，并为所有引用对象安排幂等清理。`content/` 会一直保留到邮件本身被删除。
