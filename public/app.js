const categoryLabels = {
  normal_application: "Normal application",
  cold_email: "Cold email",
  unsolicited: "Unsolicited",
  phd: "PhD",
};

const statusLabels = {
  draft: "Draft",
  submitted: "Submitted",
  awaiting_response: "Awaiting response",
  replied: "Replied",
  screening: "Screening",
  assessment: "Assessment",
  interview: "Interview",
  offer: "Offer",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  closed: "Closed",
};

const fieldLabels = {
  category: "category",
  status: "status",
  company: "company",
  jobTitle: "role",
  recruiterName: "contact name",
  recruiterEmail: "contact email",
  location: "location",
  applicationDate: "application date",
  summary: "summary",
  notes: "notes",
};

const elements = Object.fromEntries([
  "health-dot", "account-label", "sync-label", "connect-link", "initial-controls", "initial-limit", "import-button", "sync-button", "analyze-button", "settings-button", "add-button",
  "empty-add-button", "refresh-button", "result-count", "opportunity-rows",
  "empty-state", "category-filter", "status-filter", "search-input", "editor-dialog", "opportunity-form", "editor-title",
  "editor-kicker", "editor-close", "editor-cancel", "delete-from-editor", "save-button", "detail-dialog", "detail-close",
  "detail-edit", "detail-avatar", "detail-category", "detail-company", "detail-role", "detail-content", "confirm-dialog",
  "delete-cancel", "delete-confirm", "toast-region", "settings-dialog", "settings-form", "settings-close", "settings-cancel",
  "settings-save", "settings-connect-link", "gmail-client-status", "openai-key-status", "oauth-redirect-uri",
].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]));

let appState = null;
let records = [];
let editingRecord = null;
let detailRecord = null;
let pendingDeleteId = null;
let searchTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value, includeTime = false) {
  if (!value) return "Not known";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.valueOf())) return "Not known";
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

function initials(value) {
  return (value || "Opportunity").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("");
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-Opportunity-Desk"] = "1";
  }
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  item.textContent = message;
  elements.toast_region.append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function setBusy(button, busy, busyLabel, normalLabel) {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : normalLabel;
}

function renderState(state) {
  appState = state;
  elements.health_dot.classList.toggle("healthy", state.connected);
  elements.account_label.textContent = state.connected ? (state.emailAddress || "Connected") : "Not connected";
  elements.sync_label.textContent = state.lastSyncAt
    ? `Last synced ${formatDate(state.lastSyncAt, true)} · ${state.storedMessageCount} messages`
    : "Connect Gmail to begin syncing conversations.";
  elements.connect_link.textContent = state.connected ? "Reconnect account" : "Connect account";
  elements.settings_connect_link.textContent = state.connected ? "Reconnect Gmail" : "Connect Gmail";
  elements.initial_controls.hidden = state.initialSyncComplete;
  elements.import_button.disabled = !state.connected;
  elements.sync_button.hidden = !state.initialSyncComplete;
  elements.sync_button.disabled = !state.connected || !state.initialSyncComplete;
  elements.analyze_button.disabled = !state.extractionConfigured || state.pendingThreadCount === 0;
  elements.analyze_button.textContent = state.pendingThreadCount > 0
    ? `Analyze all (${state.pendingThreadCount})`
    : "Analysis up to date";

}

function renderStats(stats) {
  const values = {
    total: stats.total,
    active: stats.active,
    waiting: stats.waiting,
    interviews: stats.interviews,
    offers: stats.offers,
    rejections: stats.rejections,
    response: `${stats.responseRate}%`,
  };
  Object.entries(values).forEach(([key, value]) => {
    document.querySelector(`#metric-${key}`).textContent = value;
  });
}

function renderRecords(items) {
  records = items;
  elements.result_count.textContent = `${items.length} ${items.length === 1 ? "opportunity" : "opportunities"} in this view`;
  elements.empty_state.hidden = items.length > 0;
  elements.opportunity_rows.innerHTML = items.map((record) => `
    <tr data-record-id="${record.id}" tabindex="0">
      <td data-label="Opportunity"><div class="opportunity-cell"><span class="company-avatar">${escapeHtml(initials(record.company))}</span><div class="opportunity-copy"><strong>${escapeHtml(record.company || "Company not set")}</strong><span>${escapeHtml(record.jobTitle || record.summary || "Role not set")}</span></div></div></td>
      <td data-label="Category"><span class="tag tag-${escapeHtml(record.category)}">${escapeHtml(categoryLabels[record.category])}</span></td>
      <td data-label="Status"><span class="status-pill status-${escapeHtml(record.status)}">${escapeHtml(statusLabels[record.status])}</span></td>
      <td data-label="Contact"><div class="contact">${record.recruiterName || record.recruiterEmail ? `<strong>${escapeHtml(record.recruiterName || "Contact")}</strong><span>${escapeHtml(record.recruiterEmail || "Email not set")}</span>` : '<span class="muted">Not identified</span>'}</div></td>
      <td data-label="Activity">${escapeHtml(formatDate(record.lastActivityAt))}</td>
      <td><button class="row-action" type="button" data-open-id="${record.id}" aria-label="Open opportunity">→</button></td>
    </tr>
  `).join("");
}

