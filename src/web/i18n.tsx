import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Locale = "zh-CN" | "en";
type Params = Record<string, string | number>;

const STORAGE_KEY = "latchmail.locale";

const chinese: Record<string, string> = {
  available: "可用",
  deleting: "正在删除",
  deleted: "已删除",
  waiting_content: "等待内容",
  pending: "待投递",
  retry_wait: "等待重试",
  inflight: "投递中",
  paused: "已暂停",
  succeeded: "已送达",
  failed: "失败",
  expired: "已过期",
  canceled: "已取消",
};

const english: Record<string, string> = {
  available: "Available",
  deleting: "Deleting",
  deleted: "Deleted",
  waiting_content: "Waiting for content",
  pending: "Pending",
  retry_wait: "Waiting to retry",
  inflight: "Delivering",
  paused: "Paused",
  succeeded: "Delivered",
  failed: "Failed",
  expired: "Expired",
  canceled: "Canceled",
  "加载失败": "Couldn't load the data.",
  "关闭": "Close",
  "登录失败": "Sign-in failed.",
  "你的收件台": "Your mail console",
  "只接收、可靠保存，再把完整邮件交给你的处理服务。":
    "Receive only, store reliably, then deliver the complete message to your processing service.",
  "管理员口令": "Admin token",
  "正在验证…": "Verifying…",
  "进入收件箱": "Open inbox",
  "会话保存在安全的 HttpOnly Cookie 中，不写入浏览器存储。":
    "Your session stays in a secure HttpOnly cookie and is never written to browser storage.",
  "收件箱": "Inbox",
  "地址登记": "Address registry",
  "设置与运维": "Settings & operations",
  "退出登录": "Sign out",
  "单管理员 · 仅收件": "Single admin · Receive only",
  "切换语言": "Switch language",
  "所有来信": "All messages",
  "登记只影响标签；任何已启用域名下的地址都可以收件。":
    "Registration only affects labels; every address on an enabled domain can receive mail.",
  "刷新": "Refresh",
  "视图": "Views",
  "全部收件": "All mail",
  "未读": "Unread",
  "未登记地址": "Unregistered",
  "已登记未打标签": "Registered, untagged",
  "标签": "Labels",
  "域名": "Domain",
  "搜索主题、发件人、收件地址或登记信息":
    "Search subject, sender, recipient, or registry",
  "归档": "Archived",
  "正在读取邮件索引…": "Loading message index…",
  "标记未读": "Mark unread",
  "标记已读": "Mark read",
  "（无主题）": "(No subject)",
  "解析失败": "Parse failed",
  "发给 {{address}}": "To {{address}}",
  "尚无正文摘要": "No message preview",
  "{{count}} 个附件": "{{count}} attachment(s)",
  "通知 {{status}}": "Webhook {{status}}",
  "未请求通知": "No webhook requested",
  "这里还没有邮件": "No messages yet",
  "先在设置中登记并启用域名，然后把 Cloudflare Email Routing 的 Catch-all 指向此 Worker。":
    "Register and enable a domain in Settings, then point Cloudflare Email Routing Catch-all to this Worker.",
  "正在读取完整邮件…": "Loading complete message…",
  "返回": "Back",
  "返回收件箱": "Back to inbox",
  "取消归档": "Unarchive",
  "永久删除这封邮件？此操作会取消待处理通知并清理 R2 对象，无法恢复。":
    "Permanently delete this message? Pending webhooks will be canceled and its R2 objects removed. This cannot be undone.",
  "永久删除": "Delete permanently",
  "Envelope 发件人": "Envelope sender",
  "实际投递地址": "Delivered address",
  "未声明": "Not declared",
  "收到时间": "Received",
  "已保存原始邮件，但结构化解析失败：{{code}}":
    "The raw message is safe, but structured parsing failed: {{code}}",
  "纯文本": "Plain text",
  "HTML（隔离）": "HTML (sandboxed)",
  "隔离的邮件 HTML 正文": "Sandboxed HTML message body",
  "该格式没有正文": "No body in this format",
  "切换到邮件实际包含的正文格式，或下载原始 EML。":
    "Choose a body format included in the message, or download the raw EML.",
  "已登记": "Registered",
  "尚未打标签": "Untagged",
  "管理此地址": "Manage this address",
  "此地址尚未登记，但不影响当前或后续收件。":
    "This address is not registered, but current and future mail will still arrive.",
  "登记并添加标签": "Register and label",
  "附件与原始邮件": "Attachments & raw message",
  "原始 EML": "Raw EML",
  "已过期": "Expired",
  "尝试 {{count}} 次": "{{count}} attempt(s)",
  "人工重投": "Retry now",
  "收件时未创建通知任务。": "No webhook task was created when this message arrived.",
  "保存失败": "Couldn't save the changes.",
  "地址无需登记即可收件；这里仅保存标签和备注，帮助整理历史与未来邮件。":
    "Addresses receive mail without registration. This registry only stores labels and notes for organizing past and future messages.",
  "登记地址": "Register address",
  "完整地址": "Full address",
  "备注": "Note",
  "最近收件": "Last received",
  "修改 {{address}} 的标签": "Change label for {{address}}",
  "未打标签": "Untagged",
  "修改地址备注": "Edit address note",
  "添加备注": "Add note",
  "删除登记": "Delete registration",
  "仅删除登记关系？历史邮件会重新显示为未登记，但仍会继续收件。":
    "Delete only this registration? Past messages will appear unregistered, and mail will continue to arrive.",
  "还没有人工登记的地址": "No registered addresses",
  "随机地址仍能正常接收邮件。需要按用途整理时，再添加一条登记记录。":
    "Random addresses still receive mail. Add a registry entry when you want to organize one by purpose.",
  "登记完整地址": "Register a full address",
  "不会合并加号或点号；地址创建后不可修改。":
    "Plus signs and dots are preserved; the address cannot be changed after creation.",
  "不选择标签": "No label",
  "保存登记": "Save registration",
  "应用登记和 Cloudflare Email Routing 是两个独立步骤；这里不会修改 DNS 或 MX。":
    "App registration and Cloudflare Email Routing are separate steps. Latchmail does not modify DNS or MX records.",
  "执行一次维护": "Run maintenance",
  "接入域名": "Connected domains",
  "在 Cloudflare 控制台配置 Email Routing Catch-all → 此 Worker，再在下方登记同一域名。":
    "In Cloudflare, route Email Routing Catch-all to this Worker, then register the same domain below.",
  "用途备注（可选）": "Purpose note (optional)",
  "添加": "Add",
  "已观测到收件 · {{date}}": "Mail observed · {{date}}",
  "待真实收件验证": "Awaiting a real delivery",
  "修改域名备注": "Edit domain note",
  "停用后将明确拒收该域名的新邮件，历史邮件仍可读取。继续？":
    "Disabling this domain will reject new mail while keeping past messages readable. Continue?",
  "标签改名会立即影响历史邮件的当前显示。":
    "Renaming a label immediately changes how past messages are shown.",
  "例如 ASUS": "For example, ASUS",
  "新建": "Create",
  "{{count}} 个地址": "{{count}} address(es)",
  "重命名 {{name}}": "Rename {{name}}",
  "新的标签名称": "New label name",
  "重命名失败": "Couldn't rename the label.",
  "删除 {{name}}": "Delete {{name}}",
  "删除标签“{{name}}”？被地址使用时系统会拒绝。":
    "Delete label “{{name}}”? The request will be rejected if an address still uses it.",
  "删除失败": "Couldn't delete the item.",
  "附件保留": "Attachment retention",
  "从服务收到邮件时起算；修改只影响之后收到的邮件。":
    "Retention starts when the service receives a message; changes only affect future mail.",
  "保留天数（1～3650）": "Retention days (1–3650)",
  "保存保留期": "Save retention",
  "完整 Webhook": "Complete webhook",
  "一次 HTTPS POST 恰好包含 payload JSON 与完整 raw_email EML，并使用 HMAC-SHA256 签名。":
    "Each HTTPS POST contains exactly one payload JSON part and one complete raw_email EML part, signed with HMAC-SHA256.",
  "更换 URL 会取消旧目标的未完成任务，且不会自动转发到新目标。继续？":
    "Changing the URL cancels unfinished deliveries to the old endpoint; they are not forwarded automatically. Continue?",
  "HTTPS 端点": "HTTPS endpoint",
  "启用新邮件通知；关闭不影响收件":
    "Enable webhooks for new mail; disabling them does not affect receipt",
  "保存 Webhook": "Save webhook",
  "测试请求完成：HTTP {{status}}": "Test request completed: HTTP {{status}}",
  "测试失败": "Webhook test failed.",
  "发送合成测试": "Send synthetic test",
  "签名密钥：": "Signing key: ",
  "已配置": "Configured",
  "未配置，无法发送": "Not configured; sending is disabled",
  "· 端点版本 {{revision}}": "· Endpoint revision {{revision}}",
  "运行状态": "Runtime status",
  "这些是应用可观测统计，不等同于 Cloudflare 账单或 DNS 健康检查。":
    "These are application metrics, not Cloudflare billing data or a DNS health check.",
  "待解析": "Pending parse",
  "通知积压": "Webhook backlog",
  "通知失败": "Webhook failures",
  "待删除对象": "Objects pending deletion",
  "最后调度": "Last scheduled",
  "正在建立安全会话…": "Establishing a secure session…",
  "请先登录。": "Please sign in first.",
  "登录尝试过多，请稍后再试。": "Too many sign-in attempts. Try again later.",
  "管理员口令不正确。": "The admin token is incorrect.",
  "邮箱地址格式无效。": "The email address format is invalid.",
  "Envelope 收件地址格式无效。": "The envelope recipient address is invalid.",
  "请先解除地址对该标签的引用。":
    "Remove this label from its registered addresses first.",
  "该完整地址已登记。": "This full address is already registered.",
  "地址登记不存在。": "The address registration does not exist.",
  "邮件不存在。": "The message does not exist.",
  "原始邮件已过期。": "The raw message has expired.",
  "原始邮件对象不可用。": "The raw message object is unavailable.",
  "Webhook URL 无效。": "The webhook URL is invalid.",
  "Webhook 必须使用无内嵌凭据的 HTTPS URL。":
    "The webhook must use an HTTPS URL without embedded credentials.",
  "Webhook 目标不能指向本地、私网或元数据地址。":
    "The webhook target cannot use a local, private, or metadata address.",
  "无法安全解析 Webhook 域名。": "The webhook hostname could not be resolved safely.",
  "Webhook 域名解析到了不允许的网络地址。":
    "The webhook hostname resolves to a disallowed network address.",
  "启用 Webhook 时必须设置 URL。": "Set a URL before enabling the webhook.",
  "请先启用并保存 Webhook。": "Enable and save the webhook first.",
  "任务不可重试或完整内容已过期。":
    "This delivery cannot be retried, or its complete content has expired.",
  "Webhook 尚未启用。": "The webhook is not enabled.",
  "请求失败。": "The request failed.",
  "Latchmail 品牌主视觉": "Latchmail brand artwork",
  "域名格式无效。": "The domain format is invalid.",
  "首版登记仅支持常见 ASCII local-part。":
    "Address registration currently supports common ASCII local-parts only.",
  "标签名称长度应为 1～64 个字符。":
    "The label name must contain 1–64 characters.",
  "接口不存在。": "The API endpoint does not exist.",
  "请求数据无效。": "The request data is invalid.",
  "服务器处理失败。": "The server could not process the request.",
  "资源不存在。": "The resource does not exist.",
  "limit 应为 1～100 的整数。": "The limit must be an integer from 1 to 100.",
  "游标无效。": "The cursor is invalid.",
  "该域名已登记。": "This domain is already registered.",
  "标签名称已存在。": "This label name already exists.",
  "标签不存在。": "The label does not exist.",
  "域名不存在。": "The domain does not exist.",
  "未登记与已登记未打标签筛选不能同时使用。":
    "The unregistered and registered-without-label filters cannot be used together.",
  "搜索词过长。": "The search query is too long.",
  "附件不存在。": "The attachment does not exist.",
  "附件已过期。": "The attachment has expired.",
  "附件对象不可用。": "The attachment object is unavailable.",
  "更换 URL 会取消旧目标的未完成任务，请确认。":
    "Changing the URL cancels unfinished deliveries to the old endpoint. Confirm the change.",
  "投递任务不存在。": "The delivery task does not exist.",
  "任务已终止或不存在。": "The delivery task has ended or does not exist.",
  "完整内容已过期。": "The complete message content has expired.",
  "请求来源校验失败。": "Request origin validation failed.",
  "CSRF 校验失败。": "CSRF validation failed.",
};

function interpolate(value: string, params: Params): string {
  return value.replace(/{{(\w+)}}/g, (_, key: string) =>
    String(params[key] ?? `{{${key}}}`),
  );
}

export function detectLocale(languages: readonly string[] = []): Locale {
  return languages.some((language) => language.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
}

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en") return stored;
  } catch {
    // Storage can be unavailable in hardened browsers; language still works.
  }
  return detectLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Params) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep the in-memory choice when persistence is unavailable.
    }
  }, []);
  const t = useCallback(
    (key: string, params: Params = {}) =>
      interpolate(
        locale === "en" ? (english[key] ?? key) : (chinese[key] ?? key),
        params,
      ),
    [locale],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = "Latchmail";
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside LanguageProvider");
  return value;
}
