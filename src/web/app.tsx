import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import DOMPurify from "dompurify";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowClockwise,
  ArrowLeft,
  Bell,
  CheckCircle,
  DownloadSimple,
  Envelope,
  EnvelopeOpen,
  Gear,
  Globe,
  Tray,
  MagnifyingGlass,
  Plus,
  Tag,
  Trash,
  UserCircle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { request, setCsrf } from "./api/client";
import { useI18n, type Locale } from "./i18n";
import markUrl from "./assets/brand/latchmail-mark.png";
import wordmarkUrl from "./assets/brand/latchmail-wordmark.png";
import heroUrl from "./assets/brand/latchmail-hero.png";

type Domain = {
  id: string;
  domain_ascii: string;
  display_name: string;
  note: string | null;
  enabled: boolean;
  last_received_at: string | null;
  address_count: number;
  message_count: number;
};
type TagRow = { id: string; name: string; address_count: number };
type AddressRow = {
  id: string;
  domain_id: string;
  address_normalized: string;
  local_part: string;
  tag_id: string | null;
  tag_name: string | null;
  note: string | null;
  last_received_at: string | null;
};
type Registration = {
  id: string;
  note: string | null;
  tag: { id: string; name: string } | null;
} | null;
type Message = {
  id: string;
  received_at: string;
  envelope_from: string;
  envelope_to_original: string;
  envelope_to_normalized: string;
  subject_preview: string | null;
  from_preview: string | null;
  snippet: string | null;
  attachment_count: number | null;
  is_read: boolean;
  is_archived: boolean;
  parse_state: string;
  parse_error_code: string | null;
  webhook_status: string | null;
  current_registration: Registration;
};