async function loadRecords() {
  const params = new URLSearchParams();
  if (elements.category_filter.value) params.set("category", elements.category_filter.value);
  if (elements.status_filter.value) params.set("status", elements.status_filter.value);
  if (elements.search_input.value.trim()) params.set("q", elements.search_input.value.trim());
  renderRecords(await api(`/api/opportunities?${params}`));
}

async function refresh() {
  const [state, stats] = await Promise.all([api("/api/state"), api("/api/stats")]);
  renderState(state);
  renderStats(stats);
  await loadRecords();
}

async function runSync(button, endpoint, busyLabel, normalLabel, body = {}) {
  setBusy(button, true, busyLabel, normalLabel);
  try {
    const result = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    toast(`Sync complete · ${result.newMessagesStored} new messages · ${result.opportunitiesUpdated} opportunities updated`);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false, busyLabel, normalLabel);
    renderState(appState);
  }
}

function importHistory() {
  const analysisLimit = Number(elements.initial_limit.value);
  return runSync(elements.import_button, "/api/sync/initial", "Initializing…", "Initial Analyze", { analysisLimit });
}

function syncNewMail() {
  return runSync(elements.sync_button, "/api/sync/incremental", "Syncing…", "Sync Email");
}

async function openSettings() {
  const settings = await api("/api/settings");
  elements.settings_form.reset();
  elements.settings_form.elements.namedItem("gmailClientId").value = settings.gmailClientId || "";
  elements.gmail_client_status.textContent = settings.gmailConfigured ? "Gmail OAuth credentials configured" : "Gmail OAuth credentials required";
  elements.openai_key_status.textContent = settings.openaiConfigured ? `OpenAI configured · ${settings.openaiModel}` : "OpenAI API key required";
  elements.oauth_redirect_uri.textContent = settings.oauthRedirectUri;
  elements.settings_dialog.showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const form = elements.settings_form;
  const payload = Object.fromEntries(["gmailClientId", "gmailClientSecret", "openaiApiKey"]
    .map((name) => [name, form.elements.namedItem(name).value.trim()])
    .filter(([, value]) => value));
  if (Object.keys(payload).length === 0) {
    elements.settings_dialog.close();
    return;
  }
  setBusy(elements.settings_save, true, "Saving…", "Save settings");
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    toast("Settings saved securely");
    elements.settings_dialog.close();
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(elements.settings_save, false, "Saving…", "Save settings");
  }
}

async function analyzePending() {
  const startingCount = appState?.pendingThreadCount || 0;
  setBusy(elements.analyze_button, true, `Analyzing 0/${startingCount}…`, `Analyze all (${startingCount})`);
  try {
    let processed = 0;
    let opportunities = 0;
    let ignored = 0;
    let failures = 0;
    while (appState?.pendingThreadCount > 0) {
      const pendingBeforeBatch = appState.pendingThreadCount;
      const batchSize = Math.min(20, appState.pendingThreadCount);
      const result = await api("/api/analyze", { method: "POST", body: JSON.stringify({ limit: batchSize, force: false }) });
      processed += result.analyzedThreads + result.failures;
      opportunities += result.opportunitiesUpdated;
      ignored += result.notOpportunities;
      failures += result.failures;
      const nextState = await api("/api/state");
      renderState(nextState);
      elements.analyze_button.disabled = true;
      elements.analyze_button.textContent = `Analyzing ${Math.min(processed, startingCount)}/${startingCount}…`;
      if (nextState.pendingThreadCount >= pendingBeforeBatch) break;
      if (result.requestedThreads === 0 || (result.analyzedThreads === 0 && result.failures === 0 && result.skippedUnchanged === 0)) break;
    }
    toast(`Analysis complete · ${opportunities} opportunities · ${ignored} other conversations${failures ? ` · ${failures} failed` : ""}`, failures > 0);
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    elements.analyze_button.disabled = !appState?.extractionConfigured || appState?.pendingThreadCount === 0;
    elements.analyze_button.textContent = appState?.pendingThreadCount > 0
      ? `Analyze all (${appState.pendingThreadCount})`
      : "Analysis up to date";
  }
}

