[English](API.md) · [简体中文](API_CN.md)

# 管理 API

所有业务路由使用 `/api` 前缀。成功响应格式为 `{ "data": ... }`，结构化错误格式为 `{ "error": { "code", "message", "request_id" } }`。浏览器通过 `POST /api/auth/login` 提交 `{ "password": "<ADMIN_PASSWORD>" }`，随后使用签名的 `__Host-` HttpOnly Cookie；写操作还要求 Origin 和 `X-CSRF-Token`。配置了独立可选 Secret 后，自动化程序可以使用 `Authorization: Bearer <ADMIN_API_TOKEN>`。管理员密码不能作为 Bearer 凭据使用。

已实现的接口组包括：`auth/login|logout|session`；`domains`、`tags`、`addresses` 的 CRUD；`messages` 的游标列表、详情、PATCH、DELETE 和原始邮件下载；附件下载；保留期 `settings`；Webhook 查询、更新、测试、投递列表、详情、重试、取消和按邮件入队；系统状态和有界维护任务。`GET` 请求不会将邮件标记为已读。

列表筛选参数包括：`cursor`、`limit`、`domain_id`、`tag_id`、`recipient`、`registered`、`untagged`、`unread`、`archived`、`webhook_status`、`q`。默认限制为 50，最大为 100。搜索使用参数化且有界的 D1 `instr()` 查询，只搜索元数据和当前登记信息，不会下载 R2 正文。

预期状态码：400 表示校验失败，401 表示未认证，403 表示 CSRF/Origin 失败，404 表示不存在，409 表示冲突，410 表示内容已过期，429 表示登录限速。敏感响应使用 `Cache-Control: private, no-store`。
