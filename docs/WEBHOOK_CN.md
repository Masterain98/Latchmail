[English](WEBHOOK.md) · [简体中文](WEBHOOK_CN.md)

# Webhook 协议 1.0

每次请求都是一个 `POST multipart/form-data`，固定包含 `payload`（`application/json; charset=utf-8`）和 `raw_email`（`message/rfc822`）两个 part。重试期间 JSON 字节和 EML 字节保持不变；只有随机 boundary、时间戳和签名会改变。附件已经包含在 EML 中，不会作为额外 part 重复发送。

请求头包括：`X-Inbox-Event-Id`、`X-Inbox-Delivery-Id`、`X-Inbox-Timestamp`、`X-Inbox-Payload-SHA256` 和 `X-Inbox-Signature: v1,<base64>`。接收端应解码配置的标准 Base64 32 字节密钥，并对 UTF-8 字符串 `event_id.delivery_id.timestamp.payload_sha256` 执行 HMAC-SHA256。应在解析 JSON 前验证原始 payload 字节，要求时间戳在五分钟内，匹配 event ID，然后从已认证的 payload 中流式校验原始邮件大小和 SHA-256。

任意 2xx 都表示成功。网络错误、超时、408、425、429 和 5xx 会重试；请求不会跟随重定向，其他 4xx 会终止自动重试周期。退避时间为 1 分钟、5 分钟、15 分钟、1 小时、3 小时、6 小时和 12 小时，并带少量抖动；最多八次尝试，最长 24 小时或直到原始邮件过期。不确定响应可能造成重复投递；接收端必须按 `event_id` 实现幂等。

运行示例接收器：`WEBHOOK_SIGNING_SECRET=<base64-32-bytes> node examples/webhook-receiver/server.mjs`。它会校验两个 part、签名和原始完整性，只在 `examples/webhook-receiver/data` 保存有界元数据/payload，并对重复 event ID 返回 2xx。真实 Worker 投递时应将接收器置于 HTTPS 后。