function formValue(form, name) {
  return form.elements.namedItem(name).value.trim();
}

function recordFormData() {
  const form = elements.opportunity_form;
  return {
    company: formValue(form, "company") || null,
    jobTitle: formValue(form, "jobTitle") || null,
    category: formValue(form, "category"),
    status: formValue(form, "status"),
    recruiterName: formValue(form, "recruiterName") || null,
    recruiterEmail: formValue(form, "recruiterEmail") || null,
    location: formValue(form, "location") || null,
    applicationDate: formValue(form, "applicationDate") || null,
    summary: formValue(form, "summary"),
    notes: formValue(form, "notes"),
  };
}

function comparable(value) { return value ?? ""; }

function openEditor(record = null) {
  editingRecord = record;
  elements.opportunity_form.reset();
  elements.editor_kicker.textContent = record ? "EDIT RECORD" : "NEW RECORD";
  elements.editor_title.textContent = record ? "Edit opportunity" : "Add opportunity";
  elements.save_button.textContent = record ? "Save changes" : "Add opportunity";
  elements.delete_from_editor.hidden = !record;
  if (record) {
    const form = elements.opportunity_form;
    Object.entries({
      company: record.company,
      jobTitle: record.jobTitle,
      category: record.category,
      status: record.status,
      recruiterName: record.recruiterName,
      recruiterEmail: record.recruiterEmail,
      location: record.location,
      applicationDate: record.applicationDate,
      summary: record.summary,
      notes: record.notes,
    }).forEach(([name, value]) => { form.elements.namedItem(name).value = value ?? ""; });
  } else {
    elements.opportunity_form.elements.namedItem("status").value = "submitted";
  }
  elements.editor_dialog.showModal();
}

async function saveOpportunity(event) {
  event.preventDefault();
  const current = recordFormData();
  let payload = current;
  let url = "/api/opportunities";
  let method = "POST";
  if (editingRecord) {
    payload = Object.fromEntries(Object.entries(current).filter(([key, value]) => comparable(value) !== comparable(editingRecord[key])));
    if (Object.keys(payload).length === 0) {
      elements.editor_dialog.close();
      return;
    }
    url = `/api/opportunities/${editingRecord.id}`;
    method = "PATCH";
  }
  setBusy(elements.save_button, true, "Saving…", editingRecord ? "Save changes" : "Add opportunity");
  try {
    const saved = await api(url, { method, body: JSON.stringify(payload) });
    toast(editingRecord ? "Opportunity updated" : "Opportunity added");
    elements.editor_dialog.close();
    editingRecord = null;
    await refresh();
    if (detailRecord?.opportunity?.id === saved.id) await openDetail(saved.id);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(elements.save_button, false, "Saving…", editingRecord ? "Save changes" : "Add opportunity");
  }
}

function detailMeta(label, value) {
  return `<div class="meta-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "Not known")}</strong></div>`;
}

function eventIcon(type) {
  return ({ email_received: "↓", email_sent: "↑", status_changed: "●", created: "+", edited: "✎", extracted: "◇", merged: "↔" })[type] || "·";
}