function fmt(date: string | null | undefined, locale: Locale): string {
  return date
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(date))
    : "—";
}
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const requestVersion = useRef(0);
  const refresh = useCallback(() => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    return load()
      .then((next) => {
        if (version === requestVersion.current) setData(next);
        return next;
      })
      .catch((e) => {
        if (version === requestVersion.current)
          setError(e instanceof Error ? e.message : "加载失败");
        return undefined;
      })
      .finally(() => {
        if (version === requestVersion.current) setLoading(false);
      });
  }, deps);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, error, loading, refresh, setData };
}
function ErrorNotice({ message }: { message: string }) {
  const { t } = useI18n();
  return message ? (
    <div className="notice danger">
      <WarningCircle weight="fill" />
      {t(message)}
    </div>
  ) : null;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <EnvelopeOpen size={36} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label={t("关闭")}>
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  const next = locale === "zh-CN" ? "en" : "zh-CN";
  return (
    <button
      type="button"
      className={`language-switch ${compact ? "compact" : ""}`}
      onClick={() => setLocale(next)}
      aria-label={t("切换语言")}
      title={t("切换语言")}
    >
      <Globe />
      <span>{locale === "zh-CN" ? "EN" : "中文"}</span>
    </button>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

type SelectOption = { value: string; label: string };
function SelectField({
  name,
  options,
  value,
  defaultValue,
  className = "",
  required = false,
  ariaLabel,
  onChange,
}: {
  name?: string;
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  className?: string;
  required?: boolean;
  ariaLabel?: string;
  onChange?: (value: string) => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
  });
  const [internalValue, setInternalValue] = useState(
    defaultValue ?? options[0]?.value ?? "",
  );
  const selectedValue = value ?? internalValue;
  const selected = options.find((option) => option.value === selectedValue);

  useEffect(() => {
    if (value !== undefined || options.length === 0) return;
    if (options.some((option) => option.value === internalValue)) return;
    const first = options[0];
    if (first) setInternalValue(defaultValue ?? first.value);
  }, [defaultValue, internalValue, options, value]);

  useEffect(() => {
    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    function positionMenu() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menuHeight = Math.min(220, options.length * 42 + 10);
      const opensUp =
        rect.bottom + menuHeight + 6 > window.innerHeight &&
        rect.top > menuHeight + 6;
      setMenuPosition({
        top: Math.round(opensUp ? rect.top - menuHeight - 6 : rect.bottom + 6),
        left: Math.round(
          Math.min(rect.left, Math.max(8, window.innerWidth - rect.width - 8)),
        ),
        width: Math.round(rect.width),
      });
    }
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, options.length]);

  function choose(nextValue: string) {
    if (value === undefined) setInternalValue(nextValue);
    onChange?.(nextValue);
    setOpen(false);
  }

  return (
    <div
      ref={rootRef}
      className={`select-control ${className} ${open ? "is-open" : ""}`.trim()}
    >
      <select
        className="custom-select-native"
        name={name}
        value={selectedValue}
        onChange={(event) => choose(event.target.value)}
        required={required}
        tabIndex={-1}
        aria-hidden="true"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        ref={triggerRef}
        className="select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? "—"}</span>
        <span className="select-chevron" aria-hidden="true" />
      </button>
      {open && (
        createPortal(
          <div
            ref={menuRef}
            className="select-menu select-menu-floating"
            id={id}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              top: menuPosition.top,
              left: menuPosition.left,
              width: menuPosition.width,
            }}
          >
            {options.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === selectedValue}
                className={option.value === selectedValue ? "selected" : ""}
                key={option.value}
                onClick={() => choose(option.value)}
              >
                <span>{option.label}</span>
                {option.value === selectedValue && <CheckCircle weight="fill" />}
              </button>
            ))}
          </div>,
          document.body,
        )
      )}
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await request<{ csrf: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setCsrf(result.csrf);
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("登录失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-card">
        <div className="login-brand-row">
          <img className="login-wordmark" src={wordmarkUrl} alt="Latchmail" />
          <LanguageSwitch />
        </div>
        <p className="eyebrow">LATCHMAIL · CLOUDFLARE CATCH-ALL</p>
        <h1>{t("你的收件台")}</h1>
        <p className="muted">{t("只接收、可靠保存，再把完整邮件交给你的处理服务。")}</p>
        <form onSubmit={submit}>
          <input
            className="visually-hidden"
            name="username"
            value="administrator"
            readOnly
            autoComplete="username"
            tabIndex={-1}
            aria-hidden="true"
          />
          <Field label={t("管理员密码")}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
              minLength={32}
            />
          </Field>
          <ErrorNotice message={error} />
          <button
            className="primary wide"
            disabled={busy || password.length < 32}
          >
            {busy ? t("正在验证…") : t("进入收件箱")}
          </button>
        </form>
        <p className="security-note">
          {t("会话保存在安全的 HttpOnly Cookie 中，不写入浏览器存储。")}
        </p>
        <img
          className="login-hero"
          src={heroUrl}
          alt={t("Latchmail 品牌主视觉")}
        />
      </section>
    </main>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { t } = useI18n();
  return (
    <div className="shell">
      <aside>
        <NavLink to="/" className="wordmark">
          <span>
            <img src={markUrl} alt="" />
          </span>
          <strong>Latchmail</strong>
        </NavLink>
        <nav>
          <NavLink to="/">
            <Tray />
            {t("收件箱")}
          </NavLink>
          <NavLink to="/addresses">
            <UserCircle />
            {t("地址登记")}
          </NavLink>
          <NavLink to="/settings">
            <Gear />
            {t("设置与运维")}
          </NavLink>
          <LanguageSwitch compact />
        </nav>
        <div className="aside-foot">
          <button
            onClick={async () => {
              await request("/auth/logout", { method: "POST" });
              setCsrf(null);
              onLogout();
            }}
          >
            {t("退出登录")}
          </button>
          <small>{t("单管理员 · 仅收件")}</small>
        </div>
      </aside>
      <div className="workspace">
        <Routes>
          <Route path="/" element={<InboxPage />} />
          <Route path="/messages/:id" element={<MessageDetail />} />
          <Route path="/addresses" element={<AddressesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </div>
  );
}

function InboxPage() {
  const { locale, t } = useI18n();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = params.toString();
  const messages = useAsync(
    () =>
      request<Message[] & { next_cursor?: string | null }>(
        `/messages?${query}`,
      ),
    [query],
  );
  const domains = useAsync(() => request<Domain[]>("/domains"), []);
  const tags = useAsync(() => request<TagRow[]>("/tags"), []);
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === "visible") void messages.refresh();
    };
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, [messages.refresh]);
  function change(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }
  function setView(view: "all" | "unread" | "unregistered" | "untagged") {
    const next = new URLSearchParams(params);
    const currentView =
      params.get("unread") === "true"
        ? "unread"
        : params.get("registered") === "false"
          ? "unregistered"
          : params.get("untagged") === "true"
            ? "untagged"
            : "all";
    next.delete("unread");
    next.delete("registered");
    next.delete("untagged");
    if (currentView !== view) {
      if (view === "unread") next.set("unread", "true");
      if (view === "unregistered") next.set("registered", "false");
      if (view === "untagged") next.set("untagged", "true");
    }
    setParams(next);
  }
  return (
    <>
      <header className="page-head inbox-head">
        <div>
          <p className="eyebrow">INBOX</p>
          <h1>{t("所有来信")}</h1>
          <p>{t("登记只影响标签；任何已启用域名下的地址都可以收件。")}</p>
        </div>
        <button className="secondary" onClick={messages.refresh}>
          <ArrowClockwise />
          {t("刷新")}
        </button>
      </header>
      <div className="inbox-layout">
        <section className="filter-rail">
          <strong>{t("视图")}</strong>
          <button
            className={
              !params.has("unread") &&
              !params.has("registered") &&
              !params.has("untagged")
                ? "active"
                : ""
            }
            onClick={() => setView("all")}
          >
            {t("全部收件")}
          </button>
          <button
            className={params.get("unread") === "true" ? "active" : ""}
            onClick={() => setView("unread")}
          >
            {t("未读")}
          </button>
          <button
            className={params.get("registered") === "false" ? "active" : ""}
            onClick={() => setView("unregistered")}
          >
            {t("未登记地址")}
          </button>
          <button
            className={params.get("untagged") === "true" ? "active" : ""}
            onClick={() => setView("untagged")}
          >
            {t("已登记未打标签")}
          </button>
          <strong>{t("标签")}</strong>
          {tags.data?.map((t) => (
            <button
              key={t.id}
              className={params.get("tag_id") === t.id ? "active" : ""}
              onClick={() =>
                change("tag_id", params.get("tag_id") === t.id ? null : t.id)
              }
            >
              <Tag />
              {t.name}
              <span>{t.address_count}</span>
            </button>
          ))}
          <strong>{t("域名")}</strong>
          {domains.data?.map((d) => (
            <button
              key={d.id}
              className={params.get("domain_id") === d.id ? "active" : ""}
              onClick={() =>
                change(
                  "domain_id",
                  params.get("domain_id") === d.id ? null : d.id,
                )
              }
            >
              <Globe />
              {d.domain_ascii}
            </button>
          ))}
        </section>
        <section className="mail-panel">
          <div className="toolbar">
            <label className="search">
              <MagnifyingGlass />
              <input
                placeholder={t("搜索主题、发件人、收件地址或登记信息")}
                value={params.get("q") ?? ""}
                onChange={(e) => change("q", e.target.value || null)}
              />
            </label>
            <label className="compact-check">
              <input
                type="checkbox"
                checked={params.get("archived") === "true"}
                onChange={(e) =>
                  change("archived", e.target.checked ? "true" : null)
                }
              />
              {t("归档")}
            </label>
          </div>
          <ErrorNotice message={messages.error} />
          {messages.loading && !messages.data ? (
            <div className="loading">{t("正在读取邮件索引…")}</div>
          ) : messages.data?.length ? (
            <div className="mail-list">
              {messages.data.map((m) => (
                <article
                  className={`mail-row ${m.is_read ? "" : "unread"}`}
                  key={m.id}
                  onClick={() => navigate(`/messages/${m.id}`)}
                >
                  <button
                    className="read-dot"
                    aria-label={m.is_read ? t("标记未读") : t("标记已读")}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await request(`/messages/${m.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ is_read: !m.is_read }),
                      });
                      void messages.refresh();
                    }}
                  >
                    {m.is_read ? <EnvelopeOpen /> : <Envelope weight="fill" />}
                  </button>
                  <div className="mail-main">
                    <div className="mail-title">
                      {m.current_registration?.tag && (
                        <span className="tag-badge">
                          {m.current_registration.tag.name}
                        </span>
                      )}
                      <strong>{m.subject_preview || t("（无主题）")}</strong>
                      {m.parse_state === "failed" && (
                        <span className="state error">{t("解析失败")}</span>
                      )}
                    </div>
                    <p>
                      {m.from_preview || m.envelope_from}
                      <span>{t("发给 {{address}}", { address: m.envelope_to_normalized })}</span>
                    </p>
                    <small>{m.snippet || t("尚无正文摘要")}</small>
                  </div>
                  <div className="mail-meta">
                    <time>{fmt(m.received_at, locale)}</time>
                    {(m.attachment_count ?? 0) > 0 && (
                      <span>{t("{{count}} 个附件", { count: m.attachment_count ?? 0 })}</span>
                    )}
                    <span className={`delivery ${m.webhook_status ?? "none"}`}>
                      {m.webhook_status
                        ? t("通知 {{status}}", { status: m.webhook_status })
                        : t("未请求通知")}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty title={t("这里还没有邮件")}>
              {t("先在设置中登记并启用域名，然后把 Cloudflare Email Routing 的 Catch-all 指向此 Worker。")}
            </Empty>
          )}
        </section>
      </div>
    </>
  );
}

function MessageDetail() {
  const { locale, t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const detail = useAsync(() => request<any>(`/messages/${id}`), [id]);
  const [mode, setMode] = useState<"text" | "html">("text");
  useEffect(() => {
    if (detail.data && !detail.data.is_read)
      void request(`/messages/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_read: true }),
      });
  }, [detail.data?.id]);
  if (detail.loading && !detail.data)
    return <div className="loading page">{t("正在读取完整邮件…")}</div>;
  if (detail.error)
    return (
      <>
        <button className="back" onClick={() => navigate(-1)}>
          <ArrowLeft />
          {t("返回")}
        </button>
        <ErrorNotice message={detail.error} />
      </>
    );
  const d = detail.data,
    content = d?.content?.data;
  const html = content?.html
    ? DOMPurify.sanitize(content.html, {
        FORBID_TAGS: [
          "script",
          "form",
          "style",
          "svg",
          "object",
          "embed",
          "iframe",
          "link",
          "meta",
        ],
        FORBID_ATTR: ["style", "srcset", "onerror", "onclick", "onload"],
      })
    : null;
  const doc = html
    ? `<!doctype html><html lang="${locale}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>body{font:15px/1.65 system-ui;color:#262522;margin:18px;overflow-wrap:anywhere}a{color:#315b7d}</style><body>${html}</body></html>`
    : "";
  return (
    <>
      <header className="detail-head">
        <button className="back" onClick={() => navigate(-1)}>
          <ArrowLeft />
          {t("返回收件箱")}
        </button>
        <div className="detail-actions">
          <button
            className="secondary"
            onClick={async () => {
              await request(`/messages/${id}`, {
                method: "PATCH",
                body: JSON.stringify({ is_archived: !d.is_archived }),
              });
              navigate("/");
            }}
          >
            <Archive />
            {d.is_archived ? t("取消归档") : t("归档")}
          </button>
          <button
            className="danger-button"
            onClick={async () => {
              if (
                confirm(
                  t("永久删除这封邮件？此操作会取消待处理通知并清理 R2 对象，无法恢复。"),
                )
              ) {
                await request(`/messages/${id}`, { method: "DELETE" });
                navigate("/");
              }
            }}
          >
            <Trash />
            {t("永久删除")}
          </button>
        </div>
      </header>
      <main className="detail">
        <section className="message-card">
          <div className="subject-line">
            {d.current_registration?.tag && (
              <span className="tag-badge">
                {d.current_registration.tag.name}
              </span>
            )}
            <h1>{content?.subject || d.subject_preview || t("（无主题）")}</h1>
          </div>
          <div className="message-facts">
            <div>
              <span>{t("Envelope 发件人")}</span>
              <strong>{d.envelope_from}</strong>
            </div>
            <div>
              <span>{t("实际投递地址")}</span>
              <strong>{d.envelope_to_original}</strong>
            </div>
            <div>
              <span>MIME To</span>
              <strong>
                {content?.to?.map((v: any) => v.address).join(", ") || t("未声明")}
              </strong>
            </div>
            <div>
              <span>{t("收到时间")}</span>
              <strong>{fmt(d.received_at, locale)}</strong>
            </div>
          </div>
          {d.parse_state === "failed" && (
            <div className="notice danger">
              <WarningCircle weight="fill" />
              {t("已保存原始邮件，但结构化解析失败：{{code}}", { code: d.parse_error_code })}
            </div>
          )}
          <div className="body-tabs">
            <button
              className={mode === "text" ? "active" : ""}
              disabled={!content?.text}
              onClick={() => setMode("text")}
            >
              {t("纯文本")}
            </button>
            <button
              className={mode === "html" ? "active" : ""}
              disabled={!content?.html}
              onClick={() => setMode("html")}
            >
              {t("HTML（隔离）")}
            </button>
          </div>
          {mode === "text" && content?.text ? (
            <pre className="plain-body">{content.text}</pre>
          ) : mode === "html" && html ? (
            <iframe
              className="html-body"
              sandbox="allow-popups"
              srcDoc={doc}
              title={t("隔离的邮件 HTML 正文")}
            />
          ) : (
            <Empty title={t("该格式没有正文")}>
              {t("切换到邮件实际包含的正文格式，或下载原始 EML。")}
            </Empty>
          )}
        </section>
        <aside className="detail-side">
          <section>
            <h2>{t("地址登记")}</h2>
            {d.current_registration ? (
              <>
                <p>
                  <CheckCircle weight="fill" />
                  {t("已登记")}
                  {d.current_registration.tag
                    ? ` · ${d.current_registration.tag.name}`
                    : ` · ${t("尚未打标签")}`}
                </p>
                <NavLink
                  className="text-link"
                  to={`/addresses?recipient=${encodeURIComponent(d.envelope_to_normalized)}`}
                >
                  {t("管理此地址")}
                </NavLink>
              </>
            ) : (
              <>
                <p className="muted">
                  {t("此地址尚未登记，但不影响当前或后续收件。")}
                </p>
                <NavLink
                  className="primary-link"
                  to={`/addresses?prefill=${encodeURIComponent(d.envelope_to_normalized)}`}
                >
                  {t("登记并添加标签")}
                </NavLink>
              </>
            )}
          </section>
          <section>
            <h2>{t("附件与原始邮件")}</h2>
            <a
              className={`download ${d.raw_state !== "available" ? "disabled" : ""}`}
              href={`/api/messages/${d.id}/raw`}
            >
              <DownloadSimple />
              {t("原始 EML")}<span>{t(d.raw_state)}</span>
            </a>
            {d.attachments.map((a: any) => (
              <a
                key={a.id}
                className={`download ${a.available ? "" : "disabled"}`}
                href={
                  a.available ? `/api/attachments/${a.id}/download` : undefined
                }
              >
                <DownloadSimple />
                {a.filename_original || a.filename_download}
                <span>{a.available ? size(a.size_bytes) : t("已过期")}</span>
              </a>
            ))}
          </section>
          <section>
            <h2>Webhook</h2>
            {d.deliveries.length ? (
              d.deliveries.map((item: any) => (
                <div className="delivery-item" key={item.id}>
                  <span className={`state ${item.status}`}>{t(item.status)}</span>
                  <small>
                    {item.last_error_code || t("尝试 {{count}} 次", { count: item.attempts_total })}
                  </small>
                  {["failed", "paused", "succeeded"].includes(item.status) && (
                    <button
                      onClick={async () => {
                        await request(`/webhook/deliveries/${item.id}/retry`, {
                          method: "POST",
                        });
                        void detail.refresh();
                      }}
                    >
                      {t("人工重投")}
                    </button>
                  )}
                </div>
              ))
            ) : (
              <p className="muted">{t("收件时未创建通知任务。")}</p>
            )}
          </section>
        </aside>
      </main>
    </>
  );
}

