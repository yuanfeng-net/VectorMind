import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API = "";
const SESSION_TOKEN_KEY = "vectormind.admin.session-token";

function readStoredAdminToken() {
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

let adminSessionToken = readStoredAdminToken();

function setAdminSessionToken(token, persist = false) {
  adminSessionToken = String(token ?? "").trim();
  if (!persist) return;
  try {
    if (adminSessionToken) window.sessionStorage.setItem(SESSION_TOKEN_KEY, adminSessionToken);
    else window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // The in-memory token still works when session storage is unavailable.
  }
}

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "hit", label: "命中" },
  { id: "muted", label: "忽略" },
  { id: "warn", label: "警告" },
  { id: "info", label: "信息" },
];

const LOG_PAGE_SIZE = 12;
const APPLIED_MEMORY_PAGE_SIZE = 8;

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function nowDisplay() {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function shortTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function apiFetch(path, options = {}) {
  const { headers: optionHeaders, ...fetchOptions } = options;
  return fetch(`${API}${path}`, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      ...(adminSessionToken ? { "X-VectorMind-Admin-Token": adminSessionToken } : {}),
      ...(optionHeaders ?? {}),
    },
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `请求失败：${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  });
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function Icon({ name, className }) {
  const common = {
    className: cx("icon", className),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.9",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };
  const paths = {
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8 8 0 0 0-14.7-4.4L4 8" />
        <path d="M4 4v4h4" />
        <path d="M4 13a8 8 0 0 0 14.7 4.4L20 16" />
        <path d="M20 20v-4h-4" />
      </>
    ),
    folder: (
      <>
        <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      </>
    ),
    search: (
      <>
        <path d="m20 20-4.2-4.2" />
        <circle cx="10.5" cy="10.5" r="6.5" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5.5" rx="7" ry="3" />
        <path d="M5 5.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
        <path d="M5 11.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </>
    ),
    check: (
      <>
        <path d="M20 6 9 17l-5-5" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 5 6v5c0 4.7 3 8.1 7 10 4-1.9 7-5.3 7-10V6z" />
        <path d="m9 12 2 2 4-5" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M6 7l1 14h10l1-14" />
        <path d="M9 7V4h6v3" />
      </>
    ),
    dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
    warning: (
      <>
        <path d="m12 3 10 18H2z" />
        <path d="M12 9v5" />
        <path d="M12 17h.01" />
      </>
    ),
  };
  return <svg {...common}>{paths[name] ?? paths.dot}</svg>;
}

function Toast({ message, type = "info", onClose }) {
  useEffect(() => {
    if (!message) return undefined;
    const id = window.setTimeout(onClose, 3200);
    return () => window.clearTimeout(id);
  }, [message, onClose]);

  if (!message) return null;
  return (
    <div className={cx("toast", `toast-${type}`)} role="status">
      {message}
    </div>
  );
}

function TokenAccess({ authentication, busy, onAuthenticate, onClear }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (authentication?.mode !== "explicit") return null;
  if (authentication.authenticated) {
    return (
      <div className="token-session" aria-label="显式令牌已验证">
        <Icon name="shield" />
        <span>令牌已验证</span>
        <button type="button" onClick={onClear} disabled={busy}>
          清除
        </button>
      </div>
    );
  }

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onAuthenticate(token);
      setToken("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="token-access" onSubmit={submit}>
      <label>
        <span className="sr-only">管理面板令牌</span>
        <Icon name="shield" />
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="输入管理令牌"
          autoComplete="current-password"
          required
        />
      </label>
      <button type="submit" disabled={submitting || !token.trim()}>
        {submitting ? "验证中" : "连接"}
      </button>
      {error ? <span className="token-error" role="alert">{error}</span> : null}
    </form>
  );
}

function TopBar({ config, onRefresh, query, onQueryChange, busy, onAuthenticate, onClearAuthentication }) {
  const copyPath = async () => {
    if (!config?.indexFile) return;
    await navigator.clipboard?.writeText(config.indexFile);
  };
  const authenticated = Boolean(config?.authentication?.authenticated);

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          V
        </div>
        <div>
          <h1>VectorMind 管理面板</h1>
          <p>本机 MCP 记忆索引与命中观察台</p>
        </div>
      </div>

      <div className="topbar-meta" aria-label="运行状态">
        <span className="status-pill status-ok">
          <span className="status-dot" />
          服务状态：运行中
        </span>
        <span className="status-pill">端口 {config?.port ?? 16860}</span>
        {config?.indexFile ? (
          <button className="path-pill" type="button" onClick={copyPath} title="复制索引文件路径">
            <span>数据文件：</span>
            <strong>{config.indexFile}</strong>
            <Icon name="copy" />
          </button>
        ) : null}
      </div>

      <div className="topbar-actions">
        <TokenAccess
          authentication={config?.authentication}
          busy={busy}
          onAuthenticate={onAuthenticate}
          onClear={onClearAuthentication}
        />
        <button className="ghost-button" type="button" onClick={onRefresh} disabled={busy || !authenticated}>
          <Icon name="refresh" className={busy ? "spin" : ""} />
          刷新索引
        </button>
        <label className="search-box">
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索项目、日志、记忆…"
            aria-label="搜索项目、日志、记忆"
            disabled={!authenticated}
          />
          <kbd>Ctrl K</kbd>
        </label>
      </div>
    </header>
  );
}

function ProjectForm({ onSubmit, onCancel, defaultPath }) {
  const [name, setName] = useState("");
  const [projectPath, setProjectPath] = useState(defaultPath ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({ name, path: projectPath });
      setName("");
      setProjectPath("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="project-form" onSubmit={submit}>
      <label>
        <span>项目路径</span>
        <input
          value={projectPath}
          onChange={(event) => setProjectPath(event.target.value)}
          placeholder="H:\\2025\\VectorMind-MCP"
          required
        />
      </label>
      <label>
        <span>显示名称</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="默认使用文件夹名称" />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "添加中…" : "保存项目"}
        </button>
        <button className="ghost-button" type="button" onClick={onCancel}>
          收起
        </button>
      </div>
    </form>
  );
}

function Sidebar({
  projects,
  selectedId,
  onSelect,
  onAddProject,
  onDiscover,
  onDelete,
  query,
  config,
  busy,
}) {
  const [showForm, setShowForm] = useState(false);
  const [scanRoot, setScanRoot] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((project) =>
      [project.name, project.folderName, project.path].some((field) => String(field ?? "").toLowerCase().includes(q)),
    );
  }, [projects, query]);

  return (
    <aside className="sidebar" aria-label="项目索引">
      <div className="panel-title-row">
        <div>
          <h2>项目索引</h2>
          <p>{projects.length} 个本机记忆项目</p>
        </div>
      </div>

      <div className="sidebar-actions">
        <button className="primary-button" type="button" onClick={() => setShowForm((value) => !value)}>
          <Icon name="plus" />
          添加项目
        </button>
        <button className="ghost-button" type="button" onClick={() => onDiscover(scanRoot)} disabled={busy}>
          <Icon name="refresh" className={busy ? "spin" : ""} />
          刷新索引
        </button>
      </div>

      {showForm ? (
        <ProjectForm
          defaultPath={config?.currentProjectRoot}
          onSubmit={async (payload) => {
            await onAddProject(payload);
            setShowForm(false);
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      <label className="scan-root">
        <span>扫描根目录</span>
        <input
          value={scanRoot}
          onChange={(event) => setScanRoot(event.target.value)}
          placeholder={config?.homeDir ?? "C:\\Users\\<user>"}
        />
      </label>

      <div className="project-list" role="list">
        {filtered.map((project) => {
          const active = project.id === selectedId;
          const memoryCount = project.memory?.counts?.memoryItems ?? 0;
          return (
            <button
              key={project.id}
              className={cx("project-item", active && "active")}
              type="button"
              onClick={() => onSelect(project.id)}
              role="listitem"
            >
              <span className="project-icon">
                <Icon name="folder" />
              </span>
              <span className="project-copy">
                <strong>{project.name}</strong>
                <small>{project.path}</small>
              </span>
              <span className="project-count">{memoryCount}</span>
              <span
                className="project-remove"
                role="button"
                tabIndex={0}
                aria-label={`从索引移除 ${project.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(project.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onDelete(project.id);
                  }
                }}
              >
                ×
              </span>
            </button>
          );
        })}
        {!filtered.length ? (
          <div className="empty-state">
            <Icon name="database" />
            <strong>暂无项目索引</strong>
            <span>添加路径或扫描目录后，这里会显示本机 MCP 记忆项目。</span>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function FilterTabs({ value, onChange, filters = FILTERS }) {
  return (
    <div className="filter-tabs" role="tablist" aria-label="日志筛选">
      {filters.map((filter) => (
        <button
          key={filter.id}
          type="button"
          className={cx(value === filter.id && "active")}
          onClick={() => onChange(filter.id)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}

function StatusBadge({ level, label }) {
  return <span className={cx("status-badge", `badge-${level || "info"}`)}>{label}</span>;
}

function LogRow({ item, index, timeline = false }) {
  return (
    <li className={cx("log-row", timeline && "timeline-row")} style={{ "--i": index }}>
      {timeline ? <span className={cx("timeline-dot", item.level)} /> : <Icon name={item.level === "warn" ? "warning" : "check"} />}
      <time>{shortTime(item.at)}</time>
      <div className="log-main">
        <strong>{item.title}</strong>
        {item.detail ? <small>{item.detail}</small> : null}
      </div>
      <StatusBadge level={item.level} label={item.status} />
    </li>
  );
}

function LogPanel({ title, subtitle, items, filters, filter, onFilter, query, timeline = false, emptyText, className }) {
  const listRef = useRef(null);
  const [limit, setLimit] = useState(LOG_PAGE_SIZE);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((item) => filter === "all" || item.level === filter)
      .filter((item) => {
        if (!q) return true;
        return [item.title, item.detail, item.status, item.category].some((field) =>
          String(field ?? "").toLowerCase().includes(q),
        );
      });
  }, [items, filter, query]);
  const shown = visible.slice(0, limit);
  const remaining = Math.max(0, visible.length - shown.length);
  const hasMore = remaining > 0;

  useEffect(() => {
    setLimit(LOG_PAGE_SIZE);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [items, filter, query]);

  function loadMore() {
    setLimit((current) => Math.min(current + LOG_PAGE_SIZE, visible.length));
  }

  function handleScroll(event) {
    if (!hasMore) return;
    const el = event.currentTarget;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceToBottom < 96) loadMore();
  }

  return (
    <section className={cx("log-panel", className)}>
      <div className="log-heading">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <FilterTabs value={filter} onChange={onFilter} filters={filters} />
      </div>
      <ul ref={listRef} onScroll={handleScroll} className={cx("log-list", timeline && "timeline-list")}>
        {shown.map((item, index) => (
          <LogRow key={item.id} item={item} index={index} timeline={timeline} />
        ))}
        {!visible.length ? (
          <li className="empty-log">
            <Icon name="search" />
            <span>{emptyText ?? "没有匹配的日志。调整筛选或刷新项目记忆。"}</span>
          </li>
        ) : null}
      </ul>
      {hasMore ? (
        <button type="button" className="load-more" onClick={loadMore}>
          还有 {remaining} 条，滚动到底部或点击加载更多
        </button>
      ) : visible.length ? (
        <div className="load-complete">已显示全部 {visible.length} 条</div>
      ) : null}
    </section>
  );
}

function StatCard({ label, value, level = "info" }) {
  return (
    <div className={cx("stat-card", `stat-${level}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function numberText(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value ?? 0));
}

function MemoryAuditPanel({ audit, busy, repairBusy, onAudit, onRepair }) {
  const duplicateLogs = audit?.duplicateChangeLogs ?? {};
  const duplicateIntents = audit?.duplicateChangeIntents ?? {};
  const ignoredNoise = audit?.ignoredPathNoise ?? {};
  const severity = audit?.severity ?? "idle";
  const topGroups = [
    ...(duplicateLogs.topGroups ?? []).map((item) => ({ ...item, type: "日志" })),
    ...(duplicateIntents.topGroups ?? []).map((item) => ({ ...item, type: "记忆" })),
  ]
    .sort((a, b) => Number(b.rows ?? 0) - Number(a.rows ?? 0))
    .slice(0, 3);

  return (
    <section className={cx("memory-audit-panel", `audit-${severity}`)}>
      <div className="memory-audit-head">
        <div>
          <h3>记忆体检与修复</h3>
          <p>{audit?.summary ?? "一键检测重复改动日志、旧库结构和临时目录噪声。"}</p>
        </div>
        <span className="audit-badge">{audit ? (audit.needsRepair ? "需要处理" : "正常") : "未检测"}</span>
      </div>

      <div className="audit-actions">
        <button type="button" onClick={onAudit} disabled={busy || repairBusy}>
          <Icon name="shield" className={busy ? "spin" : ""} />
          {busy ? "检测中" : "检测记忆"}
        </button>
        <button type="button" className="danger" onClick={onRepair} disabled={repairBusy || busy || !audit?.dbPresent}>
          <Icon name="warning" className={repairBusy ? "spin" : ""} />
          {repairBusy ? "修复中" : "一键修复"}
        </button>
      </div>

      {audit ? (
        <>
          <div className="audit-grid">
            <StatCard label="重复日志组" value={numberText(duplicateLogs.groups)} level={duplicateLogs.groups ? "warn" : "hit"} />
            <StatCard label="可合并日志" value={numberText(duplicateLogs.removableRows)} level={duplicateLogs.removableRows ? "warn" : "info"} />
            <StatCard label="重复记忆组" value={numberText(duplicateIntents.groups)} level={duplicateIntents.groups ? "warn" : "hit"} />
            <StatCard label="旧结构" value={audit.schema?.hasSyncedFileStates ? "否" : "是"} level={audit.schema?.hasSyncedFileStates ? "hit" : "warn"} />
          </div>

          <dl className="audit-details">
            <div>
              <dt>FTS/记忆行数</dt>
              <dd>
                {numberText(audit.counts?.memoryItems)} / {numberText(audit.counts?.memoryItemsFts)}
              </dd>
            </div>
            <div>
              <dt>临时路径噪声</dt>
              <dd>
                日志 {numberText(ignoredNoise.changeLogs)}，索引 {numberText(ignoredNoise.indexedMemory)}，符号 {numberText(ignoredNoise.symbols)}
              </dd>
            </div>
            <div>
              <dt>上次修复</dt>
              <dd>{audit.lastRepair?.updatedAt ? shortTime(audit.lastRepair.updatedAt) : "未记录"}</dd>
            </div>
          </dl>

          {topGroups.length ? (
            <ul className="audit-top-groups">
              {topGroups.map((item, index) => (
                <li key={`${item.type}-${index}`}>
                  <strong>{item.type} ×{numberText(item.rows)}</strong>
                  <span>{item.preview}</span>
                  {item.sampleFiles ? <small>{item.sampleFiles}</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function AppliedMemoryList({ items, projectId }) {
  const listRef = useRef(null);
  const [limit, setLimit] = useState(APPLIED_MEMORY_PAGE_SIZE);
  const shown = items.slice(0, limit);
  const remaining = Math.max(0, items.length - shown.length);
  const hasMore = remaining > 0;

  useEffect(() => {
    setLimit(APPLIED_MEMORY_PAGE_SIZE);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [items, projectId]);

  function loadMore() {
    setLimit((current) => Math.min(current + APPLIED_MEMORY_PAGE_SIZE, items.length));
  }

  function handleScroll(event) {
    if (!hasMore) return;
    const el = event.currentTarget;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceToBottom < 72) loadMore();
  }

  return (
    <>
      <ol ref={listRef} className="applied-memory-list" onScroll={handleScroll}>
        {shown.map((item, index) => (
          <li key={item.id}>
            <span>{index + 1}</span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.label} · {shortTime(item.updatedAt)}</small>
              {item.preview ? <p>{item.preview}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      {hasMore ? (
        <button type="button" className="inline-load-more" onClick={loadMore}>
          还有 {remaining} 条，滚动或点击加载
        </button>
      ) : (
        <div className="inline-load-complete">已显示全部 {items.length} 条</div>
      )}
    </>
  );
}

function Inspector({
  selectedProject,
  memory,
  memoryAudit,
  auditBusy,
  repairBusy,
  onAuditMemory,
  onRepairMemory,
  onDelete,
  onRefreshSelected,
}) {
  const applied = memory?.appliedMemory ?? [];
  const counts = memory?.counts ?? {};
  const health = memory?.health ?? {};
  const kindCounts = memory?.kindCounts ?? [];

  if (!selectedProject) {
    return (
      <aside className="inspector">
        <div className="empty-state large">
          <Icon name="folder" />
          <strong>选择一个项目</strong>
          <span>右侧会显示当前应用记忆、规则、决策和健康状态。</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector" aria-label="当前应用记忆">
      <div className="inspector-head">
        <div>
          <h2>当前应用记忆</h2>
          <p>{selectedProject.name}</p>
        </div>
        <span className="selected-chip">{selectedProject.folderName}</span>
      </div>

      <section className="applied-memory">
        <h3>当前应用的记忆条目</h3>
        {applied.length ? (
          <AppliedMemoryList items={applied} projectId={selectedProject.id} />
        ) : (
          <div className="empty-mini">
            <Icon name="database" />
            <span>此项目还没有可应用的核心记忆。</span>
          </div>
        )}
      </section>

      <section className="quick-actions">
        <h3>快速操作</h3>
        <div className="quick-grid">
          <button type="button" onClick={onRefreshSelected}>
            <Icon name="refresh" />
            刷新记忆
          </button>
          <button type="button" onClick={() => navigator.clipboard?.writeText(selectedProject.path)}>
            <Icon name="copy" />
            复制路径
          </button>
          <button type="button" className="danger" onClick={() => onDelete(selectedProject.id)}>
            <Icon name="trash" />
            移除索引
          </button>
        </div>
      </section>

      <MemoryAuditPanel
        audit={memoryAudit}
        busy={auditBusy}
        repairBusy={repairBusy}
        onAudit={onAuditMemory}
        onRepair={onRepairMemory}
      />

      <section className="category-stats">
        <h3>记忆分类统计</h3>
        <div className="stats-grid">
          <StatCard label="规则" value={counts.conventions ?? 0} />
          <StatCard label="决策" value={counts.decisions ?? 0} level="warn" />
          <StatCard label="需求" value={counts.requirements ?? 0} level="hit" />
          <StatCard label="备注" value={counts.notes ?? 0} />
        </div>
        <div className="kind-strip">
          {kindCounts.slice(0, 8).map((item) => (
            <span key={item.kind}>
              {item.label}
              <strong>{item.count}</strong>
            </span>
          ))}
        </div>
      </section>

      <section className="health-panel">
        <h3>健康状态</h3>
        <div className="health-row">
          <span>命中率</span>
          <strong>{health.hitRate ?? 0}%</strong>
        </div>
        <div className="progress-bar" aria-hidden="true">
          <span style={{ width: `${Math.min(100, health.hitRate ?? 0)}%` }} />
        </div>
        <dl>
          <div>
            <dt>冲突记忆</dt>
            <dd>{health.conflictCount ?? 0}</dd>
          </div>
          <div>
            <dt>最后应用</dt>
            <dd>{shortTime(health.lastAppliedAt)}</dd>
          </div>
          <div>
            <dt>项目路径</dt>
            <dd title={selectedProject.path}>{selectedProject.path}</dd>
          </div>
          <div>
            <dt>记忆库大小</dt>
            <dd>{memory?.dbSizeText ?? "0 B"}</dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}

function Workspace({ selectedProject, memory, query }) {
  const [commandFilter, setCommandFilter] = useState("all");
  const [memoryFilter, setMemoryFilter] = useState("all");

  if (!selectedProject) {
    return (
      <main className="workspace empty-workspace">
        <div className="empty-state large">
          <Icon name="database" />
          <strong>添加或选择项目开始</strong>
          <span>管理面板会读取项目下的 `.vectormind/vectormind.db`，并展示命中日志与记忆日志。</span>
        </div>
      </main>
    );
  }

  return (
    <main className="workspace" id="main-content">
      <LogPanel
        title="MCP 命中日志"
        subtitle={memory?.dbPresent ? "只展示 MCP 真实拦截、提醒和防护事件；普通需求与改动在记忆日志" : "未发现 .vectormind/vectormind.db"}
        items={memory?.commandLogs ?? []}
        filters={FILTERS}
        filter={commandFilter}
        onFilter={setCommandFilter}
        query={query}
        emptyText="暂无真实 MCP 防护事件。体检/修复在右侧面板，需求和改动意图在 MCP 记忆日志。"
      />
      <LogPanel
        title="MCP 记忆日志"
        subtitle="按更新时间排列的需求、改动意图、规则、决策、备注、检查点和压缩记录"
        className="memory-log-panel"
        items={memory?.memoryLogs ?? []}
        filters={[
          { id: "all", label: "全部" },
          { id: "hit", label: "核心" },
          { id: "info", label: "操作" },
          { id: "warn", label: "警告" },
          { id: "muted", label: "索引" },
        ]}
        filter={memoryFilter}
        onFilter={setMemoryFilter}
        query={query}
        timeline
        emptyText="没有匹配的记忆记录。调整筛选、搜索词或刷新项目记忆。"
      />
    </main>
  );
}

function BottomBar({ config, projects, selectedProject, memory }) {
  return (
    <footer className="bottom-bar">
      <div>
        <Icon name="database" />
        <strong>本地存储</strong>
        <span>仅本地模式（不上云端）</span>
      </div>
      <div>
        <Icon name="shield" />
        <span>索引项目：{projects.length}</span>
      </div>
      <div>
        <span>最后同步：</span>
        <strong>{shortTime(memory?.health?.lastAppliedAt) || nowDisplay()}</strong>
      </div>
      <div className="safe-chip">
        数据安全
        <span>{config?.indexFile ? "索引保存在 C 盘用户目录" : "等待配置"}</span>
      </div>
      {selectedProject ? <div className="bottom-path">{selectedProject.path}</div> : null}
    </footer>
  );
}

function App() {
  const [config, setConfig] = useState(null);
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [memory, setMemory] = useState(null);
  const [memoryAudit, setMemoryAudit] = useState(null);
  const [memoryAuditProjectId, setMemoryAuditProjectId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const selectedIdRef = useRef("");
  const memoryRequestRef = useRef({ controller: null, sequence: 0 });
  const auditRequestRef = useRef({ controller: null, sequence: 0 });
  const repairRequestRef = useRef({ controller: null, sequence: 0 });

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? null,
    [projects, selectedId],
  );
  const visibleMemoryAudit = memoryAuditProjectId === selectedProject?.id ? memoryAudit : null;

  function beginRequest(requestRef) {
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = requestRef.current.sequence + 1;
    requestRef.current = { controller, sequence };
    return { controller, sequence };
  }

  function requestIsCurrent(requestRef, sequence) {
    return requestRef.current.sequence === sequence;
  }

  function cancelRequest(requestRef) {
    requestRef.current.controller?.abort();
    requestRef.current = { controller: null, sequence: requestRef.current.sequence + 1 };
  }

  function selectProject(nextId) {
    const normalizedId = nextId ?? "";
    if (selectedIdRef.current !== normalizedId) {
      cancelRequest(memoryRequestRef);
      cancelRequest(auditRequestRef);
      cancelRequest(repairRequestRef);
      setMemory(null);
      setMemoryAudit(null);
      setMemoryAuditProjectId("");
      setAuditBusy(false);
      setRepairBusy(false);
    }
    selectedIdRef.current = normalizedId;
    setSelectedId(normalizedId);
  }

  function clearProtectedState() {
    cancelRequest(memoryRequestRef);
    cancelRequest(auditRequestRef);
    cancelRequest(repairRequestRef);
    selectedIdRef.current = "";
    setProjects([]);
    setSelectedId("");
    setMemory(null);
    setMemoryAudit(null);
    setMemoryAuditProjectId("");
    setAuditBusy(false);
    setRepairBusy(false);
  }

  async function loadConfig() {
    const data = await apiFetch("/api/config");
    if (data.sessionToken) setAdminSessionToken(data.sessionToken);
    if (data.authentication?.mode === "explicit" && !data.authentication.authenticated && adminSessionToken) {
      setAdminSessionToken("", true);
    }
    setConfig(data);
    return data;
  }

  async function loadProjects(preferredId = selectedIdRef.current) {
    const data = await apiFetch("/api/projects");
    const nextProjects = data.projects ?? [];
    const nextId = nextProjects.some((project) => project.id === preferredId)
      ? preferredId
      : nextProjects.some((project) => project.id === selectedIdRef.current)
        ? selectedIdRef.current
        : (nextProjects[0]?.id ?? "");
    setProjects(nextProjects);
    selectProject(nextId);
    return nextId;
  }

  async function loadSelected(projectId = selectedIdRef.current) {
    if (!projectId) {
      setMemory(null);
      setMemoryAudit(null);
      setMemoryAuditProjectId("");
      return false;
    }
    const { controller, sequence } = beginRequest(memoryRequestRef);
    try {
      const data = await apiFetch(`/api/projects/${projectId}/memory`, { signal: controller.signal });
      if (!requestIsCurrent(memoryRequestRef, sequence) || selectedIdRef.current !== projectId) return false;
      setMemory(data.memory);
      setMemoryAudit(null);
      setMemoryAuditProjectId("");
      return true;
    } catch (err) {
      if (isAbortError(err)) return false;
      throw err;
    } finally {
      if (requestIsCurrent(memoryRequestRef, sequence)) {
        memoryRequestRef.current = { controller: null, sequence };
      }
    }
  }

  async function refreshAll(showToast = true) {
    setBusy(true);
    try {
      const nextConfig = await loadConfig();
      if (!nextConfig.authentication?.authenticated) {
        clearProtectedState();
        if (showToast) setToast({ type: "info", message: "请输入管理令牌后连接。" });
        return;
      }
      const nextId = await loadProjects(selectedIdRef.current);
      if (nextId) await loadSelected(nextId);
      if (showToast) setToast({ type: "success", message: "索引已刷新。" });
    } catch (err) {
      if (!isAbortError(err)) setToast({ type: "error", message: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function authenticate(token) {
    const candidate = String(token ?? "").trim();
    if (!candidate) throw new Error("请输入管理令牌。");
    setAdminSessionToken(candidate, true);
    const nextConfig = await loadConfig();
    if (!nextConfig.authentication?.authenticated) {
      throw new Error("管理令牌无效。");
    }
    const nextId = await loadProjects(selectedIdRef.current);
    if (nextId) await loadSelected(nextId);
    setToast({ type: "success", message: "管理令牌已验证。" });
  }

  async function clearAuthentication() {
    try {
      setAdminSessionToken("", true);
      const nextConfig = await loadConfig();
      setConfig(nextConfig);
      clearProtectedState();
      setToast({ type: "info", message: "当前标签页的管理令牌已清除。" });
    } catch (err) {
      setToast({ type: "error", message: err.message });
    }
  }

  async function addProject(payload) {
    const data = await apiFetch("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const projectId = data.project.id;
    await loadProjects(projectId);
    selectProject(projectId);
    await loadSelected(projectId);
    setToast({ type: "success", message: "项目已加入本地索引。" });
  }

  async function discover(root) {
    setBusy(true);
    try {
      const data = await apiFetch("/api/projects/discover", {
        method: "POST",
        body: JSON.stringify({ root: root || config?.homeDir, maxDepth: 5 }),
      });
      const nextId = await loadProjects(selectedIdRef.current);
      if (nextId) await loadSelected(nextId);
      setToast({ type: "success", message: `扫描完成：发现 ${data.found} 个记忆项目。` });
    } catch (err) {
      if (!isAbortError(err)) setToast({ type: "error", message: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject(id) {
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    const keep = window.confirm(`从索引移除「${project.name}」？项目文件和 .vectormind 记忆库不会被删除。`);
    if (!keep) return;
    try {
      await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
      const nextId = await loadProjects(projects.find((item) => item.id !== id)?.id ?? "");
      if (nextId) await loadSelected(nextId);
      else clearProtectedState();
      setToast({ type: "success", message: "已从索引移除，原项目未删除。" });
    } catch (err) {
      if (!isAbortError(err)) setToast({ type: "error", message: err.message });
    }
  }

  async function auditSelectedMemory(projectId = selectedIdRef.current) {
    if (!projectId || selectedIdRef.current !== projectId) return;
    const { controller, sequence } = beginRequest(auditRequestRef);
    setAuditBusy(true);
    try {
      const data = await apiFetch(`/api/projects/${projectId}/memory/audit`, { signal: controller.signal });
      if (!requestIsCurrent(auditRequestRef, sequence) || selectedIdRef.current !== projectId) return;
      setMemoryAudit(data.audit);
      setMemoryAuditProjectId(projectId);
      setToast({
        type: data.audit?.needsRepair ? "error" : "success",
        message: data.audit?.summary ?? "记忆检测完成。",
      });
    } catch (err) {
      if (!isAbortError(err) && requestIsCurrent(auditRequestRef, sequence)) {
        setToast({ type: "error", message: err.message });
      }
    } finally {
      if (requestIsCurrent(auditRequestRef, sequence)) {
        auditRequestRef.current = { controller: null, sequence };
        setAuditBusy(false);
      }
    }
  }

  async function repairSelectedMemory(projectId = selectedIdRef.current) {
    if (!projectId || selectedIdRef.current !== projectId) return;
    const project = projects.find((item) => item.id === projectId);
    if (!project || memoryAuditProjectId !== projectId) {
      setToast({ type: "error", message: "请先重新检测当前项目，再执行修复。" });
      return;
    }
    const confirmed = window.confirm(
      `将修复「${project.name}」并先备份其 SQLite 记忆库。\n\n${project.path}\n\n继续修复？`,
    );
    if (!confirmed || selectedIdRef.current !== projectId) return;
    const { controller, sequence } = beginRequest(repairRequestRef);
    setRepairBusy(true);
    try {
      const data = await apiFetch(`/api/projects/${projectId}/memory/repair`, {
        method: "POST",
        signal: controller.signal,
      });
      const stillSelected = selectedIdRef.current === projectId && requestIsCurrent(repairRequestRef, sequence);
      if (!stillSelected) return;
      setMemoryAudit(data.after);
      setMemoryAuditProjectId(projectId);
      setMemory(data.memory);
      setToast({
        type: "success",
        message: `「${project.name}」修复完成，备份已保存：${data.backupPath}`,
      });
    } catch (err) {
      if (!isAbortError(err) && requestIsCurrent(repairRequestRef, sequence)) {
        setToast({ type: "error", message: err.message });
      }
    } finally {
      if (requestIsCurrent(repairRequestRef, sequence)) {
        repairRequestRef.current = { controller: null, sequence };
        setRepairBusy(false);
      }
    }
  }

  useEffect(() => {
    refreshAll(false);
    return () => {
      cancelRequest(memoryRequestRef);
      cancelRequest(auditRequestRef);
      cancelRequest(repairRequestRef);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedProject?.id || !config?.authentication?.authenticated) return;
    loadSelected(selectedProject.id).catch((err) => {
      if (!isAbortError(err)) setToast({ type: "error", message: err.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject?.id]);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector(".search-box input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <TopBar
        config={config}
        onRefresh={refreshAll}
        query={query}
        onQueryChange={setQuery}
        busy={busy}
        onAuthenticate={authenticate}
        onClearAuthentication={clearAuthentication}
      />
      <div className="main-grid">
        <Sidebar
          projects={projects}
          selectedId={selectedProject?.id ?? ""}
          onSelect={selectProject}
          onAddProject={addProject}
          onDiscover={discover}
          onDelete={deleteProject}
          query={query}
          config={config}
          busy={busy || repairBusy}
        />
        <Workspace selectedProject={selectedProject} memory={memory} query={query} />
        <Inspector
          selectedProject={selectedProject}
          memory={memory}
          memoryAudit={visibleMemoryAudit}
          auditBusy={auditBusy}
          repairBusy={repairBusy}
          onAuditMemory={() => auditSelectedMemory(selectedProject?.id)}
          onRepairMemory={() => repairSelectedMemory(selectedProject?.id)}
          onDelete={deleteProject}
          onRefreshSelected={() =>
            loadSelected(selectedProject?.id).catch((err) => {
              if (!isAbortError(err)) setToast({ type: "error", message: err.message });
            })
          }
        />
      </div>
      <BottomBar config={config} projects={projects} selectedProject={selectedProject} memory={memory} />
      <Toast message={toast?.message} type={toast?.type} onClose={() => setToast(null)} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