async function openDetail(id) {
  elements.detail_dialog.showModal();
  elements.detail_content.innerHTML = '<div class="detail-body"><p class="muted">Loading opportunity…</p></div>';
  try {
    const detail = await api(`/api/opportunities/${id}`);
    detailRecord = detail;
    const record = detail.opportunity;
    elements.detail_avatar.textContent = initials(record.company);
    elements.detail_category.textContent = categoryLabels[record.category].toUpperCase();
    elements.detail_company.textContent = record.company || "Company not set";
    elements.detail_role.textContent = record.jobTitle || "Role not set";
    const evidence = detail.evidence.length
      ? `<ul class="evidence-list">${detail.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : '<p class="muted">No extraction evidence is available.</p>';
    const overrides = record.manualOverrideFields.length
      ? `<div class="override-note">Manual overrides protect: ${escapeHtml(record.manualOverrideFields.map((field) => fieldLabels[field] || field).join(", "))}. Future analysis will preserve these values.</div>`
      : "";
    const timeline = detail.timeline.map((event) => `
      <article class="timeline-item ${escapeHtml(event.type)}">
        <span class="timeline-dot">${escapeHtml(eventIcon(event.type))}</span>
        <div class="timeline-card"><div class="timeline-top"><strong>${escapeHtml(event.title)}</strong><time>${escapeHtml(formatDate(event.occurredAt, true))}</time></div>${event.description ? `<p>${escapeHtml(event.description)}</p>` : ""}</div>
      </article>
    `).join("");
    elements.detail_content.innerHTML = `
      <div class="detail-body">
        <section class="summary-card"><div class="summary-top"><strong>AI summary</strong><span class="source-pill">${escapeHtml(record.extractionModel || (record.source === "manual" ? "Manual record" : "Pending analysis"))}</span></div><p>${escapeHtml(record.summary || "No summary yet.")}</p></section>
        <div class="detail-metadata">
          ${detailMeta("Status", statusLabels[record.status])}
          ${detailMeta("Contact", record.recruiterName)}
          ${detailMeta("Contact email", record.recruiterEmail)}
          ${detailMeta("Application date", formatDate(record.applicationDate))}
          ${detailMeta("Location", record.location)}
          ${detailMeta("Messages", String(record.messageCount))}
          ${detailMeta("Threads merged", String(record.threadCount))}
          ${detailMeta("Confidence", record.confidence == null ? "Not available" : `${Math.round(record.confidence * 100)}%`)}
        </div>
        <section class="detail-section"><div class="detail-section-title"><h3>Extraction evidence</h3><span>${detail.evidence.length} signals</span></div>${evidence}${overrides}</section>
        ${record.notes ? `<section class="detail-section"><div class="detail-section-title"><h3>Notes</h3></div><p class="muted">${escapeHtml(record.notes)}</p></section>` : ""}
        <section class="detail-section"><div class="detail-section-title"><h3>Timeline</h3><span>${detail.timeline.length} events</span></div><div class="timeline">${timeline || '<p class="muted">No timeline events yet.</p>'}</div></section>
      </div>`;
  } catch (error) {
    elements.detail_content.innerHTML = `<div class="detail-body"><p class="muted">${escapeHtml(error.message)}</p></div>`;
  }
}

function requestDelete(id) {
  pendingDeleteId = id;
  elements.confirm_dialog.showModal();
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  elements.delete_confirm.disabled = true;
  try {
    await api(`/api/opportunities/${pendingDeleteId}`, { method: "DELETE" });
    toast("Opportunity deleted");
    elements.confirm_dialog.close();
    elements.editor_dialog.close();
    elements.detail_dialog.close();
    pendingDeleteId = null;
    editingRecord = null;
    detailRecord = null;
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    elements.delete_confirm.disabled = false;
  }
}

elements.add_button.addEventListener("click", () => openEditor());
elements.empty_add_button.addEventListener("click", () => openEditor());
elements.import_button.addEventListener("click", importHistory);
elements.sync_button.addEventListener("click", syncNewMail);
elements.analyze_button.addEventListener("click", analyzePending);
elements.settings_button.addEventListener("click", () => openSettings().catch((error) => toast(error.message, true)));
elements.settings_form.addEventListener("submit", saveSettings);
elements.settings_close.addEventListener("click", () => elements.settings_dialog.close());
elements.settings_cancel.addEventListener("click", () => elements.settings_dialog.close());
elements.refresh_button.addEventListener("click", () => refresh().catch((error) => toast(error.message, true)));
elements.category_filter.addEventListener("change", loadRecords);
elements.status_filter.addEventListener("change", loadRecords);
elements.search_input.addEventListener("input", () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(loadRecords, 220); });
elements.opportunity_rows.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-open-id]");
  const row = event.target.closest("[data-record-id]");
  const id = Number(trigger?.dataset.openId || row?.dataset.recordId);
  if (id) openDetail(id);
});
elements.opportunity_rows.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-record-id]")) openDetail(Number(event.target.dataset.recordId));
});
elements.opportunity_form.addEventListener("submit", saveOpportunity);
elements.editor_close.addEventListener("click", () => elements.editor_dialog.close());
elements.editor_cancel.addEventListener("click", () => elements.editor_dialog.close());
elements.detail_close.addEventListener("click", () => elements.detail_dialog.close());
elements.detail_edit.addEventListener("click", () => { if (detailRecord) { elements.detail_dialog.close(); openEditor(detailRecord.opportunity); } });
elements.delete_from_editor.addEventListener("click", () => { if (editingRecord) requestDelete(editingRecord.id); });
elements.delete_cancel.addEventListener("click", () => elements.confirm_dialog.close());
elements.delete_confirm.addEventListener("click", confirmDelete);

refresh().catch((error) => toast(`Opportunity Desk could not load: ${error.message}`, true));