function AddressesPage() {
  const { locale, t } = useI18n();
  const [params] = useSearchParams();
  const domains = useAsync(() => request<Domain[]>("/domains"), []),
    tags = useAsync(() => request<TagRow[]>("/tags"), []),
    addresses = useAsync(() => request<AddressRow[]>("/addresses"), []);
  const [open, setOpen] = useState(Boolean(params.get("prefill"))),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const prefill = params.get("prefill") ?? "";
  const defaultDomain = domains.data?.find((d) =>
    prefill.endsWith(`@${d.domain_ascii}`),
  );
  const rows = addresses.data ?? [];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = rows.filter((address) =>
    normalizedQuery
      ? [address.address_normalized, address.note ?? "", address.tag_name ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery)
      : true,
  );
  const taggedCount = rows.filter((address) => address.tag_id).length;
  const receivedCount = rows.filter((address) => address.last_received_at).length;
  const enabledDomainCount = domains.data?.filter((domain) => domain.enabled).length ?? 0;
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await request("/addresses", {
        method: "POST",
        body: JSON.stringify({
          domain_id: form.get("domain_id"),
          local_part: form.get("local_part"),
          tag_id: form.get("tag_id") || null,
          note: form.get("note") || null,
        }),
      });
      setOpen(false);
      void addresses.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("保存失败"));
    }
  }
  return (
    <>
      <header className="page-head registry-head">
        <div>
          <p className="eyebrow">REGISTRY</p>
          <h1>{t("地址登记")}</h1>
          <p>{t("地址无需登记即可收件；这里仅保存标签和备注，帮助整理历史与未来邮件。")}</p>
        </div>
        <button
          className="primary registry-action"
          onClick={() => {
            setError("");
            setOpen(true);
          }}
        >
          <Plus />
          {t("登记地址")}
        </button>
      </header>
      <ErrorNotice message={addresses.error || error} />
      <div className="registry-layout">
        <section className="registry-main">
          <div className="registry-toolbar">
            <div>
              <p className="eyebrow">{t("已登记地址")}</p>
              <h2>{t("整理收件地址")}</h2>
            </div>
            <label className="registry-search">
              <MagnifyingGlass aria-hidden="true" />
              <span className="visually-hidden">{t("搜索地址或备注")}</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("搜索地址或备注")}
              />
            </label>
          </div>
          <section className="table-card registry-table-card">
            {visibleRows.length ? (
              <table>
                <thead>
                  <tr>
                    <th>{t("完整地址")}</th>
                    <th>{t("标签")}</th>
                    <th>{t("备注")}</th>
                    <th>{t("最近收件")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.address_normalized}</strong>
                  </td>
                  <td>
                    <SelectField
                      className="table-select"
                      ariaLabel={t("修改 {{address}} 的标签", { address: a.address_normalized })}
                      value={a.tag_id ?? ""}
                      options={[
                        { value: "", label: t("未打标签") },
                        ...(tags.data?.map((tag) => ({
                          value: tag.id,
                          label: tag.name,
                        })) ?? []),
                      ]}
                      onChange={async (nextValue) => {
                        await request(`/addresses/${a.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            tag_id: nextValue || null,
                          }),
                        });
                        void addresses.refresh();
                      }}
                    />
                  </td>
                  <td>
                    <button
                      className="inline-edit"
                      onClick={async () => {
                        const note = prompt(t("修改地址备注"), a.note ?? "");
                        if (note === null) return;
                        await request(`/addresses/${a.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ note: note || null }),
                        });
                        void addresses.refresh();
                      }}
                    >
                      {a.note || t("添加备注")}
                    </button>
                  </td>
                  <td>{fmt(a.last_received_at, locale)}</td>
                  <td>
                    <button
                      className="icon danger-text"
                      aria-label={t("删除登记")}
                      onClick={async () => {
                        if (
                          confirm(
                            t("仅删除登记关系？历史邮件会重新显示为未登记，但仍会继续收件。"),
                          )
                        ) {
                          await request(`/addresses/${a.id}`, {
                            method: "DELETE",
                          });
                          void addresses.refresh();
                        }
                      }}
                    >
                      <Trash />
                    </button>
                  </td>
                </tr>
                  ))}
                </tbody>
              </table>
            ) : normalizedQuery ? (
              <Empty title={t("没有匹配的地址")}>
                {t("换一个地址、标签或备注关键词试试。")}
              </Empty>
            ) : (
              <Empty title={t("还没有人工登记的地址")}>
                {t("随机地址仍能正常接收邮件。需要按用途整理时，再添加一条登记记录。")}
              </Empty>
            )}
          </section>
        </section>
        <aside className="registry-insights">
          <section className="registry-summary">
            <div className="registry-summary-head">
              <div>
                <p className="eyebrow">{t("登记概览")}</p>
                <h2>{t("地址整理状态")}</h2>
              </div>
              <UserCircle size={24} />
            </div>
            <div className="registry-stats">
              <div>
                <strong>{rows.length}</strong>
                <span>{t("全部地址")}</span>
              </div>
              <div>
                <strong>{taggedCount}</strong>
                <span>{t("已打标签")}</span>
              </div>
              <div>
                <strong>{receivedCount}</strong>
                <span>{t("最近有收件")}</span>
              </div>
              <div>
                <strong>{enabledDomainCount}</strong>
                <span>{t("启用域名")}</span>
              </div>
            </div>
          </section>
          <section className="registry-guide">
            <div className="registry-guide-icon"><Globe /></div>
            <h2>{t("登记说明")}</h2>
            <p>{t("登记只影响标签；任何已启用域名下的地址都可以收件。")}</p>
            <p>{t("删除登记关系只会移除标签和备注，历史邮件仍然保留。")}</p>
          </section>
        </aside>
      </div>
      {open && (
        <Modal title={t("登记完整地址")} onClose={() => setOpen(false)}>
          <form className="stack" onSubmit={create}>
            <Field label={t("域名")}>
              <SelectField
                name="domain_id"
                required
                defaultValue={defaultDomain?.id ?? domains.data?.[0]?.id}
                options={
                  domains.data?.map((d) => ({
                    value: d.id,
                    label: d.domain_ascii,
                  })) ?? []
                }
              />
            </Field>
            <Field
              label="Local-part"
              hint={t("不会合并加号或点号；地址创建后不可修改。")}
            >
              <input
                name="local_part"
                required
                defaultValue={prefill.split("@")[0] ?? ""}
              />
            </Field>
            <Field label={t("标签")}>
              <SelectField
                name="tag_id"
                options={[
                  { value: "", label: t("不选择标签") },
                  ...(tags.data?.map((tag) => ({
                    value: tag.id,
                    label: tag.name,
                  })) ?? []),
                ]}
              />
            </Field>
            <Field label={t("备注")}>
              <textarea name="note" maxLength={2000} />
            </Field>
            <ErrorNotice message={error} />
            <button className="primary" type="submit">
              {t("保存登记")}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}

function SettingsPage() {
  const { locale, t } = useI18n();
  const domains = useAsync(() => request<Domain[]>("/domains"), []),
    tags = useAsync(() => request<TagRow[]>("/tags"), []),
    settings = useAsync(() => request<any>("/settings"), []),
    webhook = useAsync(() => request<any>("/webhook"), []),
    status = useAsync(() => request<any>("/system/status"), []);
  const [error, setError] = useState("");
  async function addDomain(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError("");
    try {
      await request("/domains", {
        method: "POST",
        body: JSON.stringify({
          domain: f.get("domain"),
          note: f.get("note") || null,
          enabled: true,
        }),
      });
      form.reset();
      void domains.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("保存失败"));
    }
  }
  async function addTag(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError("");
    try {
      await request("/tags", {
        method: "POST",
        body: JSON.stringify({ name: f.get("name") }),
      });
      form.reset();
      void tags.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("保存失败"));
    }
  }
  return (
    <>
      <header className="page-head settings-head">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>{t("设置与运维")}</h1>
          <p>{t("应用登记和 Cloudflare Email Routing 是两个独立步骤；这里不会修改 DNS 或 MX。")}</p>
        </div>
        <button
          className="secondary"
          onClick={async () => {
            await request("/system/maintenance", { method: "POST" });
            void status.refresh();
          }}
        >
          <ArrowClockwise />
          {t("执行一次维护")}
        </button>
      </header>
      <ErrorNotice
        message={
          error ||
          domains.error ||
          tags.error ||
          settings.error ||
          webhook.error ||
          status.error
        }
      />
      <div className="settings-grid">
        <section className="setting-card settings-domains">
          <div className="section-title">
            <div>
              <Globe />
              <h2>{t("接入域名")}</h2>
            </div>
            <p>{t("在 Cloudflare 控制台配置 Email Routing Catch-all → 此 Worker，再在下方登记同一域名。")}</p>
          </div>
          <form className="inline-form" onSubmit={addDomain}>
            <input name="domain" placeholder="mail.example.com" required />
            <input name="note" placeholder={t("用途备注（可选）")} />
            <button className="primary">
              <Plus />
              {t("添加")}
            </button>
          </form>
          <div className="setting-list">
            {domains.data?.map((d) => (
              <div key={d.id}>
                <div>
                  <strong>{d.domain_ascii}</strong>
                  <small>
                    {d.last_received_at
                      ? t("已观测到收件 · {{date}}", { date: fmt(d.last_received_at, locale) })
                      : t("待真实收件验证")}
                  </small>
                  <button
                    className="inline-edit"
                    onClick={async () => {
                      const note = prompt(t("修改域名备注"), d.note ?? "");
                      if (note === null) return;
                      await request(`/domains/${d.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ note: note || null }),
                      });
                      void domains.refresh();
                    }}
                  >
                    {d.note || t("添加备注")}
                  </button>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    onChange={async (e) => {
                      if (
                        !e.target.checked &&
                        !confirm(
                          t("停用后将明确拒收该域名的新邮件，历史邮件仍可读取。继续？"),
                        )
                      )
                        return;
                      await request(`/domains/${d.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ enabled: e.target.checked }),
                      });
                      void domains.refresh();
                    }}
                  />
                  <span />
                </label>
              </div>
            ))}
          </div>
        </section>
        <section className="setting-card settings-tags">
          <div className="section-title">
            <div>
              <Tag />
              <h2>{t("标签")}</h2>
            </div>
            <p>{t("标签改名会立即影响历史邮件的当前显示。")}</p>
          </div>
          <form className="inline-form" onSubmit={addTag}>
            <input name="name" placeholder={t("例如 ASUS")} required />
            <button className="primary">
              <Plus />
              {t("新建")}
            </button>
          </form>
          <div className="tag-list">
            {tags.data?.map((tagRow) => (
              <div key={tagRow.id}>
                <span className="tag-badge">{tagRow.name}</span>
                <small>{t("{{count}} 个地址", { count: tagRow.address_count })}</small>
                <button
                  className="icon"
                  aria-label={t("重命名 {{name}}", { name: tagRow.name })}
                  onClick={async () => {
                    const name = prompt(t("新的标签名称"), tagRow.name);
                    if (!name || name === tagRow.name) return;
                    try {
                      await request(`/tags/${tagRow.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ name }),
                      });
                      void tags.refresh();
                    } catch (event) {
                      setError(
                        event instanceof Error ? event.message : t("重命名失败"),
                      );
                    }
                  }}
                >
                  <Gear />
                </button>
                <button
                  className="icon danger-text"
                  aria-label={t("删除 {{name}}", { name: tagRow.name })}
                  onClick={async () => {
                    if (
                      !confirm(t("删除标签“{{name}}”？被地址使用时系统会拒绝。", { name: tagRow.name }))
                    )
                      return;
                    try {
                      await request(`/tags/${tagRow.id}`, { method: "DELETE" });
                      void tags.refresh();
                    } catch (event) {
                      setError(
                        event instanceof Error ? event.message : t("删除失败"),
                      );
                    }
                  }}
                >
                  <Trash />
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="setting-card settings-retention">
          <div className="section-title">
            <div>
              <Archive />
              <h2>{t("附件保留")}</h2>
            </div>
            <p>{t("从服务收到邮件时起算；修改只影响之后收到的邮件。")}</p>
          </div>
          {settings.data && (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                await request("/settings", {
                  method: "PATCH",
                  body: JSON.stringify({
                    attachment_retention_days: Number(f.get("days")),
                  }),
                });
                void settings.refresh();
              }}
            >
              <Field label={t("保留天数（1～3650）")}>
                <input
                  name="days"
                  type="number"
                  min="1"
                  max="3650"
                  defaultValue={settings.data.attachment_retention_days}
                />
              </Field>
              <button className="secondary">{t("保存保留期")}</button>
            </form>
          )}
        </section>
        <section className="setting-card settings-webhook">
          <div className="section-title">
            <div>
              <Bell />
              <h2>{t("完整 Webhook")}</h2>
            </div>
            <p>{t("一次 HTTPS POST 恰好包含 payload JSON 与完整 raw_email EML，并使用 HMAC-SHA256 签名。")}</p>
          </div>
          {webhook.data && (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget),
                  url = String(f.get("url") || "") || null,
                  enabled = f.get("enabled") === "on";
                const changed = url !== webhook.data.url;
                if (
                  changed &&
                  !confirm(
                    t("更换 URL 会取消旧目标的未完成任务，且不会自动转发到新目标。继续？"),
                  )
                )
                  return;
                try {
                  await request("/webhook", {
                    method: "PUT",
                    body: JSON.stringify({
                      enabled,
                      url,
                      confirm_cancel_pending: changed,
                    }),
                  });
                  void webhook.refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : t("保存失败"));
                }
              }}
            >
              <Field label={t("HTTPS 端点")}>
                <input
                  name="url"
                  type="url"
                  placeholder="https://hooks.example.com/email"
                  defaultValue={webhook.data.url ?? ""}
                />
              </Field>
              <label className="check">
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={webhook.data.enabled}
                />
                {t("启用新邮件通知；关闭不影响收件")}
              </label>
              <div className="form-actions">
                <button className="primary">{t("保存 Webhook")}</button>
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    !webhook.data.enabled ||
                    !webhook.data.signing_secret_configured
                  }
                  onClick={async () => {
                    try {
                      const result = await request<any>("/webhook/test", {
                        method: "POST",
                      });
                      alert(t("测试请求完成：HTTP {{status}}", { status: result.http_status }));
                    } catch (e) {
                      setError(e instanceof Error ? e.message : t("测试失败"));
                    }
                  }}
                >
                  {t("发送合成测试")}
                </button>
              </div>
              <small>
                {t("签名密钥：")}
                {webhook.data.signing_secret_configured
                  ? t("已配置")
                  : t("未配置，无法发送")}{" "}
                {t("· 端点版本 {{revision}}", { revision: webhook.data.revision })}
              </small>
            </form>
          )}
        </section>
        <section className="setting-card settings-status">
          <div className="section-title">
            <div>
              <CheckCircle />
              <h2>{t("运行状态")}</h2>
            </div>
            <p>{t("这些是应用可观测统计，不等同于 Cloudflare 账单或 DNS 健康检查。")}</p>
          </div>
          {status.data && (
            <div className="metrics">
              <div>
                <strong>{status.data.pending_parse}</strong>
                <span>{t("待解析")}</span>
              </div>
              <div>
                <strong>{status.data.failed_parse}</strong>
                <span>{t("解析失败")}</span>
              </div>
              <div>
                <strong>{status.data.pending_webhooks}</strong>
                <span>{t("通知积压")}</span>
              </div>
              <div>
                <strong>{status.data.failed_webhooks}</strong>
                <span>{t("通知失败")}</span>
              </div>
              <div>
                <strong>{status.data.pending_delete}</strong>
                <span>{t("待删除对象")}</span>
              </div>
              <div>
                <strong>
                  {fmt(status.data.maintenance.last_scheduled_at, locale)}
                </strong>
                <span>{t("最后调度")}</span>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

export default function App() {
  const { t } = useI18n();
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  useEffect(() => {
    request<{ csrf: string | null }>("/auth/session")
      .then((s) => {
        setCsrf(s.csrf);
        setAuth("in");
      })
      .catch(() => setAuth("out"));
  }, []);
  if (auth === "loading")
    return (
      <div className="boot">
        <Envelope weight="fill" />
        <span>{t("正在建立安全会话…")}</span>
      </div>
    );
  return auth === "out" ? (
    <Login onLogin={() => setAuth("in")} />
  ) : (
    <Shell onLogout={() => setAuth("out")} />
  );
}
