const state = {
  keys: [],
  selected: new Set(),
  accountPage: 0,
  pageSize: 20,
  editAccountId: null,
  accountTests: new Map(),
  editKeyId: null,
  pendingBatch: null,
  sessionEpoch: 0,
  refreshPromise: null,
  runtimeDirty: false,
  config: null,
  catalogQuery: "",
  accounts: [],
  logs: [],
  activeTab: "overview",
  analyticsRange: "all",
  logPage: 0,
  logPageSize: 20,
  toastTimer: null,
  refreshTimer: null,
  benefits: null,
  automationDirty: false,
  automationRunningIds: new Set(),
  automationStartedAt: 0,
  automationPollTimer: null,
  qrSession: null,
  qrTimer: null,
  qrImage: "",
  qrGeneration: 0,
  routing: null,
  routingDirty: false,
  historyLogs: null,
  historyOffset: 0,
  browserSession: null,
  historyDays: 7,
  historicalUsage: null,
};

const PAGE_META = {
  overview: ["总览", "账号、请求和网关状态一屏看完。"],
  accounts: ["账号", "导入、启停与冷却状态。"],
  analytics: ["用量", "请求成功率、耗时和模型分布。"],
  automation: ["自动化", "每日签到、定时计划与账号执行记录。"],
  settings: ["设置", "运行配置与安全边界。"],
  logs: ["日志", "请求元数据与错误记录。"],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const loginView = $("#loginView");
const appView = $("#appView");
const connectionState = $("#connectionState");

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message = body?.error?.message || body?.detail || `请求失败（HTTP ${response.status}）`;
    const error = new Error(typeof message === "string" ? message : JSON.stringify(message));
    error.status = response.status;
    if (response.status === 401 && body?.error?.type !== 'upstream_authentication_error' && path !== "/admin/login" && (!path.endsWith("/test") || body?.detail === "请使用管理密码登录控制台。")) resetSession("管理会话已失效，请重新登录。");
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function timestampDate(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === "") return null;
  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp)) return null;
    return new Date(Math.abs(timestamp) < 100000000000 ? timestamp * 1000 : timestamp);
  }
  if (typeof timestamp !== "string") return null;
  const value = timestamp.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return timestampDate(Number(value));
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(timestamp) {
  const date = timestampDate(timestamp);
  if (!date) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function formatDuration(value) {
  const ms = Number(value || 0);
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function showLogin(message = "") {
  appView.hidden = true;
  loginView.hidden = false;
  $("#mobileNav").hidden = true;
  $("#loginError").hidden = !message;
  $("#loginError").textContent = message;
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  $("#mobileNav").hidden = false;
  setConnection(true);
}

function setConnection(online) {
  connectionState.innerHTML = `<span class="status-dot"></span>${online ? "已连接" : "连接中断"}`;
  connectionState.classList.toggle("offline", !online);
}

async function login(password) {
  const result = await api("/admin/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (!result.ok) throw new Error("管理员密码校验失败");
  $("#loginPassword").value = "";
  await loadDashboard();
}

function resetSession(message = "") {
  clearInterval(state.automationPollTimer);
  state.automationPollTimer = null;
  state.automationRunningIds.clear();
  state.qrGeneration += 1;
  clearTimeout(state.qrTimer);
  state.qrSession = null;
  state.qrImage = "";
  state.benefits = null;
  state.automationDirty = false;
  $("#qrImage").removeAttribute("src");
  state.sessionEpoch += 1;
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  sessionStorage.removeItem("doubao_api_key");
  state.config = null;
  state.accounts = [];
  state.keys = [];
  state.logs = [];
  state.historyLogs = null;
  state.historicalUsage = null;
  state.routing = null;
  state.routingDirty = false;
  state.browserSession = null;
  state.selected.clear();
  state.accountTests.clear();
  state.pendingBatch = null;
  state.runtimeDirty = false;
  document.body.classList.remove("sidebar-open");
  $$("dialog[open]").forEach((dialog) => dialog.close());
  $("#newKeySecret").value = "";
  ["#passwordForm", "#keyForm", "#accountForm", "#importForm", "#runtimeForm"].forEach((id) => $(id).reset());
  $("#accountList").replaceChildren();
  $("#keyList").replaceChildren();
  $("#importJson").value = "";
  $("#autoRefreshButton").setAttribute("aria-pressed", "false");
  $("#autoRefreshButton").textContent = "自动刷新 关";
  showLogin(message);
}

async function logout() {
  try {
    await api("/admin/logout", { method: "POST" });
    resetSession();
  } catch (error) {
    if (error.status !== 401) showToast(`退出失败：${error.message}，请重试`);
  }
}

async function loadDashboard() {
  const epoch = state.sessionEpoch;
  const [config, accounts, logs, keys, benefits, routing, historicalUsage] = await Promise.all([
    api("/admin/config"),
    api("/admin/accounts"),
    api("/admin/logs?limit=200"),
    api("/admin/keys"),
    api('/admin/benefits'),
    api('/admin/routing'),
    api('/admin/analytics?days='+state.historyDays),
  ]);
  if (epoch !== state.sessionEpoch) return;
  state.config = config;
  state.accounts = accounts.data || [];
  state.logs = logs.data || [];
  state.keys = keys.data || [];
  state.benefits = benefits;
  state.routing = routing;
  state.historicalUsage = historicalUsage;
  state.selected = new Set([...state.selected].filter((id) => state.accounts.some((a) => a.id === id)));
  showApp();
  renderAll();
}

async function refresh({ silent = false } = {}) {
  if (state.refreshPromise) return state.refreshPromise;
  state.refreshPromise = (async () => {
  try {
    await loadDashboard();
    if (!silent) showToast("数据已刷新");
  } catch (error) {
    if (error.status === 401) {
      throw error;
    }
    setConnection(false);
    showToast(error.message);
    throw error;
  }
  })();
  try { return await state.refreshPromise; } finally { state.refreshPromise = null; }
}

function switchTab(tab, updateUrl = true) {
  if (!PAGE_META[tab]) tab = "overview";
  state.activeTab = tab;
  $$(".page").forEach((page) => page.classList.toggle("active", page.id === `page-${tab}`));
  $$("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $("#pageTitle").textContent = PAGE_META[tab][0];
  $("#pageDescription").textContent = PAGE_META[tab][1];
  document.body.classList.remove("sidebar-open");
  if (tab === "logs") renderLogs();
  if (tab === "analytics") renderAnalytics();
  if (tab === 'automation') renderAutomation();
  if (updateUrl) {
    const url = new URL(location.href);
    if (url.searchParams.get('tab') !== tab) {
      url.searchParams.set('tab', tab);
      window.history.pushState({}, '', url);
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderAll() {
  renderHistoryUsage();
  const config = state.config || {};
  $("#versionPill").textContent = `v${config.version || "1.0.0"}`;
  $("#baseUrl").textContent = `${location.origin}/v1`;
  $("#defaultModel").textContent = config.default_model || "—";
  $("#lastUpdated").textContent = `最后同步 ${new Date().toLocaleTimeString("zh-CN")}`;
  renderMetrics();
  renderAccounts();
  renderCatalog();
  renderOverviewLogs();
  renderLogs();
  renderAnalytics();
  renderSettings();
  renderKeys();
  renderReferenceFeatures();
}

function renderMetrics() {
  const available = state.accounts.filter((account) => account.available);
  const cooling = state.accounts.filter((account) => account.state === "cooling");
  const success = state.logs.filter((log) => log.status === "success");
  $("#metricAccounts").textContent = state.accounts.length;
  $("#metricAvailable").textContent = available.length;
  $("#metricCooling").textContent = cooling.length;
  $("#metricSuccess").textContent = success.length;
}

function renderCatalog() {
  const models = state.config?.models || [];
  $("#catalogCount").textContent = models.length;
  const defaultModel = models.find((model) => model.id === state.config?.default_model);
  $("#catalogDefault").textContent = defaultModel?.name || state.config?.default_model || "—";
  $("#catalogDefault").title = state.config?.default_model || "";
  const imageCount = models.filter((model) => model.image_input === true).length;
  $("#catalogImageCount").textContent = imageCount;
  renderCatalogTable();
}

function formatCatalogTokens(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return "—";
  if (count >= 1000000) return `${Number((count / 1000000).toFixed(1))}M`;
  if (count >= 1000) return `${Number((count / 1000).toFixed(1))}K`;
  return String(count);
}

function catalogEffortLabel(level) {
  return ({ low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" })[level] || level;
}

function filterCatalogModels(models, query, defaultId) {
  const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    const searchable = [model.id, model.name, model.description, model.price,
      model.context_window, formatCatalogTokens(model.context_window),
      model.image_input === true ? "视觉 图片 image vision 已验证识图" : model.image_input === false ? "文本 text" : "视觉待核实",
      "工具桥接 tools", model.reasoning_efforts?.length ? "推理 思考 reasoning" : "",
      ...(model.reasoning_efforts || []).flatMap((level) => [level, catalogEffortLabel(level)]),
      model.id === defaultId ? "默认 default" : "",
    ].join(" ").toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

function renderCatalogRow(model, defaultId) {
  const levels = model.reasoning_efforts || [];
  const capabilities = [model.image_input === true
    ? '<span class="catalog-chip vision" title="当前图片通道已通过基础识别测试">视觉</span>'
    : `<span class="catalog-chip">${model.image_input === false ? "文本" : "视觉待核实"}</span>`];
  capabilities.push('<span class="catalog-chip bridge" title="工具定义和结果通过文本桥接转换，由客户端执行工具；不是上游原生工具协议">工具桥接</span>');
  if (levels.length) capabilities.push('<span class="catalog-chip reasoning">推理</span>');
  const effort = levels.length ? levels.map((level) => `<span class="catalog-effort" title="${escapeHtml(catalogEffortLabel(level))}">${escapeHtml(level)}</span>`).join("") : '<span class="catalog-unknown">—</span>';
  const defaultEffort = model.default_reasoning_effort ? `<div class="catalog-effort-note">默认 ${escapeHtml(model.default_reasoning_effort)}</div>` : "";
  const defaultMark = model.id === defaultId ? '<span class="catalog-default-mark" title="默认模型" aria-label="默认模型">默认</span>' : "";
  return `<tr>
    <td data-label="模型 ID" class="catalog-id-cell"><div class="catalog-id"><code title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</code><button type="button" class="catalog-copy" data-action="copy-model-id" data-id="${escapeHtml(model.id)}" aria-label="复制模型 ID ${escapeHtml(model.id)}" title="复制模型 ID"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/></svg></button></div></td>
    <td data-label="名称"><span class="catalog-name" title="${escapeHtml(model.description || model.name || "")}">${escapeHtml(model.name || "—")}</span>${defaultMark}</td>
    <td data-label="消费倍率 / 优惠" class="catalog-centered">${model.price ? `<span class="rate-pill${model.price === "免费" ? " free" : ""}">${escapeHtml(model.price)}</span>` : '<span class="catalog-unknown">—</span>'}</td>
    <td data-label="模型能力"><div class="catalog-capabilities">${capabilities.join("")}</div></td>
    <td data-label="上下文窗口" class="catalog-centered"><b class="catalog-window" title="${escapeHtml(model.context_window ? `${Number(model.context_window).toLocaleString()} tokens，总上下文窗口` : "未公开")}">${formatCatalogTokens(model.context_window)}</b></td>
    <td data-label="最大输出" class="catalog-centered"><span class="catalog-unknown" title="上游未公开独立的最大输出 token，保持未知">—</span></td>
    <td data-label="思考档位"><div class="catalog-efforts">${effort}</div>${defaultEffort}</td>
    <td data-label="默认采样参数"><span class="catalog-unknown" title="上游未公开默认 temperature / top_p，保持未知">—</span></td>
    <td data-label="操作"><button type="button" class="button secondary small" data-action="test-model" data-id="${escapeHtml(model.id)}">测试</button></td>
  </tr>`;
}

function renderCatalogTable() {
  const models = state.config?.models || [];
  const visible = filterCatalogModels(models, state.catalogQuery, state.config?.default_model);
  $("#catalogFilterCount").textContent = `显示 ${visible.length} / ${models.length} 个模型`;
  $("#catalogRows").innerHTML = visible.length
    ? visible.map((model) => renderCatalogRow(model, state.config?.default_model)).join("")
    : `<tr><td colspan="9" class="table-empty">${models.length ? "没有符合当前条件的模型，请调整搜索词或清除筛选。" : "暂无模型数据，请刷新模型清单。"}</td></tr>`;
}

async function copyModelId(button) {
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(button.dataset.id);
    showToast("模型 ID 已复制");
  } catch {
    showToast("无法自动复制，请选中模型 ID 后手动复制。");
  } finally {
    button.disabled = false;
  }
}

function renderAccounts() {
  const list = $("#accountList");
  const empty = $("#accountEmpty");
  $("#accountMetricTotal").textContent = state.accounts.length;
  $("#accountMetricReady").textContent = state.accounts.filter((a) => a.available).length;
  $("#accountMetricCooling").textContent = state.accounts.filter((a) => a.state === "cooling").length;
  $("#accountMetricDisabled").textContent = state.accounts.filter((a) => a.state === "disabled").length;
  updateAccountFilters();
  const results = filteredAccounts();
  state.accountPage = Math.max(0, Math.min(state.accountPage, Math.ceil(results.length / state.pageSize) - 1));
  const visible = visibleAccounts(results);
  $("#accountsTableWrap").hidden = visible.length === 0;
  const pageCheckbox = $("#selectPageAccounts");
  const selectedOnPage = visible.filter((account) => state.selected.has(account.id)).length;
  pageCheckbox.checked = visible.length > 0 && selectedOnPage === visible.length;
  pageCheckbox.indeterminate = selectedOnPage > 0 && selectedOnPage < visible.length;
  pageCheckbox.disabled = visible.length === 0;
  empty.hidden = results.length > 0;
  empty.querySelector("strong").textContent = state.accounts.length ? "没有匹配的账号" : "还没有账号";
  empty.querySelector("p").textContent = state.accounts.length ? "请调整搜索或筛选条件。" : "离线扫描客户端或导入账号 JSON。";
  $("#accountsPrevious").disabled = state.accountPage === 0;
  $("#accountsNext").disabled = (state.accountPage + 1) * state.pageSize >= results.length;
  $("#accountsPage").textContent = `第 ${state.accountPage + 1} / ${Math.max(1, Math.ceil(results.length / state.pageSize))} 页`;
  list.innerHTML = visible.map((account) => {
    const label = { ready: "可用", disabled: "已停用", cooling: "冷却中", busy: "请求中", needs_login:'需重新登录', needs_verification:'需官网验证' }[account.state] || account.state;
    const cooldown = account.cooldown_remaining_seconds ? `冷却剩余 ${account.cooldown_remaining_seconds}s` : "无冷却";
    return `
      <tr class="${state.selected.has(account.id) ? "is-selected" : ""}">
        <td class="selection-cell" data-label="选择"><label class="row-select"><input type="checkbox" data-account-select="${escapeHtml(account.id)}" ${state.selected.has(account.id) ? "checked" : ""} aria-label="选择账号 ${escapeHtml(account.name || account.id)}"></label></td>
        <td data-label="账号" class="identity-cell"><strong class="cell-primary">${escapeHtml(account.name || account.id)}</strong><code class="cell-secondary table-code" title="${escapeHtml(account.id)}">${escapeHtml(account.id)}</code>${account.remark ? `<div class="cell-secondary cell-note">${escapeHtml(account.remark)}</div>` : ""}${state.accountTests.has(account.id) ? `<div class="cell-secondary ${state.accountTests.get(account.id).running ? "cell-muted" : state.accountTests.get(account.id).ok ? "success-text" : "error-text"}">${escapeHtml(state.accountTests.get(account.id).message)}</div>` : ""}<details class="cell-details device-details"><summary>设备信息</summary><div class="cell-secondary">device ${escapeHtml(account.device_id || "—")}<br>web ${escapeHtml(account.web_id || "—")}</div></details></td>
        <td data-label="状态"><span class="account-state ${escapeHtml(account.state)}">${escapeHtml(label)}</span></td>
        <td data-label="在途 / 冷却"><strong class="cell-primary tabular">${Number(account.in_flight || 0)} 个请求</strong><span class="cell-secondary">${escapeHtml(cooldown)}</span></td>
        <td data-label="最近错误">${account.error_code ? `<span class="code-pill">code: ${escapeHtml(account.error_code)}</span>` : ""}${renderErrorDetails(account.last_error)}</td>
        <td data-label="官方额度 / 签到"><div class="benefit-summary">${benefitSummary(account)}</div></td>
        <td data-label="操作" class="table-actions"><div class="account-actions">
          <button class="button ghost small" data-action="edit-account" data-id="${escapeHtml(account.id)}">编辑信息</button>
          <button type="button" class="button ghost small" data-action="account-quota" data-id="${escapeHtml(account.id)}">额度</button>
          <button type="button" class="button ghost small" data-action="account-checkin" data-id="${escapeHtml(account.id)}">签到</button>
          ${account.cooldown_remaining_seconds ? `<button class="button ghost small" data-action="clear-cooldown" data-id="${escapeHtml(account.id)}">解除冷却</button>` : ""}
          <button type="button" class="button secondary small" data-action="test-account" data-id="${escapeHtml(account.id)}" title="使用默认模型向此账号发送一条短请求，按模型正常计费" ${state.accountTests.get(account.id)?.running ? 'disabled aria-busy="true"' : ""}>${state.accountTests.get(account.id)?.running ? "测试中…" : "测试"}</button>
          <button class="button ${account.enabled ? "ghost" : "primary"} small" data-action="toggle-account" data-id="${escapeHtml(account.id)}" data-enabled="${account.enabled}">${account.enabled ? "停用" : "启用"}</button>
        </div></td>
      </tr>`;
  }).join("");
  renderSelection();
}

function statusLabel(status) {
  return { success: "成功", error: "失败", running: "进行中" }[status] || status;
}

function renderErrorDetails(error) {
  if (!error) return '<span class="cell-muted">—</span>';
  const text = String(error);
  if (text.length <= 80) return `<span class="error-text">${escapeHtml(text)}</span>`;
  return `<details class="cell-details error-details"><summary>${escapeHtml(text.slice(0, 70))}…</summary><div class="error-text">${escapeHtml(text)}</div></details>`;
}

function renderModelIdentity(modelId, requestId = "") {
  const model = state.config?.models?.find((item) => item.id === modelId || item.upstream_key === modelId);
  return `<strong class="cell-primary">${escapeHtml(model?.name || modelId || "—")}</strong><code class="cell-secondary table-code" title="${escapeHtml(modelId)}">${escapeHtml(modelId)}</code>${requestId ? `<code class="cell-secondary table-code" title="${escapeHtml(requestId)}">${escapeHtml(requestId)}</code>` : ""}`;
}

function renderRequestMetric(value, estimated = false, title = "未采集到此项数据") {
  if (value === null || value === undefined || value === "") return `<span class="cell-muted" title="${escapeHtml(title)}">—</span>`;
  const display = typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(value);
  return `<span${estimated ? ' class="estimated-metric" title="本地估算，并非官方计费 Token；输出包含思考，思考列为其中子集"' : ""}>${estimated ? "≈" : ""}${escapeHtml(display)}</span>`;
}

function renderRequestRow(log, detailed = false) {
  const account = state.accounts.find((item) => item.id === log.account_id);
  const keyId = log.meta?.key_id;
  const key = state.keys.find((item) => item.id === keyId);
  const date = timestampDate(log.started_at);
  const model = state.config?.models?.find((item) => item.id === log.model || item.upstream_key === log.model);
  const probe = keyId === "admin-account-test";
  const accountLabel = account?.name || (log.account_id ? log.account_id.replace(/^account-/, "").slice(0, 8) : "—");
  const dateLabel = date ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" }).format(date).replace("/", "-") + " " + formatTime(log.started_at) : "—";
  const effort = log.meta?.reasoning_effort || (probe ? "low" : null);
  const cacheRate = log.cached_tokens != null && log.input_tokens > 0 ? `${(log.cached_tokens / log.input_tokens * 100).toFixed(1)}%` : null;
  return `<tr>
    <td data-label="时间" class="time-cell"><time title="${escapeHtml(date?.toLocaleString("zh-CN", { hour12: false }) || "")}">${escapeHtml(dateLabel)}</time></td>
    <td data-label="模型" class="model-identity-cell"><div class="request-model-content"><code class="request-model-id" title="${escapeHtml(model?.name || log.model)}">${escapeHtml(log.model || "—")}</code>${detailed ? `<details class="request-id-details"><summary title="查看请求 ID">ID</summary><code>${escapeHtml(log.id)}</code></details>` : ""}</div></td>
    <td data-label="推理强度">${effort ? `<span class="catalog-effort">${escapeHtml(effort)}</span>` : renderRequestMetric(null)}</td>
    <td data-label="账号" class="request-account"><span title="${escapeHtml(log.account_id || "")}">${escapeHtml(accountLabel)}</span></td>
    <td data-label="API Key" class="request-key"><span title="${escapeHtml(probe ? "由管理面板发起，未使用 API Key" : keyId || "")}">${probe ? "面板测试" : escapeHtml(key?.name || keyId?.slice(0, 12) || "—")}</span></td>
    <td data-label="模式"><span class="mode-pill">${probe ? "测试" : log.stream ? "流式" : "普通"}</span></td>
    <td data-label="结果"><span class="status-badge ${escapeHtml(log.status)}">${escapeHtml(log.status === "success" ? "完成" : statusLabel(log.status))}</span></td>
    <td data-label="耗时" class="numeric tabular">${escapeHtml(formatDuration(log.duration_ms))}</td>
    <td data-label="首字" class="numeric tabular">${renderRequestMetric(log.ttft_ms == null ? null : formatDuration(log.ttft_ms))}</td>
    <td data-label="速度" class="numeric tabular" title="生成速度，单位 tok/s；≈ 表示基于估算 Token">${renderRequestMetric(log.tokens_per_second == null ? null : log.tokens_per_second.toFixed(1), log.usage_estimated)}</td>
    <td data-label="输入" class="numeric tabular">${renderRequestMetric(log.input_tokens, log.usage_estimated)}</td>
    <td data-label="输出" class="numeric tabular">${renderRequestMetric(log.output_tokens, log.usage_estimated)}</td>
    <td data-label="思考" class="numeric tabular">${renderRequestMetric(log.reasoning_tokens, log.usage_estimated)}</td>
    <td data-label="缓存" class="numeric tabular">${renderRequestMetric(cacheRate, false, "未取得上游官方缓存用量")}</td>
    <td data-label="总 token" class="numeric tabular">${renderRequestMetric(log.total_tokens, log.usage_estimated)}</td>
    <td data-label="积分" class="numeric tabular">${renderRequestMetric(log.credits, false, "未取得此请求的官方扣费数据")}</td>
    <td data-label="估算价格" class="numeric tabular">${renderRequestMetric(log.estimated_price == null ? null : `￥${log.estimated_price.toFixed(3)}`, false, "未配置可信的价格换算依据")}</td>
    ${detailed ? `<td data-label="错误详情">${renderErrorDetails(log.error)}</td>` : ""}
  </tr>`;
}

function renderOverviewLogs() {
  const logs = state.logs.slice(0, 20);
  $("#overviewLogsEmpty").hidden = logs.length > 0;
  $("#overviewLogsWrap").hidden = logs.length === 0;
  $("#overviewLogs").innerHTML = logs.map((log) => renderRequestRow(log)).join("");
}

function filteredLogs() {
  const query = ($("#logSearch")?.value || "").trim().toLowerCase();
  const records = state.historyLogs || state.logs;
  if (!query) return records;
  return records.filter((log) => [log.model, log.account_id, log.error, log.status, statusLabel(log.status), log.id, log.meta?.key_id].some((value) => String(value || "").toLowerCase().includes(query)));
}

function renderLogs() {
  const logs = filteredLogs();
  $("#logCountBadge").textContent = `${logs.length} 条`;
  $("#logEmpty").hidden = logs.length > 0;
  $("#logsTableWrap").hidden = logs.length === 0;
  const pages = Math.max(1, Math.ceil(logs.length / state.logPageSize));
  state.logPage = Math.max(0, Math.min(state.logPage, pages - 1));
  const visible = logs.slice(state.logPage * state.logPageSize, (state.logPage + 1) * state.logPageSize);
  $("#logRows").innerHTML = visible.map((log) => renderRequestRow(log, true)).join("");
  $("#logsPage").textContent = `第 ${state.logPage + 1} / ${pages} 页 · 共 ${logs.length} 条`;
  $("#logsPrevious").disabled = state.logPage === 0;
  $("#logsNext").disabled = state.logPage + 1 >= pages;
}

function analyticsLogs() {
  if (state.analyticsRange === "all") return state.logs;
  return state.logs.filter((log) => log.status === state.analyticsRange);
}

function aggregateModelUsage(logs) {
  const byModel = new Map();
  for (const log of logs) {
    const item = byModel.get(log.model) || { model: log.model, total: 0, success: 0, error: 0, duration: 0, finished: 0 };
    item.total += 1;
    item[log.status] = (item[log.status] || 0) + 1;
    if (log.status !== "running") { item.duration += Number(log.duration_ms || 0); item.finished += 1; }
    byModel.set(log.model, item);
  }
  return [...byModel.values()].sort((a, b) => b.total - a.total);
}

function renderAnalytics() {
  const logs = analyticsLogs();
  const finished = logs.filter((log) => log.status !== "running");
  const success = logs.filter((log) => log.status === "success").length;
  const streams = logs.filter((log) => log.stream).length;
  const average = finished.length ? finished.reduce((sum, log) => sum + Number(log.duration_ms || 0), 0) / finished.length : 0;
  $("#analyticsRequests").textContent = logs.length;
  $("#analyticsSuccessRate").textContent = finished.length ? `${((success / finished.length) * 100).toFixed(1)}%` : "—";
  $("#analyticsLatency").textContent = finished.length ? formatDuration(average) : "—";
  $("#analyticsStreamShare").textContent = logs.length ? `${((streams / logs.length) * 100).toFixed(0)}%` : "—";

  const rows = aggregateModelUsage(logs);
  const max = Math.max(1, ...rows.map((item) => item.total));
  $("#modelDistribution").innerHTML = rows.length ? rows.map((item) => `
    <div class="distribution-row"><div><code>${escapeHtml(item.model)}</code><span>${item.total}</span></div><div class="bar-track"><span style="width:${(item.total / max) * 100}%"></span></div></div>
  `).join("") : `<div class="empty-state compact"><strong>暂无数据</strong><p>发起请求后显示模型分布。</p></div>`;
  $("#analyticsRows").innerHTML = rows.length ? rows.map((item) => `
    <tr><td data-label="模型" class="model-identity-cell">${renderModelIdentity(item.model)}</td><td data-label="请求" class="numeric tabular"><b>${item.total}</b></td><td data-label="成功" class="numeric tabular success-text">${item.success || 0}</td><td data-label="失败" class="numeric tabular error-text">${item.error || 0}</td><td data-label="成功率" class="numeric tabular">${item.finished ? `${((item.success / item.finished) * 100).toFixed(1)}%` : "—"}</td><td data-label="平均耗时" class="numeric tabular">${item.finished ? formatDuration(item.duration / item.finished) : "—"}</td></tr>
  `).join("") : `<tr><td colspan="6" class="table-empty">暂无请求，发起调用后显示模型用量。</td></tr>`;

  const recent = logs.slice(0, 24).reverse();
  const peak = Math.max(1, ...recent.map((log) => Number(log.duration_ms || 0)));
  $("#latencyChart").innerHTML = recent.length ? recent.map((log) => `
    <div class="latency-bar ${escapeHtml(log.status)}" style="height:${Math.max(4, (Number(log.duration_ms || 0) / peak) * 100)}%" title="${escapeHtml(log.model)} · ${formatDuration(log.duration_ms)}"></div>
  `).join("") : `<div class="empty-state compact"><strong>暂无数据</strong><p>趋势图会在有请求后出现。</p></div>`;
}

function renderSettings() {
  if (state.routing && !state.routingDirty) {
    $('#nativeSessions').checked = state.routing.native_sessions;
    $('#largeRequestBytes').value = state.routing.large_request_bytes;
    $('#largeRequestBudget').value = state.routing.large_request_budget;
    $('#largeRequestWindow').value = state.routing.large_request_window;
  }
  const config = state.config || {};
  $("#settingListen").textContent = config.listen || "—";
  $("#settingUpstream").textContent = config.upstream || "—";
  if (!state.runtimeDirty) {
    const runtime = config.runtime || config;
    $("#settingDefaultModel").innerHTML = (config.models || []).map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)} · ${escapeHtml(model.id)}</option>`).join("");
    $("#settingDefaultModel").value = runtime.default_model || config.default_model || "";
    $("#settingTimeout").value = runtime.timeout_seconds ?? "";
    $("#settingCooldown").value = runtime.cooldown_seconds ?? "";
    $("#settingAccountConcurrency").value = runtime.account_max_concurrent ?? 0;
  }
  $("#settingAccountsDir").textContent = config.accounts_dir || "—";
}

async function toggleAccount(id, enabled, button) {
  if (enabled && !window.confirm("确认停用 1 个账号？该账号将停止接收新请求。")) return;
  button.disabled = true;
  try {
    await api(`/admin/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !enabled }) });
    await refresh({ silent: true });
    showToast(enabled ? "账号已停用" : "账号已启用");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function clearCooldown(id, button) {
  button.disabled = true;
  try {
    const result = await api("/admin/accounts/batch", { method: "POST", body: JSON.stringify({ action: "clear-cooldown", ids: [id] }) });
    if (result.errors?.length) throw new Error(batchErrorText(result.errors));
    await refresh({ silent: true });
    showToast("冷却已解除");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function importAccounts(document) {
  const accounts = accountImportDocuments(document);
  const result = await api("/admin/accounts/import", { method: "POST", body: JSON.stringify({ accounts }) });
  if (result.errors?.length) throw new Error(result.errors.join("；"));
  return result;
}

function parseAccountImportFile(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("文件不是有效的 JSON。"); }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.accounts)) return parsed.accounts;
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error("文件必须包含账号对象、账号数组或 accounts 数组。");
}

function accountImportDocuments(document) {
  let value = document;
  if (typeof value === "string") {
    try { value = JSON.parse(value); }
    catch { throw new Error("账号 JSON 格式无效，请检查引号和逗号。"); }
  }
  if (value && !Array.isArray(value) && typeof value === "object" && "accounts" in value) {
    if (!Array.isArray(value.accounts)) {
      throw new Error("导出文件的 accounts 字段必须是账号数组。");
    }
    value = value.accounts;
  }
  const accounts = Array.isArray(value) ? value : [value];
  if (!accounts.length) throw new Error("没有提供账号。");
  if (accounts.some((account) => !account || typeof account !== "object" || Array.isArray(account))) {
    throw new Error("账号 JSON 必须是账号对象、账号数组，或包含 accounts 数组的导出文件。");
  }
  return accounts;
}

async function scanOffline(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "扫描中…";
  try {
    const result = await api("/admin/accounts/scan-offline", { method: "POST" });
    await refresh({ silent: true });
    showToast(`${result.created ? "已导入" : "已更新"} ${result.account.id}（${result.cookie_count} 个 Cookie）`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function openImport() {
  $("#importJson").value = "";
  $("#importFiles").value = "";
  $("#importError").hidden = true;
  $("#importDialog").showModal();
}

function closeImport() {
  $("#importDialog").close();
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("#loginError").hidden = true;
  try {
    button.textContent = "登录中…";
    await login($("#loginPassword").value);
  } catch (error) {
    $("#loginError").hidden = false;
    $("#loginError").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "进入控制台 →";
  }
});

$("#logoutButton").addEventListener("click", logout);
$("#menuButton").addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
$("#sidebarBackdrop").addEventListener("click", () => document.body.classList.remove("sidebar-open"));
$("#themeButton").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  localStorage.setItem("doubao_theme", dark ? "dark" : "light");
});
$("#autoRefreshButton").addEventListener("click", () => {
  const button = $("#autoRefreshButton");
  const enabled = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "自动刷新 开" : "自动刷新 关";
  clearInterval(state.refreshTimer);
  state.refreshTimer = enabled ? setInterval(() => { if (!appView.hidden) refresh({ silent: true }); }, 5000) : null;
});
$("#logSearch").addEventListener("input", () => { state.logPage = 0; renderLogs(); });
$("#logsPrevious").addEventListener("click", () => { state.logPage -= 1; renderLogs(); });
$("#logsNext").addEventListener("click", () => { state.logPage += 1; renderLogs(); });
document.addEventListener("click", (event) => {
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) return switchTab(tabButton.dataset.tab);
  const jump = event.target.closest("[data-tab-jump]");
  if (jump) return switchTab(jump.dataset.tabJump);
  const range = event.target.closest("[data-range]");
  if (range) {
    state.analyticsRange = range.dataset.range;
    $$("#analyticsRange button").forEach((button) => button.classList.toggle("active", button === range));
    return renderAnalytics();
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "refresh") withButton(target, "刷新中…", () => refresh());
  if (action === 'qr-login') withButton(target, '获取中…', () => startQR());
  if (action === 'close-qr') closeQR();
  if (action === 'refresh-catalog') withButton(target, '同步中…', async () => {
    const account_id = [...state.selected][0];
    await api('/admin/catalog/refresh', {method: 'POST', body: JSON.stringify(account_id ? {account_id} : {})});
    await refresh({silent: true});
    showToast('官方模型目录已更新');
  });
  if (action === 'account-quota') withButton(target, '查询中…', () => queryQuota(target.dataset.id));
  if (action === 'account-checkin') withButton(target, '签到中…', () => checkinAccounts([target.dataset.id]));
  if (action === 'checkin-all') withButton(target, '执行中…', () => checkinAccounts());
  if (action === 'run-daily-checkin') withButton(target, '执行中…', () => runAutomation(false));
  if (action === 'run-unconfirmed-checkin') withButton(target, '执行中…', () => runAutomation(true));
  if (action === 'checkin-selected') withButton(target, '执行中…', () => {
    if (!state.selected.size) throw new Error('请先勾选账号。');
    return checkinAccounts([...state.selected]);
  });
  if (action === "test-account") testAccount(target.dataset.id);
  if (action === 'test-model') openModelTest(target.dataset.id);
  if (action === 'close-model-test') $('#modelTestDialog').close();
  if (action === 'browser-login') withButton(target,'打开中…',startBrowserLogin);
  if (action === 'finish-browser') withButton(target,'核验中…',finishBrowserLogin);
  if (action === 'cancel-browser') withButton(target,'关闭中…',cancelBrowserLogin);
  if (action === 'recent-logs') { state.historyLogs=null; state.historyOffset=0; state.logPage=0; renderLogs(); }
  if (action === 'older-history') withButton(target,'加载中…',()=>loadHistoryLogs(state.historyOffset+200));
  if (action === 'newer-history') withButton(target,'加载中…',()=>loadHistoryLogs(Math.max(0,state.historyOffset-200)));
  if (action === "copy-model-id") copyModelId(target);
  if (action === "clear-model-filter") { state.catalogQuery = ""; $("#catalogSearch").value = ""; renderCatalogTable(); }
  if (action === "logout") logout();
  if (action === "open-import") openImport();
  if (action === "scan-offline") scanOffline(target);
  if (action === "close-import") closeImport();
  if (action === "toggle-account") toggleAccount(target.dataset.id, target.dataset.enabled === "true", target);
  if (action === "clear-cooldown") clearCooldown(target.dataset.id, target);
  if (action === "edit-account") openAccount(target.dataset.id);
  if (action === "create-key") openKey();
  if (action === "edit-key") openKey(target.dataset.id);
  if (action === "toggle-key") toggleKey(target);
  if (action === "delete-key") deleteKey(target);
  if (action === "select-visible") { visibleAccounts().forEach((a) => state.selected.add(a.id)); renderAccounts(); }
  if (action === "select-results") { filteredAccounts().forEach((a) => state.selected.add(a.id)); renderAccounts(); }
  if (action === "clear-selection") { state.selected.clear(); renderAccounts(); }
});

$("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("#importError").hidden = true;
  try {
    const document = JSON.parse($("#importJson").value);
    const result = await importAccounts(document);
    closeImport();
    await refresh({ silent: true });
    showToast(`已导入 ${result.imported.length} 个账号`);
  } catch (error) {
    $("#importError").hidden = false;
    $("#importError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#importFiles").addEventListener("change", async (event) => {
  const files = [...event.target.files];
  if (!files.length) return;
  try {
    const documents = [];
    for (const file of files) {
      documents.push(...parseAccountImportFile(await file.text()));
    }
    $("#importJson").value = JSON.stringify(documents.length === 1 ? documents[0] : documents, null, 2);
    $("#importError").hidden = true;
  } catch (error) {
    $("#importError").hidden = false;
    $("#importError").textContent = `文件解析失败：${error.message}`;
  }
});

async function boot() {
  sessionStorage.removeItem("doubao_api_key");
  switchTab(new URLSearchParams(location.search).get('tab') || 'overview', false);
  const theme = localStorage.getItem("doubao_theme");
  if (theme) document.documentElement.dataset.theme = theme;
  try {
    await loadDashboard();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
    } else {
      showLogin(error.message);
    }
  }
}

function feedback(selector, message = "", error = false) {
  const element = $(selector);
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle("is-error", error);
}

async function withButton(button, label, operation) {
  if (button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  button.setAttribute("aria-busy", "true");
  try { await operation(); }
  catch (error) { if (error.status !== 401) showToast(error.message || '操作失败，请稍后重试。'); }
  finally {
    button.disabled = false;
    button.textContent = original;
    button.removeAttribute("aria-busy");
    if (['run-daily-checkin','run-unconfirmed-checkin'].includes(button.dataset?.action)) renderAutomation();
  }
}

function bindForm(selector, feedbackSelector, operation) {
  $(selector).addEventListener("submit", (event) => {
    event.preventDefault();
    const button = event.submitter || $(selector).querySelector('[type="submit"]');
    withButton(button, "保存中…", async () => {
      feedback(feedbackSelector);
      try { await operation(); }
      catch (error) {
        if (error.status === 401) return;
        feedback(feedbackSelector, error.message, true);
      }
    });
  });
}

function updateAccountFilters() {
  const codes = [...new Set(state.accounts.map((a) => String(a.error_code ?? "")))].sort();
  for (const [selector, values, all, empty] of [
    ["#accountErrorCode", codes, "全部错误码", "无错误码"],
  ]) {
    const select = $(selector);
    const previous = select.value;
    // Keep the active filter even if its last matching account was edited/deleted.
    const options = [...new Set([...values, ...(previous ? [previous.slice(2)] : [])])];
    const markup = `<option value="">${all}</option>` + options.map((value) => `<option value="v:${escapeHtml(value)}">${escapeHtml(value || empty)}</option>`).join("");
    if (select.innerHTML !== markup) { select.innerHTML = markup; select.value = previous; }
  }
}

function filteredAccounts() {
  const query = $("#accountSearch").value.trim().toLocaleLowerCase();
  const status = $("#accountStatus").value;
  const code = $("#accountErrorCode").value;
  return state.accounts.filter((a) =>
    (!query || [a.id, a.name, a.remark, a.error_code, a.last_error].some((v) => String(v ?? "").toLocaleLowerCase().includes(query))) &&
    (!status || a.state === status) &&
    (!code || String(a.error_code ?? "") === code.slice(2)));
}

function visibleAccounts(results = filteredAccounts()) {
  return results.slice(state.accountPage * state.pageSize, (state.accountPage + 1) * state.pageSize);
}

function renderSelection() {
  const results = filteredAccounts();
  const matchingSelected = results.filter((a) => state.selected.has(a.id)).length;
  $("#selectionSummary").textContent = `筛选结果 ${results.length} 个 · 当前页 ${visibleAccounts(results).length} 个 · 已选 ${state.selected.size} 个（筛选外 ${state.selected.size - matchingSelected} 个）。批量操作作用于全部已选账号。`;
  $$("[data-batch]").forEach((button) => { button.disabled = state.selected.size === 0; });
  const pageCheckbox = $("#selectPageAccounts");
  if (pageCheckbox) {
    const page = visibleAccounts(results);
    const count = page.filter((account) => state.selected.has(account.id)).length;
    pageCheckbox.checked = page.length > 0 && count === page.length;
    pageCheckbox.indeterminate = count > 0 && count < page.length;
    pageCheckbox.disabled = page.length === 0;
  }
}

for (const id of ["#accountSearch", "#accountStatus", "#accountErrorCode"]) {
  $(id).addEventListener(id === "#accountSearch" ? "input" : "change", () => { state.accountPage = 0; renderAccounts(); });
}
$("#accountList").addEventListener("change", (event) => {
  const id = event.target.dataset.accountSelect;
  if (!id) return;
  if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
  event.target.closest("tr")?.classList.toggle("is-selected", event.target.checked);
  renderSelection();
});
$("#selectPageAccounts").addEventListener("change", (event) => {
  visibleAccounts().forEach((account) => { if (event.target.checked) state.selected.add(account.id); else state.selected.delete(account.id); });
  renderAccounts();
});
$("#accountsPrevious").addEventListener("click", () => { state.accountPage -= 1; renderAccounts(); });
$("#accountsNext").addEventListener("click", () => { state.accountPage += 1; renderAccounts(); });

async function testAccount(id) {
  const account = state.accounts.find((item) => item.id === id);
  if (!account || state.accountTests.get(id)?.running) return;
  if (!account.available) return showToast("请先启用账号并等待或解除冷却。");
  const epoch = state.sessionEpoch;
  state.accountTests.set(id, { running: true, message: "正在测试…" });
  renderAccounts();
  try {
    const result = await api(`/admin/accounts/${encodeURIComponent(id)}/test`, { method: "POST" });
    if (epoch !== state.sessionEpoch) return;
    const message = `测试通过 · ${formatDuration(result.duration_ms)}`;
    state.accountTests.set(id, { ok: true, message });
    showToast(message);
  } catch (error) {
    if (epoch !== state.sessionEpoch) return;
    const message = `测试失败：${error.message}`;
    state.accountTests.set(id, { ok: false, message });
    showToast(message);
  } finally {
    if (epoch === state.sessionEpoch) {
      renderAccounts();
      await refresh({ silent: true });
    }
  }
}

function openAccount(id) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  state.editAccountId = id;
  $("#accountEditId").textContent = id;
  $("#accountName").value = account.name || "";
  $("#accountRemark").value = account.remark || "";
  feedback("#accountFeedback");
  $("#accountDialog").showModal();
}
bindForm("#accountForm", "#accountFeedback", async () => {
  await api(`/admin/accounts/${encodeURIComponent(state.editAccountId)}`, { method: "PATCH", body: JSON.stringify({
    name: $("#accountName").value.trim(), remark: $("#accountRemark").value.trim(),
  }) });
  $("#accountDialog").close();
  await refresh({ silent: true });
  showToast("账号信息已保存");
});

const BATCH_LABELS = { enable: "启用", disable: "停用", delete: "删除", "clear-cooldown": "清除冷却", export: "导出" };
function beginBatch(action) {
  const ids = [...state.selected];
  if (!ids.length) return;
  state.pendingBatch = { action, ids };
  $("#batchTitle").textContent = `确认${BATCH_LABELS[action]} ${ids.length} 个账号`;
  $("#batchDescription").textContent = action === "delete" ? `将永久删除所选 ${ids.length} 个账号，无法撤销。` : action === "export" ? `将下载所选 ${ids.length} 个账号的 JSON 文件，其中包含 Cookie 等凭证。请将文件保存到安全位置。` : `将对所选 ${ids.length} 个账号执行「${BATCH_LABELS[action]}」。包含筛选范围外已选账号。`;
  $("#batchConfirm").textContent = `确认${BATCH_LABELS[action]} ${ids.length} 个账号`;
  $("#batchConfirm").classList.toggle("danger", action === "delete");
  feedback("#batchDialogFeedback");
  $("#batchDialog").showModal();
}
function batchErrorText(errors) {
  return errors.map((error) => typeof error === "string" ? error : `${error.id || "账号"}：${error.error?.message || error.error || error.message || "操作失败"}`).join("；");
}
bindForm("#batchForm", "#batchDialogFeedback", async () => {
  const pending = state.pendingBatch;
  if (!pending) return;
  const { action, ids } = pending;
  if (action === "export") {
    const data = await api("/admin/accounts/export", { method: "POST", body: JSON.stringify({ ids }) });
    if (!Array.isArray(data.accounts)) throw new Error("导出响应缺少账号列表，请重试。");
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `doubao-accounts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback("#batchFeedback", `已导出 ${data.accounts.length} 个账号。文件包含凭证，请妥善保管。`);
  } else {
    const payload = { action, ids };
    const result = await api("/admin/accounts/batch", { method: "POST", body: JSON.stringify(payload) });
    const succeeded = result.succeeded || [];
    const errors = result.errors || [];
    succeeded.forEach((id) => state.selected.delete(id));
    feedback("#batchFeedback", `${BATCH_LABELS[action]}完成：成功 ${succeeded.length} / ${ids.length} 个，失败 ${errors.length} 个。${errors.length ? `失败项保留选择。${batchErrorText(errors)}` : ""}`, errors.length > 0);
    await refresh({ silent: true });
  }
  state.pendingBatch = null;
  $("#batchDialog").close();
});

function renderKeys() {
  $("#keysEmpty").hidden = state.keys.length > 0;
  $("#keysTableWrap").hidden = state.keys.length === 0;
  $("#keyList").innerHTML = state.keys.map((key) => {
    const missing = missingKeyAccounts(key);
    const accountText = key.accounts?.length
      ? key.accounts.map((id) => missing.includes(id) ? `${id}（已删除，当前不可用）` : id).join("、")
      : "全部";
    return `
    <tr>
      <td data-label="名称 / ID" class="identity-cell"><strong class="cell-primary">${escapeHtml(key.name || key.id)}</strong><code class="cell-secondary table-code" title="${escapeHtml(key.id)}">${escapeHtml(key.id)}</code></td>
      <td data-label="状态"><span class="status-badge ${key.enabled ? "success" : "disabled"}">${key.enabled ? "已启用" : "已停用"}</span></td>
      <td data-label="模型范围">${renderScopeList(key.models || [], "全部模型")}</td>
      <td data-label="账号范围">${key.accounts?.length ? `<details class="cell-details"><summary>${key.accounts.length} 个账号${missing.length ? " · 含失效绑定" : ""}</summary><div class="cell-secondary cell-note">${escapeHtml(accountText)}</div></details>` : '<span class="cell-muted">全部账号</span>'}${missing.length ? '<div class="error-text cell-secondary">绑定账号已删除，请编辑改绑。</div>' : ""}</td>
      <td data-label="并发上限" class="numeric tabular">${escapeHtml(key.concurrency_limit || "不限")}</td>
      <td data-label="使用时间"><span class="cell-primary">${escapeHtml(formatTime(key.last_used_at))}</span><span class="cell-secondary" title="${escapeHtml(key.created_at)}">创建 ${escapeHtml(timestampDate(key.created_at)?.toLocaleDateString("zh-CN") || "—")}</span></td>
      <td data-label="操作" class="table-actions"><div class="account-actions"><button type="button" class="button ghost small" data-action="edit-key" data-id="${escapeHtml(key.id)}">编辑</button><button type="button" class="button ghost small" data-action="toggle-key" data-id="${escapeHtml(key.id)}">${key.enabled ? "停用" : "启用"}</button><button type="button" class="button danger small" data-action="delete-key" data-id="${escapeHtml(key.id)}">删除</button></div></td>
    </tr>`;
  }).join("");
}

function renderScopeList(values, emptyLabel) {
  if (!values.length) return `<span class="cell-muted">${escapeHtml(emptyLabel)}</span>`;
  return `<details class="cell-details"><summary>${values.length} 个模型</summary><div class="scope-list">${values.map((value) => `<code>${escapeHtml(value)}</code>`).join("")}</div></details>`;
}

function missingKeyAccounts(key) {
  const existing = new Set(state.accounts.map((account) => account.id));
  return (key?.accounts || []).filter((id) => !existing.has(id));
}

function selectorOptions(selector, values, selected, unavailableLabel = "当前不可用，保留配置") {
  const entries = new Map(values);
  selected.forEach((value) => { if (!entries.has(value)) entries.set(value, `${value}（${unavailableLabel}）`); });
  $(selector).innerHTML = [...entries].map(([value, label]) => `<label class="check-label"><input type="checkbox" value="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""}><span>${escapeHtml(label)}</span></label>`).join("") || '<p class="muted small">当前没有可选项。</p>';
}
function selectedAccountsForSave(existing, checked) {
  const accounts = [...checked];
  const missing = existing
    ? missingKeyAccounts(existing).filter((accountId) => accounts.includes(accountId))
    : [];
  if (missing.length) {
    throw new Error(`此 Key 绑定的账号 ${missing.join("、")} 已删除。请显式取消该勾选以清除绑定，或改绑到现有账号；不会自动转为允许全部账号。`);
  }
  return accounts;
}
function openKey(id = null) {
  const key = state.keys.find((item) => item.id === id);
  if (id && !key) return;
  state.editKeyId = id;
  $("#keyForm").reset();
  $("#keyTitle").textContent = id ? "编辑 API Key" : "创建 API Key";
  $("#keyName").value = key?.name || "";
  $("#keyConcurrency").value = key?.concurrency_limit ?? 0;
  $("#keyEnabled").checked = key?.enabled ?? true;
  $("#keyEnabledField").hidden = !id;
  selectorOptions("#keyModels", (state.config?.models || []).map((m) => [m.id, `${m.name || m.id} · ${m.id}`]), key?.models || []);
  selectorOptions("#keyAccounts", state.accounts.map((a) => [a.id, `${a.name || a.id} · ${a.id}`]), key?.accounts || [], "已删除，当前不可用");
  feedback("#keyFeedback");
  $("#keyDialog").showModal();
}
bindForm("#keyForm", "#keyFeedback", async () => {
  const id = state.editKeyId;
  const existing = state.keys.find((key) => key.id === id);
  if (existing?.enabled && !$("#keyEnabled").checked && !window.confirm("确认停用 1 个 API Key？使用此密钥的请求将无法通过鉴权。")) return;
  const accounts = selectedAccountsForSave(existing, $$("#keyAccounts input:checked").map((input) => input.value));
  const payload = {
    name: $("#keyName").value.trim(), concurrency_limit: Number($("#keyConcurrency").value),
    models: $$("#keyModels input:checked").map((input) => input.value),
    accounts,
  };
  if (!payload.name) throw new Error("请输入密钥名称");
  if (id) payload.enabled = $("#keyEnabled").checked;
  const result = await api(id ? `/admin/keys/${encodeURIComponent(id)}` : "/admin/keys", { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
  $("#keyDialog").close();
  if (!id) {
    if (!result.key) throw new Error("创建成功但未返回完整密钥，请重新读取密钥列表。");
    $("#newKeySecret").value = result.key;
    feedback("#copyFeedback");
    $("#keySecretDialog").showModal();
    $("#newKeySecret").select();
  }
  await refresh({ silent: true });
  showToast(id ? "API Key 已更新" : "API Key 已创建，请保存密钥");
});
$("#keySecretDialog").addEventListener("close", () => { $("#newKeySecret").value = ""; feedback("#copyFeedback"); });
$("#copyKey").addEventListener("click", () => withButton($("#copyKey"), "复制中…", async () => {
  try { await navigator.clipboard.writeText($("#newKeySecret").value); feedback("#copyFeedback", "密钥已复制，请保存到安全位置。"); }
  catch { $("#newKeySecret").focus(); $("#newKeySecret").select(); feedback("#copyFeedback", "无法自动复制，请手动复制上方已选中的密钥。", true); }
}));
async function toggleKey(button) {
  const key = state.keys.find((item) => item.id === button.dataset.id);
  if (!key || (key.enabled && !window.confirm("确认停用 1 个 API Key？使用此密钥的请求将无法通过鉴权。"))) return;
  await withButton(button, "保存中…", async () => {
    try {
      await api(`/admin/keys/${encodeURIComponent(key.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !key.enabled }) });
      await refresh({ silent: true });
      showToast(key.enabled ? "API Key 已停用" : "API Key 已启用");
    } catch (error) { showToast(error.message); }
  });
}
async function deleteKey(button) {
  const key = state.keys.find((item) => item.id === button.dataset.id);
  if (!key || !window.confirm(`确认永久删除 1 个 API Key「${key.name || key.id}」？此操作无法撤销。`)) return;
  await withButton(button, "删除中…", async () => {
    try {
      await api(`/admin/keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      await refresh({ silent: true });
      showToast("已删除 1 个 API Key");
    } catch (error) { showToast(error.message); }
  });
}

$("#runtimeForm").addEventListener("input", () => { state.runtimeDirty = true; });
$("#runtimeForm").addEventListener("change", () => { state.runtimeDirty = true; });
bindForm("#runtimeForm", "#runtimeFeedback", async () => {
  const payload = { default_model: $("#settingDefaultModel").value, timeout_seconds: Number($("#settingTimeout").value), cooldown_seconds: Number($("#settingCooldown").value), account_max_concurrent: Number($("#settingAccountConcurrency").value) };
  if (!payload.default_model || !Number.isFinite(payload.timeout_seconds) || payload.timeout_seconds <= 0 || !Number.isFinite(payload.cooldown_seconds) || payload.cooldown_seconds < 0) throw new Error("请选择默认模型并输入有效的超时、冷却秒数。");
  if (!Number.isInteger(payload.account_max_concurrent) || payload.account_max_concurrent < 0 || payload.account_max_concurrent > 10) throw new Error("账号级并发上限必须是 0～10 的整数，0 表示不限。");
  const current = state.config?.runtime || state.config || {};
  const changes = Object.fromEntries(Object.entries(payload).filter(([name, value]) => current[name] !== value));
  if (!Object.keys(changes).length) {
    state.runtimeDirty = false;
    feedback("#runtimeFeedback", "运行配置没有变化。");
    return;
  }
  const result = await api("/admin/config", { method: "PUT", body: JSON.stringify(changes) });
  state.config = { ...state.config, ...result };
  state.runtimeDirty = false;
  renderAll();
  feedback("#runtimeFeedback", "运行配置已保存。");
});
bindForm("#passwordForm", "#passwordFeedback", async () => {
  const current = $("#currentPassword").value;
  const password = $("#newPassword").value;
  if (password !== $("#confirmPassword").value) throw new Error("两次输入的新密码不一致。");
  if (!current || !password) throw new Error("请输入当前密码和新密码。");
  if (!window.confirm("确认修改管理员密码？所有管理会话将失效，需要重新登录。")) return;
  await api("/admin/password", { method: "POST", body: JSON.stringify({ current_password: current, new_password: password }) });
  resetSession("管理员密码已修改，请使用新密码重新登录。");
  $("#loginPassword").focus();
});

document.addEventListener("click", (event) => {
  const close = event.target.closest("[data-close]");
  if (close) {
    const dialog = document.getElementById(close.dataset.close);
    if (!dialog.querySelector('[aria-busy="true"]')) dialog.close();
  }
  const batch = event.target.closest("[data-batch]");
  if (batch) beginBatch(batch.dataset.batch);
});
$$("dialog").forEach((dialog) => dialog.addEventListener("cancel", (event) => {
  if (dialog.querySelector('[aria-busy="true"]')) event.preventDefault();
}));

$("#catalogSearch").addEventListener("input", (event) => { state.catalogQuery = event.target.value; renderCatalogTable(); });

function officialNumber(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-CN', {maximumFractionDigits: 2});
}

function benefitSummary(account) {
  const benefits = account.benefits || {};
  const windows = benefits.quota?.windows || [];
  const quota = windows.length ? windows.map((w) => `${w.name} ${w.unlimited ? '不限' : '剩 ' + officialNumber(w.remaining)}`).join(' · ') : '额度未同步';
  const daily = benefits.checkin;
  const status = daily ? `${daily.day} · ${daily.message || daily.status}` : '尚无签到记录';
  return `<span class="cell-secondary" title="${escapeHtml(quota)}">${escapeHtml(quota)}</span><span class="cell-secondary" title="${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function renderReferenceFeatures() {
  renderAutomation();
  const catalog = state.config?.catalog || {};
  const source = {official: '官方目录', cache: '本地缓存', builtin: '内置目录'}[catalog.source] || '模型目录';
  $('#catalogSource').textContent = `${source}${catalog.updated_at ? ' · ' + formatTime(catalog.updated_at) : ''}`;
  if (state.automationDirty) return;
  const config = state.benefits?.config || {enabled: false, hour: 9, minute: 0, account_ids: []};
  $('#automationEnabled').checked = config.enabled;
  $('#automationTime').value = `${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`;
  const selected = new Set(config.account_ids);
  const rows = [...state.accounts, ...config.account_ids.filter((id) => !state.accounts.some((a) => a.id === id)).map((id) => ({id, name: `已删除账号：${id}`}))];
  $('#automationAccounts').innerHTML = rows.map((a) => `<label class="check-option"><input type="checkbox" value="${escapeHtml(a.id)}" ${selected.has(a.id) ? 'checked' : ''}>${escapeHtml(a.name || a.id)}</label>`).join('') || '<p class="muted">请先导入账号。</p>';
}

async function queryQuota(id) {
  const epoch = state.sessionEpoch;
  const quota = await api(`/admin/accounts/${encodeURIComponent(id)}/quota`, {method: 'POST'});
  if (epoch !== state.sessionEpoch) return;
  await refresh({silent: true});
  if (epoch !== state.sessionEpoch) return;
  const account = state.accounts.find((a) => a.id === id);
  $('#quotaTitle').textContent = `${account?.name || id} · 官方额度`;
  const labels = {'1': '5 小时', '2': '近 7 天', '3': '奖励 / 额度包', '4': '每月'};
  $('#quotaContent').innerHTML = `<p class="muted">各窗口单独计算；这里是账号额度，不代表单次请求扣费。</p>` + (quota.windows.length ?
    `<div class="table-wrap"><table class="data-table"><thead><tr><th>窗口</th><th>已用</th><th>总额</th><th>剩余</th></tr></thead><tbody>${quota.windows.map((w) => `<tr><td>${escapeHtml(w.name)}<span class="cell-secondary">${escapeHtml(labels[w.window_type] || '官方窗口')}</span></td><td>${officialNumber(w.used)}</td><td>${w.unlimited ? '不限' : officialNumber(w.total)}</td><td>${w.unlimited ? '不限' : officialNumber(w.remaining)}</td></tr>`).join('')}</tbody></table></div>` : '<p>官方未提供可显示的额度窗口。</p>');
  $('#quotaDialog').showModal();
}

async function checkinAccounts(ids, showResult = true) {
  const epoch = state.sessionEpoch;
  if (state.automationRunningIds.size || state.benefits?.running?.length) throw new Error('已有签到任务正在执行，请稍候。');
  state.automationRunningIds = new Set(ids || state.accounts.filter((a) => a.available).map((a) => a.id));
  state.automationStartedAt = Date.now() / 1000;
  renderAutomation();
  const pollTimer = setInterval(() => {
    if (epoch === state.sessionEpoch) refresh({silent: true}).catch(() => {});
  }, 2500);
  state.automationPollTimer = pollTimer;
  try {
    const result = await api('/admin/checkin', {method: 'POST', ...(ids ? {body: JSON.stringify({ids})} : {})});
    if (epoch !== state.sessionEpoch) return [];
    clearInterval(pollTimer);
    // A poll started before the final result may still report the account busy.
    // Finish that refresh before requesting the completed snapshot.
    if (state.refreshPromise) await state.refreshPromise.catch(() => {});
    if (epoch !== state.sessionEpoch) return [];
    await refresh({silent: true});
    if (epoch !== state.sessionEpoch) return [];
    if (showResult) {
      $('#quotaTitle').textContent = '每日签到结果';
      $('#quotaContent').innerHTML = result.results.length ? result.results.map((row) => {
        const name = state.accounts.find((a) => a.id === row.id)?.name || row.id;
        return `<div class="benefit-result"><strong>${escapeHtml(name)}</strong><p>${escapeHtml(row.message || row.status)}</p></div>`;
      }).join('') : '<p>没有可执行的账号。</p>';
      $('#quotaDialog').showModal();
    }
    return result.results;
  } finally {
    clearInterval(pollTimer);
    if (state.automationPollTimer === pollTimer) state.automationPollTimer = null;
    if (epoch === state.sessionEpoch) {
      state.automationRunningIds.clear();
      renderAutomation();
    }
  }
}

function automationAccountRows(accounts, benefits, localIds = new Set(), startedAt = 0) {
  const today = benefits?.today || '';
  const running = new Set(benefits?.running || []);
  const config = benefits?.config || {account_ids: []};
  const selected = new Set(config.account_ids || []);
  return accounts.map((account) => {
    const record = benefits?.accounts?.[account.id]?.checkin || account.benefits?.checkin || {};
    const current = !!today && record.day === today;
    let status = 'unknown', label = '今日暂无记录', tone = 'disabled';
    if (current) {
      const statuses = {
        done: ['done','已确认签到','success'], claimed: ['done','领取已确认','success'],
        pending: ['pending','结果待确认','running'], error: ['attention','执行失败','error'],
        verification: ['attention','需人工验证','error'], inactive: ['inactive','当前无活动','disabled'],
        manual_required: ['attention','需官方签到','error'],
        ineligible: ['ineligible','未满足条件','running'],
      };
      [status, label, tone] = statuses[record.status] || [status, label, tone];
    }
    if (localIds.has(account.id) && status !== 'done' && !(Number(record.updated_at) >= startedAt)) {
      [status, label, tone] = ['queued','本轮待处理','running'];
    }
    if (running.has(account.id)) [status, label, tone] = ['running','执行中','running'];
    return {account, record, status, label, tone, queryOnly: current && record.query_only === true, planned: !selected.size || selected.has(account.id)};
  });
}

function automationScopeIds(accounts, selectedId, confirmedIds = new Set()) {
  if (selectedId && !accounts.some((a) => a.id === selectedId && a.available)) {
    throw new Error('所选账号已删除、停用或正在冷却，请重新选择。');
  }
  return accounts.filter((a) => a.available && (!selectedId || a.id === selectedId) && !confirmedIds.has(a.id)).map((a) => a.id);
}

function renderAutomation() {
  const config = state.benefits?.config || {enabled: false, hour: 9, minute: 0, account_ids: []};
  const rows = automationAccountRows(state.accounts, state.benefits, state.automationRunningIds, state.automationStartedAt);
  const busy = state.automationRunningIds.size > 0 || !!state.benefits?.running?.length;
  const done = rows.filter((row) => row.status === 'done').length;
  $('#automationEligibleCount').textContent = state.accounts.filter((a) => a.available).length;
  $('#automationDoneCount').textContent = done;
  $('#automationPendingCount').textContent = rows.filter((r) => r.account.available && ['unknown','pending','attention','ineligible'].includes(r.status)).length;
  $('#automationAttentionCount').textContent = rows.filter((r) => ['pending','attention'].includes(r.status)).length;
  const badge = $('#automationSchedulerBadge');
  badge.textContent = config.enabled ? '已开启' : '已关闭';
  badge.className = `status-badge ${config.enabled ? 'success' : 'disabled'}`;
  const time = `${String(config.hour).padStart(2,'0')}:${String(config.minute).padStart(2,'0')}`;
  const participants = rows.filter((r) => r.planned && r.account.available).length;
  $('#automationScheduleSummary').textContent = `每日 ${time} · 北京时间 · 当前 ${participants} 个账号可参与`;
  $('#automationUnsaved').hidden = !state.automationDirty;
  $('#automationTaskBadge').textContent = busy ? '任务执行中' : '手动执行';
  $('#automationExecutionState').textContent = busy ? '正在执行，记录自动更新' : '空闲';
  const last = Math.max(0, ...rows.map((r) => Number(r.record.updated_at) || 0));
  $('#automationLastRun').textContent = last ? new Date(last*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '尚未执行';
  const select = $('#automationRunAccount');
  const selectedId = select.value;
  const options = '<option value="">全部可用账号</option>' + state.accounts.map((a) => `<option value="${escapeHtml(a.id)}" ${a.available ? '' : 'disabled'}>${escapeHtml(a.name || a.id)}${a.available ? '' : '（当前不可用）'}</option>`).join('') +
    (selectedId && !state.accounts.some((a) => a.id === selectedId) ? `<option value="${escapeHtml(selectedId)}" disabled>所选账号已删除，请重新选择</option>` : '');
  if (select.innerHTML !== options) { select.innerHTML = options; select.value = selectedId; }
  select.disabled = busy;
  const usable = state.accounts.some((a) => a.available && (!selectedId || a.id === selectedId));
  $$('[data-action="run-daily-checkin"], [data-action="run-unconfirmed-checkin"]').forEach((button) => { button.disabled = busy || !usable; button.setAttribute('aria-busy', String(busy)); });
  const query = $('#automationSearch').value.trim().toLocaleLowerCase();
  const filter = $('#automationStatusFilter').value;
  const visible = rows.filter((r) => {
    if (query && ![r.account.name, r.account.id, r.label, r.record.message, r.record.code].join(' ').toLocaleLowerCase().includes(query)) return false;
    if (filter === 'unconfirmed') return r.status !== 'done';
    if (filter === 'attention') return ['attention','pending'].includes(r.status);
    if (filter === 'running') return ['running','queued'].includes(r.status);
    if (filter === 'unavailable') return !r.account.available;
    return !filter || r.status === filter;
  });
  $('#automationRecordCount').textContent = `${visible.length} / ${rows.length} 个账号`;
  $('#automationTableWrap').hidden = !visible.length;
  $('#automationEmpty').hidden = !!visible.length;
  $('#automationEmpty strong').textContent = rows.length ? '没有匹配的记录' : '暂无账号';
  $('#automationEmpty p').textContent = rows.length ? '调整搜索或状态筛选后重试。' : '导入账号后可查看签到状态。';
  $('#automationRows').innerHTML = visible.map((r) => {
    const a = r.account;
    const quota = (a.benefits?.quota?.windows || []).map((w) => `${w.name}：${w.unlimited ? '不限' : '剩 '+officialNumber(w.remaining)}`).join(' · ');
    const plan = !a.enabled ? '跳过：已停用' : !a.available ? '跳过：冷却中' : r.planned ? '参与计划' : '仅手动执行';
    const when = r.record.updated_at ? `${r.record.day || ''} ${formatTime(r.record.updated_at)}` : '—';
    return `<tr><td data-label="账号"><strong class="cell-primary">${escapeHtml(a.name || a.id)}</strong>${a.name ? `<code class="cell-secondary table-code" title="${escapeHtml(a.id)}">${escapeHtml(a.id)}</code>` : ''}</td><td data-label="计划">${escapeHtml(plan)}</td><td data-label="今日状态"><span class="status-badge ${r.tone}">${r.label}</span></td><td data-label="官方额度"><span class="cell-secondary">${escapeHtml(quota || '未同步')}</span></td><td data-label="最近执行" class="tabular">${escapeHtml(when)}</td><td data-label="结果说明">${escapeHtml(r.record.message || '尚无执行记录')}${r.record.code ? `<span class="cell-secondary">code: ${escapeHtml(r.record.code)}</span>` : ''}</td><td data-label="操作"><div class="account-actions"><button type="button" class="button secondary small" data-action="account-checkin" data-id="${escapeHtml(a.id)}" ${busy || !a.available ? 'disabled' : ''}>${r.queryOnly || r.status === 'pending' ? '回查' : '签到'}</button><button type="button" class="button ghost small" data-action="account-quota" data-id="${escapeHtml(a.id)}">额度</button></div></td></tr>`;
  }).join('');
}

async function runAutomation(onlyUnconfirmed) {
  const epoch = state.sessionEpoch;
  const rows = automationAccountRows(state.accounts, state.benefits);
  const confirmed = onlyUnconfirmed ? new Set(rows.filter((r) => r.status === 'done').map((r) => r.account.id)) : new Set();
  try {
    const ids = automationScopeIds(state.accounts, $('#automationRunAccount').value, confirmed);
    if (!ids.length) { feedback('#automationRunFeedback', '当前范围没有需要执行的可用账号。'); return; }
    feedback('#automationRunFeedback', `正在处理 ${ids.length} 个账号，执行记录会自动更新…`);
    const results = await checkinAccounts(ids, false);
    if (epoch !== state.sessionEpoch) return;
    const done = results.filter((row) => ['done','claimed'].includes(row.status)).length;
    feedback('#automationRunFeedback', `本轮已结束，共处理 ${results.length} 个账号；已确认 ${done} 个，其他结果见下表。`, results.some((row) => ['error','verification','manual_required'].includes(row.status)));
  } catch (error) {
    if (epoch === state.sessionEpoch) feedback('#automationRunFeedback', error.message, true);
    throw error;
  }
}

async function closeQR(closeDialog = true) {
  state.qrGeneration += 1;
  clearTimeout(state.qrTimer);
  const previous = state.qrSession;
  state.qrSession = null;
  state.qrImage = "";
  $('#qrImage').hidden = true;
  $('#qrImage').removeAttribute('src');
  $('#qrStage').setAttribute('aria-busy', 'false');
  if (closeDialog && $('#qrDialog').open) $('#qrDialog').close();
  if (previous) await api(`/admin/accounts/qr/${encodeURIComponent(previous.id)}`, {method: 'DELETE'}).catch(() => {});
}

async function startQR() {
  await closeQR(false);
  const generation = state.qrGeneration;
  const epoch = state.sessionEpoch;
  if (!$('#qrDialog').open) $('#qrDialog').showModal();
  $('#qrStatus').textContent = '正在获取官方二维码…';
  $('#qrStage').setAttribute('aria-busy', 'true');
  try {
    const session = await api('/admin/accounts/qr', {method: 'POST'});
    if (generation !== state.qrGeneration || epoch !== state.sessionEpoch) {
      if (epoch === state.sessionEpoch) await api(`/admin/accounts/qr/${encodeURIComponent(session.id)}`, {method: 'DELETE'}).catch(() => {});
      return;
    }
    state.qrSession = session;
    state.qrImage = session.image;
    $('#qrImage').src = session.image;
    $('#qrImage').hidden = false;
    $('#qrStatus').textContent = '请扫码并在手机上确认。二维码约 60 秒自动刷新。';
    state.qrTimer = setTimeout(() => pollQR(generation, epoch), 2400);
  } catch (error) {
    if (generation === state.qrGeneration && epoch === state.sessionEpoch) $('#qrStatus').textContent = error.message;
  } finally {
    if (generation === state.qrGeneration) $('#qrStage').setAttribute('aria-busy', 'false');
  }
}

async function pollQR(generation, epoch) {
  if (generation !== state.qrGeneration || epoch !== state.sessionEpoch || !state.qrSession) return;
  try {
    const result = await api(`/admin/accounts/qr/${encodeURIComponent(state.qrSession.id)}/poll`, {method: 'POST'});
    if (generation !== state.qrGeneration || epoch !== state.sessionEpoch) return;
    if (result.status === 'confirmed') {
      await closeQR();
      await refresh({silent: true});
      showToast('账号已保存到本地');
      return;
    }
    if (result.image && result.image !== state.qrImage) {
      // 官方二维码约 60 秒失效，后端会自动换新码，这里同步刷新图片
      state.qrImage = result.image;
      $('#qrImage').src = result.image;
      $('#qrImage').hidden = false;
    }
    $('#qrStatus').textContent = {waiting: '等待扫码…', scanned: '已扫码，请在手机上确认。', expired: '二维码已过期，请刷新。', canceled: '登录已取消，请刷新。'}[result.status] || '等待登录确认…';
    if (['expired', 'canceled'].includes(result.status)) return;
    state.qrTimer = setTimeout(() => pollQR(generation, epoch), 2400);
  } catch (error) {
    if (generation === state.qrGeneration && epoch === state.sessionEpoch) $('#qrStatus').textContent = error.message;
  }
}

$('#qrDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeQR(); });
$('#automationForm').addEventListener('input', () => { state.automationDirty = true; renderAutomation(); });
$('#automationRunAccount').addEventListener('change', renderAutomation);
$('#automationSearch').addEventListener('input', renderAutomation);
$('#automationStatusFilter').addEventListener('change', renderAutomation);
window.addEventListener('popstate', () => switchTab(new URLSearchParams(location.search).get('tab') || 'overview', false));
bindForm('#automationForm', '#automationFeedback', async () => {
  const [hour, minute] = $('#automationTime').value.split(':').map(Number);
  const account_ids = $$('#automationAccounts input:checked').map((input) => input.value);
  const result = await api('/admin/automation/config', {method: 'PUT', body: JSON.stringify({enabled: $('#automationEnabled').checked, hour, minute, account_ids})});
  state.benefits = {...state.benefits, config: result};
  state.automationDirty = false;
  renderReferenceFeatures();
  feedback('#automationFeedback', '签到设置已保存。');
});
function openModelTest(model) {
  $('#testModelId').value = model;
  $('#testModelAccount').innerHTML = '<option value="">自动选择可用账号</option>' + state.accounts.filter(a=>a.enabled).map(a=>`<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}${a.failure_type ? ' · '+escapeHtml(a.failure_type) : ''}</option>`).join('');
  feedback('#modelTestFeedback');
  $('#modelTestDialog').showModal();
}

function renderHistoryUsage() {
  const dimension = $('#historyDimension').value || 'model';
  const rows = state.historicalUsage?.['by_'+dimension] || [];
  $('#historyUsageSummary').textContent = `最近 ${state.historicalUsage?.days || state.historyDays} 天 · ${rows.reduce((sum,r)=>sum+r.requests,0)} 次`;
  $('#historyUsageRows').innerHTML = rows.map(row=>{
    const label = dimension==='account' ? state.accounts.find(a=>a.id===row.id)?.name || row.id : dimension==='key' ? state.keys.find(k=>k.id===row.id)?.name || row.id : row.id;
    return `<tr><td data-label="统计对象"><code>${escapeHtml(label || '未标识')}</code></td><td data-label="请求">${row.requests}</td><td data-label="成功">${row.success}</td><td data-label="失败">${row.errors}</td><td data-label="输入 Token">${Number(row.input_tokens).toLocaleString()}</td><td data-label="输出 Token">${Number(row.output_tokens).toLocaleString()}</td><td data-label="平均耗时">${row.average_ms == null ? '—' : formatDuration(row.average_ms)}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="table-empty">此时间范围暂无记录</td></tr>';
}

async function loadHistoryLogs(offset=0) {
  const query = new URLSearchParams({limit:'200',offset:String(offset)});
  for (const [field,id] of [['model','historyLogModel'],['account_id','historyLogAccount'],['key_id','historyLogKey']]) {
    if ($('#'+id).value.trim()) query.set(field,$('#'+id).value.trim());
  }
  if ($('#historyLogSince').value) query.set('since',String(new Date($('#historyLogSince').value+'T00:00:00+08:00').getTime()/1000));
  const result = await api('/admin/logs?'+query);
  if (!result.data.length && offset) { showToast('没有更早的匹配记录'); return; }
  state.historyLogs=result.data;
  state.historyOffset=offset;
  state.logPage=0;
  renderLogs();
  feedback('#historyLogFeedback',`已加载历史第 ${offset+1}～${offset+result.data.length} 条`);
}

async function startBrowserLogin() {
  if (state.browserSession) throw new Error('已有浏览器登录正在进行');
  const result = await api('/admin/accounts/browser',{method:'POST'});
  state.browserSession=result.id;
  feedback('#browserFeedback',result.message);
  $('#browserDialog').showModal();
}

async function finishBrowserLogin() {
  if (!state.browserSession) return;
  try {
    await api('/admin/accounts/browser/'+encodeURIComponent(state.browserSession)+'/finish',{method:'POST'});
    state.browserSession=null;
    $('#browserDialog').close();
    await refresh({silent:true});
    showToast('官方身份已核验，账号已加密导入，临时浏览器已关闭');
  } catch (error) { feedback('#browserFeedback',error.message,true); }
}

async function cancelBrowserLogin() {
  if (state.browserSession) await api('/admin/accounts/browser/'+encodeURIComponent(state.browserSession),{method:'DELETE'});
  state.browserSession=null;
  $('#browserDialog').close();
}

$('#browserDialog').addEventListener('cancel',event=>{event.preventDefault();cancelBrowserLogin().catch(error=>feedback('#browserFeedback',error.message,true));});
$('#routingForm').addEventListener('input',()=>{state.routingDirty=true;});
bindForm('#routingForm','#routingFeedback',async()=>{
  const payload={native_sessions:$('#nativeSessions').checked,large_request_bytes:Number($('#largeRequestBytes').value),large_request_budget:Number($('#largeRequestBudget').value),large_request_window:Number($('#largeRequestWindow').value)};
  state.routing=await api('/admin/routing',{method:'PUT',body:JSON.stringify(payload)});
  state.routingDirty=false;
  feedback('#routingFeedback','转发策略已保存');
});
bindForm('#modelTestForm','#modelTestFeedback',async()=>{
  const result=await api('/admin/models/test',{method:'POST',body:JSON.stringify({model:$('#testModelId').value,account_id:$('#testModelAccount').value || null})});
  feedback('#modelTestFeedback',`测试通过 · ${formatDuration(result.duration_ms)} · 账号 ${result.account_id}`);
  await refresh({silent:true});
});
bindForm('#historyLogForm','#historyLogFeedback',()=>loadHistoryLogs(0));
$('#historyDimension').addEventListener('change',renderHistoryUsage);
bindForm('#historyUsageForm','#historyUsageFeedback',async()=>{
  state.historyDays=Number($('#historyDays').value);
  state.historicalUsage=await api('/admin/analytics?days='+state.historyDays);
  renderHistoryUsage();
  feedback('#historyUsageFeedback','历史统计已更新');
});
boot();
