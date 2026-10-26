/* NightShift front end — plain JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (x) => (x == null ? "—" : x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(4)}` : x < 1 ? `$${x.toFixed(3)}` : `$${x.toFixed(2)}`);
const num = (x) => Math.round(x || 0).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dur = (s) => (s == null ? "—" : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`);
const when = (s) => (s ? new Date(s).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");
const clock = (s) => (s ? new Date(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const CAT = { service_request: "Service request", emergency: "Emergency", message: "Message", out_of_area: "Out of area", spam: "Spam / attack", forwarded: "Forwarded", other: "Other" };
const TRADE = { hvac: "HVAC", electrical: "Electrical", solar: "Solar", other: "Other" };
const prio = (p) => (p ? `<span class="pill ${esc(p)}">${esc(p[0].toUpperCase() + p.slice(1))}</span>` : "");

const S = { boot: null, settings: null, tree: null, call: null, voices: [], auto: false, busy: false, speaking: false, listening: false, rec: null, timer: null, t0: 0, visited: new Set(), selectedNode: null, lastFiller: 0, calls: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || (data.errors || []).join("\n") || res.statusText), { data });
  return data;
}
function toast(msg, err = false) {
  const t = Object.assign(document.createElement("div"), { className: "toast" + (err ? " err" : ""), textContent: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 2600);
}

/* ---------------- navigation ---------------- */
const LOADERS = {};
function show(page) {
  $$(".nav").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + page));
  (LOADERS[page] || (() => {}))();
  $(".main").scrollTop = 0;
}
$$(".nav").forEach((b) => b.addEventListener("click", () => show(b.dataset.page)));
document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto],[data-page-btn]"); if (g) show(g.dataset.goto || g.dataset.pageBtn); });

/* ---------------- boot ---------------- */
async function boot() {
  S.boot = await api("/api/bootstrap");
  S.settings = S.boot.settings;
  S.tree = S.boot.tree;
  $("#company-name").textContent = S.boot.business.company_name;
  const k = S.boot.keys;
  $("#foot-model").innerHTML = `${esc(S.boot.model)} · ${k.portkey || k.openai ? "key found" : '<span style="color:var(--red)">no API key</span>'}`;
  $("#agent-title").textContent = S.settings.agent_name;
  for (const sc of S.boot.scenarios) $("#scenario").insertAdjacentHTML("beforeend", `<option value="${sc.id}">${esc(sc.title)}</option>`);
  const d = new Date(); d.setHours(21, 40, 0, 0);
  $("#sim-time").value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  renderNotes({}); renderSteps(null);
  loadVoices();
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = loadVoices;
  if (!SR) $("#mic-hint").textContent = "Mic works in Chrome, Edge or Safari — typing works everywhere.";
  footAgent();
  LOADERS.overview();
  setInterval(pollLive, 2500); pollLive();
}
function footAgent() {
  const on = S.settings.agent_enabled !== false;
  $("#foot-agent").innerHTML = `<span class="dot ${on ? "on" : "off"}"></span>${on ? `${esc(S.settings.agent_name)} is on` : "Agent is off"}`;
}
async function counts() {
  const [calls, msgs] = await Promise.all([api("/api/calls"), api("/api/messages")]);
  S.calls = calls;
  $("#n-calls").textContent = calls.length || "";
  S.msgs = msgs;
}

/* ---------------- charts: single series, one hue, hover tooltip ---------------- */
function columnChart(el, data, { label, value, tip }) {
  const max = Math.max(1, ...data.map(value));
  const step = Math.ceil(data.length / 12);
  el.innerHTML = `<div class="bars">${data.map((d, i) => `<div class="bar ${value(d) ? "" : "zero"}" data-i="${i}"><i style="height:${(100 * value(d)) / max}%"></i></div>`).join("")}</div>
    <div class="axis">${data.map((d, i) => `<span>${i % step === 0 ? esc(label(d)) : ""}</span>`).join("")}</div>`;
  const tipEl = document.createElement("div");
  tipEl.className = "tip hidden";
  el.appendChild(tipEl);
  $$(".bar", el).forEach((b) => {
    b.onmouseenter = () => { const d = data[+b.dataset.i]; tipEl.textContent = tip(d); tipEl.classList.remove("hidden"); tipEl.style.left = b.offsetLeft + b.offsetWidth / 2 + "px"; tipEl.style.top = b.offsetTop + b.offsetHeight - b.firstChild.offsetHeight + "px"; };
    b.onmouseleave = () => tipEl.classList.add("hidden");
  });
}
function hbars(el, obj, labels = {}) {
  const entries = Array.isArray(obj) ? obj : Object.entries(obj);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  el.innerHTML = entries.length ? entries.map(([k, v]) => `<div class="hbar" title="${esc(labels[k] || k)}: ${v}"><span>${esc(labels[k] || k)}</span><div class="track"><div class="fill" style="width:${(100 * v) / max}%"></div></div><span class="n">${v}</span></div>`).join("") : '<div class="empty">No data yet.</div>';
}

/* ---------------- overview ---------------- */
LOADERS.overview = async (win) => {
  const o = await api("/api/overview" + (win || S.ovWindow ? `?window=${win || S.ovWindow}` : ""));
  S.ovWindow = o.window;
  $$("#ov-window button").forEach((b) => { b.classList.toggle("on", b.dataset.w === o.window); b.disabled = !o.available[b.dataset.w]; });
  $("#ov-chart-title").textContent = o.window === "7d" ? "Calls by day" : "Calls by hour";
  $("#ov-chart-sub").textContent = o.window === "7d" ? "last 7 days" : o.window === "current" ? `since ${new Date(o.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "from close to open";
  counts();
  const h = new Date().getHours();
  $("#greet").textContent = `Good ${h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"}, ${S.boot.business.manager.name.split(" ")[0]}`;
  const m = o.metrics;
  const fmt = (t) => new Date(t).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" });
  $("#ov-since").textContent = `${o.window === "current" ? "Current · " : ""}${fmt(o.since)} – ${o.window === "last_night" ? fmt(o.until) : "now"}`;
  const stat = (label, value, note = "", cls = "") => `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="note">${note}</div></div>`;
  $("#ov-stats").innerHTML = [
    stat("Calls", m.calls, `${m.answered_by_ai} answered by ${esc(o.agent.name)} · ${m.forwarded} forwarded`),
    stat("Visits offered & accepted", m.windows_held, m.booking_rate != null ? `${Math.round(m.booking_rate * 100)}% of ${m.service_requests} service requests` : "no service requests yet"),
    stat("Emergencies", m.emergencies, `${m.transferred} transferred to on-call`, m.emergencies ? "red" : ""),
    stat("Needs follow-up", m.needs_attention, `${m.messages} messages · ${m.out_of_area} out of area`),
    stat("Avg reply time", m.avg_reply_s != null ? `${m.avg_reply_s}s` : "—", m.avg_call_s != null ? `avg call ${dur(m.avg_call_s)}` : ""),
    stat("AI cost", money(m.cost_usd), `${money(m.cost_per_call)} per call · ${m.attacks_blocked} attacks blocked`),
  ].join("");
  const a = o.agent, on = a.enabled !== false;
  const mode = { after_hours: `After hours (${a.business_hours.end}–${a.business_hours.start})`, always: "Every call", forward_all: "Forwarding all calls" }[a.answering_mode];
  $("#ov-agent").innerHTML = `
    <div class="ac-top"><div class="avatar">☾</div><div style="flex:1"><div class="state">${on ? `${esc(a.name)} is answering` : `${esc(a.name)} is off`}</div><div class="state-sub">${on ? "After-hours calls go to the AI agent" : `Calls forward to ${esc(a.forward_number)}`}</div></div>
      <label class="switch"><input type="checkbox" id="agent-toggle" ${on ? "checked" : ""}><span></span></label></div>
    <div class="facts"><span>Answers</span><b>${esc(on ? mode : "No calls")}</b><span>Office line</span><b class="office-line"><input id="office-line" value="${esc(a.forward_number)}" title="Calls are forwarded here when Lucy is off or during office hours" aria-label="Office line"><button class="btn plain small hidden" id="office-save">Save</button></b><span>AI spend today</span><b>${money(o.spend_today)} · max ${money(+S.settings.per_call_budget_usd)} per call</b></div>
    <div class="alert-box"><label style="margin-top:0">Manager text alerts</label>
      <select id="alert-select">
        <option value="off">No — don't text me</option>
        <optgroup label="Yes — text me when the call is…">
          <option value="priority:emergency">Yes · Emergencies only</option>
          <option value="priority:high">Yes · High priority and up</option>
          <option value="priority:normal">Yes · Every job request (normal and up)</option>
          <option value="all">Yes · Every call</option>
        </optgroup>
      </select>
      <div class="help" id="alert-help"></div></div>`;
  const cur = S.settings.notify_manager === "all" ? "all" : S.settings.notify_manager === "off" ? "off" : `priority:${S.settings.notify_manager === "emergencies" ? "high" : S.settings.notify_min_priority || "high"}`;
  $("#alert-select").value = cur;
  const help = { off: "No texts. Calls are still logged and in the morning report.", "priority:emergency": "Texts only when a caller has a gas leak, CO alarm, sparks or similar danger.", "priority:high": "Emergencies plus urgent jobs, such as no heat with an elderly person at home.", "priority:normal": "Every call that needs a technician; skips messages, spam and out-of-area calls.", all: "A text after every call, including messages and spam." };
  $("#alert-help").textContent = help[cur];
  $("#alert-select").onchange = async (e) => {
    const v = e.target.value;
    const body = v === "off" || v === "all" ? { notify_manager: v } : { notify_manager: "priority", notify_min_priority: v.split(":")[1] };
    S.settings = await api("/api/settings", { method: "POST", body });
    $("#alert-help").textContent = help[v];
    toast(v === "off" ? "Manager text alerts off" : "Manager text alerts updated");
  };
  const ol = $("#office-line"), olSave = $("#office-save");
  ol.oninput = () => olSave.classList.toggle("hidden", ol.value.trim() === a.forward_number);
  const saveLine = async () => {
    const v = ol.value.trim(), digits = v.replace(/\D/g, "");
    if (digits.length !== 10 && !(digits.length === 11 && digits[0] === "1")) { toast("Enter a 10-digit phone number", true); ol.focus(); return; }
    const d = digits.slice(-10), pretty = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    S.settings = await api("/api/settings", { method: "POST", body: { forward_number: pretty } });
    toast(`Office line set to ${pretty}`); LOADERS.overview();
  };
  olSave.onclick = saveLine;
  ol.onkeydown = (e) => { if (e.key === "Enter") saveLine(); if (e.key === "Escape") { ol.value = a.forward_number; olSave.classList.add("hidden"); ol.blur(); } };
  $("#agent-toggle").onchange = async (e) => {
    S.settings = await api("/api/agent", { method: "POST", body: { enabled: e.target.checked } });
    footAgent(); toast(e.target.checked ? `${S.settings.agent_name} is answering calls` : "Agent off — calls forward to the office");
    LOADERS.overview();
  };
  columnChart($("#ov-hours"), o.by_hour, { label: (d) => d.label, value: (d) => d.calls, tip: (d) => `${d.label}: ${d.calls} call${d.calls === 1 ? "" : "s"}` });
  $("#greet-sub").textContent = o.window === "current" ? "Here's what has come in since the last night shift ended." : o.window === "last_night" ? "Here's what happened while the office was closed." : "The past week of calls.";
  const row = (c, right) => `<div class="li" onclick="openCall(${c.id})"><span class="li-title">${esc(c.caller_name || c.caller_id || "Unknown caller")}</span><span class="li-right">${right}</span><span class="li-sub">${esc(c.one_line || (c.status === "active" ? "On the line now…" : ""))}</span></div>`;
  $("#ov-recent").innerHTML = o.recent.map((c) => row(c, `${prio(c.priority)}<div class="muted small" style="margin-top:4px">${clock(c.started_at)}</div>`)).join("") || '<div class="empty">No calls since close.</div>';
  $("#ov-attention").innerHTML = o.attention.map((c) => row(c, c.priority === "emergency" ? prio("emergency") : c.missing.length ? `<span class="pill orange">Missing info</span>` : `<span class="pill">No visit set</span>`)).join("") || '<div class="empty">All clear.</div>';
  $("#ov-upcoming").innerHTML = o.upcoming.map((u) => `<div class="li" onclick="openCall(${u.call_id})"><span class="li-title">${esc(u.customer)} · ${esc(u.town)}</span><span class="li-right"><span class="pill blue">${esc(u.tech_name || "")}</span></span><span class="li-sub">${esc(u.window.replace(/^tomorrow, /, "Tomorrow, "))} · ${esc(u.title)}</span></div>`).join("") || '<div class="empty">No visits offered yet.</div>';
  const ac = o.actions, open = ac.visit.open + ac.alert.open;
  const sub = (k) => `${k.open} open · ${k.pushed} pushed${k.removed ? ` · ${k.removed} removed` : ""}`;
  $("#ov-pipeline").innerHTML = `
    <div class="pipe"><b>Callers</b><div class="what">Phoned the after-hours line</div><div class="big">${m.calls}<small>calls</small></div></div>
    <div class="arrow">→</div>
    <div class="pipe click" data-kind="visit" title="Review visits"><b>Visits held</b><div class="what">${esc(a.name)} offered a window from the schedule. Someone must confirm and assign a technician.</div><div class="big">${ac.visit.total}<small>${sub(ac.visit)}</small></div><div class="pipe-go">Review →</div></div>
    <div class="arrow">→</div>
    <div class="pipe click" data-kind="alert" title="Review alerts"><b>Alerts sent to you</b><div class="what">Calls important enough to text you. Each needs a follow-up.</div><div class="big">${ac.alert.total}<small>${sub(ac.alert)}</small></div><div class="pipe-go">Review →</div></div>`;
  $$("#ov-pipeline .pipe.click").forEach((p) => (p.onclick = () => openActions(p.dataset.kind)));
  $("#ov-push").textContent = open ? `Push ${open} to office` : "Nothing to push";
  $("#ov-push").disabled = !open;
};
$("#ov-refresh").onclick = () => LOADERS.overview();
$$("#ov-window button").forEach((b) => (b.onclick = () => LOADERS.overview(b.dataset.w)));
$("#ov-report").onclick = () => show("report");
$("#ov-push").onclick = async () => {
  const r = await api(`/api/actions?window=${S.ovWindow || ""}`);
  const ids = r.items.filter((i) => i.status === "open" && i.action !== "none").map((i) => i.id);
  if (!ids.length) return;
  if (!confirm(`Send ${ids.length} action item${ids.length === 1 ? "" : "s"} to the ${r.office}?`)) return;
  const p = await api("/api/actions/push", { method: "POST", body: { ids } });
  toast(`${p.pushed} item${p.pushed === 1 ? "" : "s"} pushed to the office`); LOADERS.overview();
};

/* ---------------- action items panel ---------------- */
async function openActions(kind) {
  const r = await api(`/api/actions?window=${S.ovWindow || ""}&kind=${kind}`);
  const title = kind === "visit" ? "Visits held" : "Alerts sent to you";
  const openIds = r.items.filter((i) => i.status === "open" && i.action !== "none").map((i) => i.id);
  const row = (i) => `<div class="act ${i.status}" data-id="${i.id}">
      <div class="act-main" onclick="openCall(${i.call_id})">
        <div class="row" style="gap:8px"><b>${esc(i.customer || i.phone || "Caller")}</b>${prio(i.priority)}${i.transferred_to ? '<span class="pill red">Transferred</span>' : ""}</div>
        <div class="sub">${esc(i.one_line || "")}</div>
        <div class="sub">${[i.address, i.held_window ? "Window: " + i.held_window : null, i.suggested_tech ? "Suggested: " + i.suggested_tech : null, when(i.started_at)].filter(Boolean).map(esc).join(" · ")}</div>
      </div>
      <div class="act-side">
        ${i.status === "removed" ? `<span class="muted small">Removed</span><button class="btn plain small" data-restore="${i.id}">Restore</button>`
          : i.status === "pushed" ? `<span class="pill green">Pushed ${clock(i.pushed_at)}</span><div class="sub">${esc(i.action_label)}</div>`
          : `<select data-act="${i.id}">${Object.entries(r.choices).map(([k, v]) => `<option value="${k}" ${k === i.action ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
             <div class="row" style="gap:6px;justify-content:flex-end"><button class="btn plain small" data-remove="${i.id}">Remove</button><button class="btn small primary" data-push1="${i.id}" ${i.action === "none" ? "disabled" : ""}>Push</button></div>`}
      </div></div>`;
  $("#drawer").innerHTML = `<div class="row"><h2>${title}</h2><button class="btn small" style="margin-left:auto" onclick="closeDrawer()">Close</button></div>
    <p class="muted" style="margin:6px 0 18px">${r.items.length} item${r.items.length === 1 ? "" : "s"} · change the action, remove what doesn't need doing, then push to the ${esc(r.office)}.</p>
    <div class="row" style="margin-bottom:14px"><button class="btn primary" id="act-push-all" ${openIds.length ? "" : "disabled"}>Push ${openIds.length} open item${openIds.length === 1 ? "" : "s"} to office</button></div>
    <div class="acts">${r.items.map(row).join("") || '<div class="empty">Nothing here.</div>'}</div>`;
  $("#drawer").classList.add("open"); $("#scrim").classList.add("open");
  const refresh = () => { openActions(kind); LOADERS.overview(); };
  $$("#drawer [data-act]").forEach((s) => (s.onchange = async () => { await api(`/api/actions/${s.dataset.act}`, { method: "POST", body: { action: s.value } }); refresh(); }));
  $$("#drawer [data-remove]").forEach((b) => (b.onclick = async () => { await api(`/api/actions/${b.dataset.remove}`, { method: "POST", body: { status: "removed" } }); refresh(); }));
  $$("#drawer [data-restore]").forEach((b) => (b.onclick = async () => { await api(`/api/actions/${b.dataset.restore}`, { method: "POST", body: { status: "open" } }); refresh(); }));
  $$("#drawer [data-push1]").forEach((b) => (b.onclick = async () => { await api("/api/actions/push", { method: "POST", body: { ids: [+b.dataset.push1] } }); toast("Pushed to the office"); refresh(); }));
  $("#act-push-all").onclick = async () => { const p = await api("/api/actions/push", { method: "POST", body: { ids: openIds } }); toast(`${p.pushed} pushed to the office`); refresh(); };
}

/* ---------------- calls: history ---------------- */
LOADERS.calls = async () => { await counts(); renderCalls(); if (!$("#calls-analysis").classList.contains("hidden")) loadAnalysis(); };
function renderCalls() {
  const q = $("#q").value.toLowerCase(), cat = $("#f-cat").value, tr = $("#f-trade").value;
  const rows = S.calls.filter((c) => (!cat || c.category === cat) && (!tr || c.trade === tr) && (!q || [c.caller_name, c.caller_id, c.town, c.one_line].join(" ").toLowerCase().includes(q)));
  $("#calls-count").textContent = `${rows.length} of ${S.calls.length} calls`;
  $("#calls-body").innerHTML = rows.map((c) => `<tr class="click" onclick="openCall(${c.id})">
    <td style="white-space:nowrap">${when(c.started_at)}<div class="sub">#${c.id}</div></td>
    <td><b style="font-weight:500">${esc(c.caller_name || "Unknown")}</b><div class="sub">${esc(c.caller_id || "")}${c.town ? " · " + esc(c.town) : ""}</div></td>
    <td>${esc(c.one_line || (c.status === "active" ? "On the line…" : ""))}<div class="row wrap" style="gap:6px;margin-top:6px">${c.category ? `<span class="pill">${esc(CAT[c.category] || c.category)}</span>` : ""}${c.trade && c.trade !== "other" ? `<span class="pill blue">${esc(TRADE[c.trade] || c.trade)}</span>` : ""}${c.transferred_to ? `<span class="pill red">Transferred</span>` : ""}${c.mode === "fallback" ? `<span class="pill orange">Message mode</span>` : ""}</div></td>
    <td>${prio(c.priority)}</td>
    <td>${c.held_window ? `<span class="small">${esc(c.held_window.replace(/^tomorrow, /, ""))}</span>${c.suggested_tech ? `<div class="sub">${esc(c.suggested_tech)}</div>` : ""}` : '<span class="muted">—</span>'}</td>
    <td class="num">${dur(c.duration_s)}<div class="sub">${c.turns} turns</div></td>
    <td class="num">${money(c.cost_usd)}<div class="sub">${num(c.tokens)} tok</div></td></tr>`).join("") || `<tr><td colspan="7" class="empty">No calls match.</td></tr>`;
}
["#q", "#f-cat", "#f-trade"].forEach((s) => $(s).addEventListener("input", renderCalls));
$$("#calls-tabs button").forEach((b) => (b.onclick = () => {
  $$("#calls-tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $("#calls-history").classList.toggle("hidden", b.dataset.tab !== "history");
  $("#calls-analysis").classList.toggle("hidden", b.dataset.tab !== "analysis");
  if (b.dataset.tab === "analysis") loadAnalysis();
}));
$$("#an-range button").forEach((b) => (b.onclick = () => { $$("#an-range button").forEach((x) => x.classList.toggle("on", x === b)); loadAnalysis(); }));

/* ---------------- calls: analysis ---------------- */
async function loadAnalysis() {
  const days = +$("#an-range .on").dataset.d;
  const r = await api(`/api/analysis?days=${days}`);
  const m = r.metrics, a = r.avg_per_call;
  const stat = (label, value, note = "") => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;
  $("#an-stats").innerHTML = [
    stat("Calls handled", m.answered_by_ai, `${m.calls} total incl. forwarded`),
    stat("Visit booking rate", m.booking_rate != null ? Math.round(m.booking_rate * 100) + "%" : "—", `${m.windows_held} of ${m.service_requests} service requests`),
    stat("Avg cost per call", money(m.cost_per_call), `${num(a.input_tokens)} in · ${num(a.output_tokens)} out tokens`),
    stat("Served from cache", a.input_tokens ? Math.round((100 * a.cached_tokens) / a.input_tokens) + "%" : "—", "of input tokens (10× cheaper)"),
  ].join("");
  const hrs = [...r.by_hour.slice(17), ...r.by_hour.slice(0, 9)];
  columnChart($("#an-hour"), hrs, { label: (d) => { const h = d.hour % 12 || 12; return `${h}${d.hour < 12 ? "a" : "p"}`; }, value: (d) => d.calls, tip: (d) => `${d.hour % 12 || 12} ${d.hour < 12 ? "AM" : "PM"}: ${d.calls} calls` });
  hbars($("#an-funnel"), r.funnel.map((f) => [f.stage, f.n]));
  hbars($("#an-cat"), r.by_category, CAT);
  hbars($("#an-trade"), r.by_trade, TRADE);
  hbars($("#an-town"), Object.entries(r.by_town).slice(0, 8));
  const AG = { receptionist: "Receptionist · conversation", receptionist_log: "Receptionist · call log", dispatcher: "Dispatcher · morning plan", call_agent: "Receptionist (v1)", summarizer: "Call log (v1)" };
  $("#an-agents").innerHTML = `<table><thead><tr><th>Agent</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Cached</th><th class="num">Output</th><th class="num">Latency</th><th class="num">Cost</th></tr></thead><tbody>
    ${r.per_agent.map((x) => `<tr><td>${esc(AG[x.agent] || x.agent)}</td><td class="num">${x.requests}</td><td class="num">${num(x.input_tokens)}</td><td class="num">${num(x.cached_tokens)}</td><td class="num">${num(x.output_tokens)}</td><td class="num">${(x.avg_latency_ms / 1000).toFixed(1)}s</td><td class="num">${money(x.cost_usd)}</td></tr>`).join("")}
    <tr><td class="muted">Dispatcher · alerts & suggestions</td><td class="num muted" colspan="5">rules only — no model calls</td><td class="num">$0</td></tr></tbody></table>
    <p class="help">gpt-6-luna: $0.10 per 1M input tokens, $0.01 per 1M cached input, $0.50 per 1M output.</p>`;
  const rep = r.reports.avg_cost || 0;
  $("#an-cost").innerHTML = `<label style="margin-top:0">After-hours calls per business per month</label><input type="number" id="calc-calls" value="150"><div class="mini-kv" style="margin-top:14px;font-size:13.5px" id="calc-out"></div><p class="help">Includes one morning report a day (avg ${money(rep)}). One user = one business.</p>`;
  const upd = () => { const c = +$("#calc-calls").value || 0; const mo = c * m.cost_per_call + 30 * rep; $("#calc-out").innerHTML = `<span class="muted">Per call</span><b>${money(m.cost_per_call)}</b><span class="muted">Per business / month</span><b>${money(mo)}</b><span class="muted">100 businesses / month</span><b>${money(mo * 100)}</b><span class="muted">10,000 businesses / month</span><b>${money(mo * 10000)}</b>`; };
  $("#calc-calls").oninput = upd; upd();
  const SK = { prompt_injection: "Manipulation attempt flagged", provider_filter: "Blocked by provider filter", output_redacted: "Private info removed from reply", emergency_override: "Safety word → emergency", budget_stop: "Budget cap → message mode", model_error: "Model error → message mode" };
  $("#an-safety").innerHTML = r.safety_events.length ? `<table><tbody>${r.safety_events.map((e) => `<tr class="click" onclick="openCall(${e.call_id})"><td style="width:140px" class="muted">${when(e.ts)}</td><td style="width:240px"><b style="font-weight:500">${esc(SK[e.kind] || e.kind)}</b></td><td class="muted small">${esc(e.detail)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">No guards fired.</div>';
}

/* ---------------- call detail drawer ---------------- */
function closeDrawer() { $("#drawer").classList.remove("open"); $("#scrim").classList.remove("open"); }
$("#scrim").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
async function openCall(id) {
  if (!id) return;
  const c = await api(`/api/calls/${id}`);
  const n = c.notes || {};
  const fields = S.boot.note_fields.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(n[f.key] || "—")}${(n._filled_after_call || []).includes(f.key) ? ' <span class="pill">from transcript</span>' : ""}</dd>`).join("");
  const trace = (c.trace || []).filter((e) => e.kind !== "model").map((e) => `<div class="t"><span class="muted">${esc((e.ts || "").slice(11, 19))}</span><b style="font-weight:500">${esc(e.kind === "guard" ? "guard · " + e.guard : e.kind)}</b><code>${esc(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["ts", "kind", "guard"].includes(k)))))}</code></div>`).join("");
  const AG = { receptionist: "Receptionist", receptionist_log: "Call log", sim_caller: "Simulated caller", call_agent: "Receptionist (v1)", summarizer: "Call log (v1)" };
  const usage = c.usage_rows.map((u) => `<tr><td>${esc(AG[u.agent] || u.agent)}${u.simulated ? ' <span class="pill">not billed</span>' : ""}</td><td class="num">${num(u.input_tokens)}</td><td class="num">${num(u.cached_tokens)}</td><td class="num">${num(u.output_tokens)}</td><td class="num">${(u.latency_ms / 1000).toFixed(1)}s</td><td class="num">${money(u.cost_usd)}</td></tr>`).join("");
  const rv = c.review || {}, dp = c.dispatch || {};
  $("#drawer").innerHTML = `
    <div class="row"><h2>${esc(n.caller_name || c.caller_id || "Call")} </h2>${prio(c.priority)}<span class="pill">${esc(CAT[c.category] || c.category || c.status)}</span><button class="btn small" style="margin-left:auto" onclick="closeDrawer()">Close</button></div>
    <p class="muted" style="margin:6px 0 0">Call #${c.id} · ${when(c.started_at)} · ${esc(c.caller_id || "")} · ${c.turns} turns${c.transferred_to ? " · transferred to " + esc(c.transferred_to) : ""}</p>
    <div class="card"><div class="card-title"><h3>Summary</h3></div><div style="line-height:1.5">${esc(c.summary || "—")}</div>
      ${n.held_window ? `<div class="row wrap" style="margin-top:12px;gap:8px"><span class="pill blue">Tentative visit: ${esc(n.held_window)}</span>${dp.tech_name ? `<span class="pill">Suggested tech: ${esc(dp.tech_name)}</span>` : ""}</div>` : dp.tech_name ? `<div style="margin-top:12px"><span class="pill">Dispatcher suggests ${esc(dp.tech_name)} · ${esc(dp.window || "")}</span></div>` : ""}
      ${(rv.follow_up || []).length ? `<div style="margin-top:14px"><div class="muted small" style="margin-bottom:4px">Follow-up</div>${rv.follow_up.map((x) => `<div>• ${esc(x)}</div>`).join("")}</div>` : ""}
      ${(rv.missing_info || []).length ? `<div style="margin-top:10px;color:var(--orange)" class="small">Missing: ${esc(rv.missing_info.join(", "))}</div>` : ""}</div>
    <div class="card"><div class="card-title"><h3>Call notes</h3></div><dl class="kv">${fields}</dl></div>
    ${c.safety_events.length ? `<div class="card"><div class="card-title"><h3>Safety</h3></div>${c.safety_events.map((e) => `<div class="small" style="margin:4px 0;color:var(--orange)">${esc(e.kind)} — ${esc(e.detail)}</div>`).join("")}</div>` : ""}
    ${c.messages.length ? `<div class="card"><div class="card-title"><h3>Text sent to manager</h3></div>${c.messages.map((m) => `<div class="sms" style="margin:0">${esc(m.body)}</div>`).join("")}</div>` : ""}
    <div class="card"><div class="card-title"><h3>Transcript</h3></div><div class="transcript" style="padding:0">${(c.transcript || []).map((m) => `<div class="bubble ${m.role}"><span class="meta">${m.role === "agent" ? esc(S.settings.agent_name) : "Caller"}</span>${esc(m.text)}</div>`).join("")}</div></div>
    <div class="card"><div class="card-title"><h3>Agent trace</h3><span class="sub">steps, tools and guards</span></div><div class="timeline">${trace || '<span class="muted">—</span>'}</div></div>
    <div class="card"><div class="card-title"><h3>Tokens & cost</h3><span class="sub">${money(c.usage.cost_usd)} total</span></div><table><thead><tr><th>Agent</th><th class="num">Input</th><th class="num">Cached</th><th class="num">Output</th><th class="num">Latency</th><th class="num">Cost</th></tr></thead><tbody>${usage}</tbody></table></div>`;
  $("#drawer").classList.add("open"); $("#scrim").classList.add("open"); $("#drawer").scrollTop = 0;
}
window.openCall = openCall; window.closeDrawer = closeDrawer;

/* ---------------- morning report: one per night shift ---------------- */
const dayLong = (d) => new Date(d + "T12:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
const dayShort = (d) => new Date(d + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
LOADERS.report = async () => {
  const r = await api("/api/reports/nights");
  S.nights = [{ ...r.current, current: true }, ...r.nights];
  if (!S.night || !S.nights.some((n) => n.night === S.night)) {
    S.night = (S.nights.find((n) => n.calls && !n.current) || S.nights.find((n) => n.calls) || S.nights[0]).night;
  }
  renderNights();
  showNight(S.night);
};
function renderNights() {
  $("#nights").innerHTML = S.nights.map((n) => `<div class="night ${n.night === S.night ? "on" : ""}" data-n="${n.night}">
    <div class="nd">${n.current ? "Current" : dayShort(n.night)}</div>
    <div class="ns">${n.current ? `since ${clock(n.start)} · ` : ""}${n.calls ? `${n.calls} call${n.calls === 1 ? "" : "s"}` : "No calls"}${n.emergencies ? ` · <span style="color:var(--red)">${n.emergencies} emergency</span>` : ""}${n.report_at ? ` · <span title="Report ready">✓</span>` : ""}</div></div>`).join("");
  $$("#nights .night").forEach((el) => (el.onclick = () => { S.night = el.dataset.n; renderNights(); showNight(S.night); }));
}
async function showNight(night) {
  const n = S.nights.find((x) => x.night === night);
  const { report } = n.calls ? await api(`/api/reports/night/${night}`) : { report: null };
  if (S.night !== night) return;
  const title = n.current ? (report ? `Current report · ${new Date(report.generated_at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Current report")
                          : "Morning of " + dayLong(night);
  const range = n.current ? (report ? `Calls from ${when(report.range.start)} to ${when(report.range.end)}` : `Calls since ${when(n.start)} (now)`) : `Calls from ${when(n.start)} to ${when(n.end)}`;
  const head = `<div class="rhead"><div><h2>${esc(title)}</h2><div class="muted">${esc(range)}</div></div>
      ${n.calls ? `<button class="btn primary no-print" id="btn-report">${report ? (n.current ? "Build a new current report" : "Rebuild report") : "Build report"}</button>` : ""}</div>`;
  if (!n.calls) { $("#report").innerHTML = head + `<div class="card empty">${n.current ? "No calls since the last night shift ended." : "No calls came in this night."}</div>`; return; }
  $("#report").innerHTML = head + (report ? reportBody(report) : `<div class="card empty">${n.calls} call${n.calls === 1 ? "" : "s"} so far. Build the report to get the Dispatcher's plan.</div>`);
  $("#btn-report").onclick = async () => {
    const b = $("#btn-report"); b.disabled = true; b.innerHTML = '<span class="spinner"></span> Planning…';
    try { await api(`/api/reports/night/${night}`, { method: "POST" }); await LOADERS.report(); }
    catch (e) { toast(e.message, true); b.disabled = false; b.textContent = "Build report"; }
  };
}
function reportBody(r) {
  const s = r.stats;
  const facts = [`${s.calls} calls`, s.emergencies ? `${s.emergencies} emergenc${s.emergencies === 1 ? "y" : "ies"} (${s.transfers} transferred)` : null, `${s.to_dispatch} job${s.to_dispatch === 1 ? "" : "s"} to dispatch`, `built ${when(r.generated_at)}`].filter(Boolean).join(" · ");
  return `<p class="rfacts">${esc(facts)}</p>
    <p class="rsummary">${esc(r.overview)}</p>
    <div class="card rcard"><div class="card-title"><h3>Who takes each job</h3><span class="sub">suggestions only — nothing is booked</span></div>
      <table><tbody>${r.assignments.map((a) => `<tr class="click" onclick="openCall(${a.call_id})">
        <td style="width:190px"><b style="font-weight:500">${esc(a.window.replace(/^tomorrow, /, "").replace(/^today, /, ""))}</b>${a.matches_hold ? '<div class="sub" style="color:var(--blue)">window offered on the call</div>' : ""}</td>
        <td style="width:160px"><b style="font-weight:500">${esc(a.tech_name)}</b><div class="sub">${esc(a.tech_level)}</div></td>
        <td>${esc(a.customer || "")}${a.address ? ` · <span class="muted">${esc(a.address)}</span>` : ""}<div class="sub">${esc(a.reason)}</div></td>
        <td style="width:100px;text-align:right">${prio(a.priority)}</td></tr>`).join("") || '<tr><td class="empty">No jobs to assign.</td></tr>'}</tbody></table></div>
    ${r.needs_attention.length ? `<div class="card rcard"><div class="card-title"><h3>Needs your decision</h3></div>${r.needs_attention.map((x) => `<div class="li" onclick="openCall(${x.call_id})"><span class="li-title">${esc(x.customer || "Call #" + x.call_id)}</span><span class="li-sub">${esc(x.issue)}</span></div>`).join("")}</div>` : ""}
    <div class="card rcard"><div class="card-title"><h3>Calls this night</h3></div><table><tbody>
      ${r.calls.map((c) => `<tr class="click" onclick="openCall(${c.id})"><td style="width:90px" class="muted">${clock(c.started_at)}</td><td style="width:160px">${esc(c.caller || "Unknown")}</td><td>${esc(c.one_line || "")}</td><td style="width:100px;text-align:right">${prio(c.priority)}</td></tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------------- test a call: speech ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function loadVoices() { S.voices = "speechSynthesis" in window ? speechSynthesis.getVoices() : []; if (!$("#agent-settings")?.classList.contains("hidden")) fillVoiceSelect(); }
function pickVoice(name, lang) { return S.voices.find((v) => v.name === name) || S.voices.find((v) => v.lang.startsWith(lang)) || S.voices.find((v) => v.lang.startsWith("en")) || null; }
function callerVoice() {
  const agent = pickVoice(S.settings.voice_name, S.settings.voice_lang);
  const en = S.voices.filter((v) => v.lang.startsWith("en") && v.name !== agent?.name);
  return en.find((v) => /Daniel|Alex|Fred|Google UK English Male|Aaron|Arthur/i.test(v.name)) || en[0] || agent;
}
function speak(text, who = "agent") {
  return new Promise((resolve) => {
    if (!$("#opt-voice").checked || !("speechSynthesis" in window) || !text) return resolve();
    let said = text.replace(/\[removed\]/g, "");
    if (who === "agent") for (const p of [...(S.settings.pronunciations || [])].sort((a, b) => b.word.length - a.word.length)) said = said.replace(new RegExp(`\\b${p.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), p.say);
    const u = new SpeechSynthesisUtterance(said);
    const v = who === "agent" ? pickVoice(S.settings.voice_name, S.settings.voice_lang) : callerVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = who === "agent" ? +S.settings.speech_rate : 1.08;
    u.pitch = who === "agent" ? +S.settings.speech_pitch : 1;
    u.onend = u.onerror = () => { S.speaking = false; ringState(); resolve(); };
    S.speaking = who === "agent"; ringState();
    speechSynthesis.speak(u);
  });
}
function listen() {
  if (!SR || !S.call || S.busy || S.listening) return;
  const rec = new SR();
  rec.lang = S.settings.voice_lang;
  rec.interimResults = true;
  let finalText = "";
  rec.onresult = (e) => { let interim = ""; for (const r of e.results) r.isFinal ? (finalText = r[0].transcript) : (interim += r[0].transcript); $("#say-input").value = finalText || interim; };
  rec.onerror = (e) => { if (!["no-speech", "aborted"].includes(e.error)) toast("Mic: " + e.error, true); };
  rec.onend = () => {
    S.listening = false; S.rec = null; $("#btn-mic").classList.remove("on"); ringState();
    const t = (finalText || $("#say-input").value).trim();
    if (t && S.call) { S.reminders = 0; return sendTurn(t); }
    if (S.call && $("#opt-handsfree").checked) silence();
  };
  S.rec = rec; S.listening = true; $("#btn-mic").classList.add("on"); ringState();
  rec.start();
}
async function silence() {
  // Like Retell's reminder settings: nudge after N seconds of silence, then hang up politely.
  if (!S.call || S.busy) return;
  if ((Date.now() - S.lastSpoke) / 1000 < (+S.settings.reminder_after_s || 10)) return listen();
  if ((S.reminders || 0) < (+S.settings.reminder_max || 0)) { S.reminders = (S.reminders || 0) + 1; event("Silence — reminder"); await speak("Are you still there?"); S.lastSpoke = Date.now(); return listen(); }
  event("No answer — ending the call"); await speak("I'll let you go. Feel free to call back anytime. Goodbye."); hangUp();
}
function stopListening() { if (S.rec) S.rec.abort(); }
function ringState() {
  $("#ring").className = "ring" + (S.call ? " live" : "") + (S.speaking ? " speaking" : "") + (S.listening ? " listening" : "");
  $("#call-status").textContent = !S.call ? "Ready" : S.speaking ? "Speaking…" : S.listening ? "Listening…" : S.busy ? "Thinking…" : "On the line";
}

/* ---------------- test a call: flow ---------------- */
function bubble(role, text) {
  const t = $("#transcript"); $(".empty", t)?.remove();
  t.insertAdjacentHTML("beforeend", `<div class="bubble ${role}">${esc(text)}</div>`);
  t.scrollTop = t.scrollHeight;
}
function event(text, cls = "") { const t = $("#transcript"); t.insertAdjacentHTML("beforeend", `<div class="event ${cls}">${esc(text)}</div>`); t.scrollTop = t.scrollHeight; }
function typing(on) { $("#typing")?.remove(); if (on) { $("#transcript").insertAdjacentHTML("beforeend", '<div class="typing" id="typing"><i></i><i></i><i></i></div>'); $("#transcript").scrollTop = 1e9; } }
function renderNotes(n) {
  $("#live-notes").innerHTML = S.boot.note_fields.map((f) => `<div class="note ${n[f.key] ? "have" : ""} ${f.required ? "req" : ""}"><span class="d"></span><span class="k">${esc(f.label)}</span><span class="v">${esc(n[f.key] || "")}</span></div>`).join("");
  $("#live-hold").innerHTML = n.held_window ? `<span class="pill blue">Visit held · ${esc(n.held_window)}</span>` : "";
}
function renderSteps(cur) { $("#live-steps").innerHTML = S.tree.nodes.map((n) => `<div class="step ${n.id === cur ? "current" : S.visited.has(n.id) ? "visited" : ""}">${esc(n.title)}</div>`).join(""); }
function renderUsage(u) {
  if (!u) return;
  $("#u-req").textContent = u.requests; $("#u-in").textContent = `${num(u.input_tokens)} (${num(u.cached_tokens)})`; $("#u-out").textContent = num(u.output_tokens); $("#u-cost").textContent = money(u.cost_usd);
  $("#u-cap").textContent = `${Math.round((100 * u.cost_usd) / S.settings.per_call_budget_usd)}% of the ${money(+S.settings.per_call_budget_usd)} per-call limit`;
  $("#u-bar").style.width = Math.min(100, (100 * u.cost_usd) / S.settings.per_call_budget_usd) + "%";
}
const GUARD = { prompt_injection: "Manipulation attempt flagged", emergency_override: "Safety word → emergency step", output_redaction: "Private info removed from reply", blocked_move: "Blocked a move the call flow doesn't allow", blocked_transfer: "Blocked a non-emergency transfer", invented_window: "Blocked a time not on the schedule", budget_stop: "Cost limit → message mode", max_turns: "Turn limit → wrapping up", max_model_steps: "Step limit reached", bad_json: "Malformed answer retried", length: "Long input trimmed", model_error: "Model error → message mode", provider_filter: "Blocked by provider filter", forced_transfer: "Transfer step reached → call forwarded by code", attack_hangup: "3 manipulation attempts → call ended (no tokens)", unheld_promise: "Promised a window that was not held → corrected" };
function renderTrace(trace) {
  const box = $("#live-guards"); if ($(".muted", box)) box.innerHTML = "";
  for (const e of trace || []) {
    let label = null, cls = "";
    if (e.kind === "guard") { label = GUARD[e.guard] || e.guard; if (e.guard === "emergency_override") label += ` (“${e.keyword}”)`; cls = e.guard === "emergency_override" ? "danger" : "guard"; }
    else if (e.kind === "availability") { label = `Checked schedule: ${e.windows.length} window${e.windows.length === 1 ? "" : "s"}${e.in_service_area === false ? " · outside service area" : ""}`; cls = "ok"; }
    else if (e.kind === "hold") { label = `Held ${e.window}`; cls = "ok"; }
    else if (e.kind === "transfer") { label = `Transferred to on-call ${e.to}`; cls = "danger"; }
    else if (e.kind === "step") { S.visited.add(e.frm); S.visited.add(e.to); }
    if (label) { box.insertAdjacentHTML("afterbegin", `<div class="step" style="color:var(--${cls === "ok" ? "green" : cls === "danger" ? "red" : "orange"})">${esc(label)}</div>`); event(label, cls); }
  }
}
function controls(on) {
  $("#btn-start").disabled = on; $("#btn-hang").disabled = !on; $("#btn-mic").disabled = !on || !SR;
  $("#say-input").disabled = !on; $("#btn-send").disabled = !on;
  $("#btn-autostep").disabled = $("#btn-autoplay").disabled = !on || !S.call?.scenario;
  ringState();
}
async function startCall() {
  if (S.call) return;
  S.visited = new Set();
  $("#transcript").innerHTML = ""; $("#live-guards").innerHTML = '<span class="muted small">Nothing yet.</span>';
  const scenario = $("#scenario").value;
  event(`Incoming call · ${$("#caller-id").value}`);
  const r = await api("/api/calls", { method: "POST", body: { caller_id: $("#caller-id").value, sim_time: $("#sim-time").value, scenario_id: scenario || null } });
  S.call = { id: r.call_id, scenario }; S.t0 = Date.now();
  S.timer = setInterval(() => { const s = Math.floor((Date.now() - S.t0) / 1000); $("#call-timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }, 500);
  $("#call-badge").textContent = `Call #${r.call_id}`;
  controls(true); renderNotes({}); renderSteps(r.step); renderUsage({ requests: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_usd: 0 });
  if (r.forwarded_to) { bubble("agent", r.reply); event(`Forwarded to ${r.forwarded_to} — no AI used`, "ok"); await speak(r.reply); return endCall("forwarded"); }
  S.visited.add(r.step); bubble("agent", r.reply);
  await speak(r.reply);
  next();
}
function next() { S.lastSpoke = Date.now(); if (!S.call) return; if ((Date.now() - S.t0) / 60000 > (+S.settings.max_call_minutes || 34)) { event("Max call length reached"); return hangUp(); } if (S.auto) return autoStep(); if ($("#opt-handsfree").checked && SR && !S.call.scenario) listen(); else $("#say-input").focus(); }
async function sendTurn(text) {
  if (!S.call || S.busy) return;
  stopListening(); $("#say-input").value = ""; bubble("caller", text);
  S.busy = true; ringState(); typing(true);
  const t0 = Date.now();
  const filler = setTimeout(() => { if (S.settings.use_fillers && S.busy && Date.now() - S.lastFiller > 20000) { S.lastFiller = Date.now(); const f = S.settings.fillers; speak(f[Math.floor(Math.random() * f.length)]); } }, 2200);
  let r;
  try { r = await api(`/api/calls/${S.call.id}/turn`, { method: "POST", body: { text } }); }
  catch (e) { toast(e.message, true); S.busy = false; typing(false); ringState(); clearTimeout(filler); return; }
  clearTimeout(filler);
  const wait = Math.max(0, (+S.settings.response_delay_ms || 0) - (Date.now() - t0)); if (wait) await sleep(wait);
  S.busy = false; typing(false);
  renderTrace(r.trace); renderNotes(r.notes || {}); S.visited.add(r.step); renderSteps(r.step); renderUsage(r.usage);
  bubble("agent", r.reply);
  while ("speechSynthesis" in window && speechSynthesis.speaking) await sleep(100);
  await speak(r.reply);
  if (r.ended) return endCall(r.transferred_to ? "transferred" : "ended");
  next();
}
async function autoStep() {
  if (!S.call || S.busy) return;
  S.busy = true; $("#call-status").textContent = "Caller is talking…";
  let r;
  try { r = await api(`/api/calls/${S.call.id}/autocaller`, { method: "POST", body: { scenario_id: S.call.scenario } }); }
  catch (e) { S.busy = false; toast(e.message, true); return; }
  S.busy = false;
  if (r.text.includes("[hangs up]")) { event("Caller hung up"); await api(`/api/calls/${S.call.id}/hangup`, { method: "POST" }); return endCall("ended"); }
  await speak(r.text, "caller");
  sendTurn(r.text);
}
async function hangUp() { if (!S.call) return; S.auto = false; speechSynthesis.cancel(); stopListening(); await api(`/api/calls/${S.call.id}/hangup`, { method: "POST" }).catch(() => {}); event("You hung up"); endCall("ended"); }
async function endCall(how) {
  const id = S.call.id;
  clearInterval(S.timer); S.call = null; S.auto = false; $("#btn-autoplay").textContent = "Auto-play";
  controls(false); $("#call-badge").textContent = `Call #${id} · ${how}`;
  event(how === "transferred" ? "Call transferred to the on-call technician" : "Call ended — Receptionist is writing the log…", how === "transferred" ? "danger" : "");
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const c = await api(`/api/calls/${id}`);
    if (c.status === "completed") {
      const dp = c.dispatch || {};
      $("#transcript").insertAdjacentHTML("beforeend", `<div class="card" style="margin-top:10px;background:var(--surface-2);box-shadow:none;border:1px solid var(--line)"><div class="row" style="gap:8px;margin-bottom:8px"><b>Call logged</b>${prio(c.priority)}<span class="pill">${esc(CAT[c.category] || c.category || "")}</span></div><div style="line-height:1.5">${esc(c.summary || "")}</div>${dp.tech_name ? `<div class="small muted" style="margin-top:8px">Dispatcher suggests <b style="color:var(--ink)">${esc(dp.tech_name)}</b> · ${esc(dp.window || "")}</div>` : ""}${c.messages.length ? `<div class="small muted" style="margin-top:6px">Manager texted ✓</div>` : ""}<div style="margin-top:10px"><button class="btn small" onclick="openCall(${id})">Open record</button></div></div>`);
      $("#transcript").scrollTop = 1e9; renderUsage(c.usage); counts();
      break;
    }
  }
}
$("#btn-start").onclick = () => startCall().catch((e) => toast(e.message, true));
$("#btn-hang").onclick = hangUp;
$("#btn-mic").onclick = () => (S.listening ? stopListening() : listen());
$("#btn-send").onclick = () => { const v = $("#say-input").value.trim(); if (v) sendTurn(v); };
$("#say-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#btn-send").click(); } });
$("#btn-autostep").onclick = autoStep;
$("#btn-autoplay").onclick = () => { S.auto = !S.auto; $("#btn-autoplay").textContent = S.auto ? "Pause" : "Auto-play"; if (S.auto && !S.busy && !S.speaking) autoStep(); };
$("#scenario").onchange = () => { const sc = S.boot.scenarios.find((s) => s.id === $("#scenario").value); if (sc) $("#caller-id").value = sc.caller_id; };

/* ---------------- call flow editor ---------------- */
LOADERS.agent = () => { renderTree(); LOADERS.settings(); };
$$("#agent-tabs button").forEach((b) => (b.onclick = () => {
  $$("#agent-tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $("#agent-map").classList.toggle("hidden", b.dataset.tab !== "map");
  $("#agent-settings").classList.toggle("hidden", b.dataset.tab !== "settings");
  $("#agent-kb").classList.toggle("hidden", b.dataset.tab !== "kb");
  $("#agent-model").classList.toggle("hidden", b.dataset.tab !== "model");
  if (b.dataset.tab === "kb") loadKb();
  if (b.dataset.tab === "model") renderModels();
}));

/* ---------------- knowledge base (upload only) ---------------- */
const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
async function loadKb(data) {
  const r = data || (await api("/api/kb"));
  if (r.allowed) $("#kb-types").textContent = `${r.allowed.join(", ")} · up to ${r.max_mb} MB each`;
  $("#kb-count").textContent = r.files.length ? `${r.files.length} file${r.files.length === 1 ? "" : "s"}` : "";
  $("#kb-list").innerHTML = r.files.length ? `<table><tbody>${r.files.map((f) => `<tr><td><span class="ftype">${esc(f.type)}</span> ${esc(f.name)}</td><td class="muted small" style="width:90px">${kb(f.bytes)}</td><td class="muted small" style="width:140px">${when(f.uploaded_at)}</td><td style="width:90px"><span class="pill">Not indexed</span></td><td style="width:40px"><button class="btn plain small" data-del="${esc(f.name)}" title="Remove">✕</button></td></tr>`).join("")}</tbody></table>` : '<div class="empty">No files yet.</div>';
  $$("#kb-list [data-del]").forEach((b) => (b.onclick = async () => { if (confirm(`Remove ${b.dataset.del}?`)) loadKb(await api(`/api/kb/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" })); }));
}
async function uploadKb(files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await fetch("/api/kb", { method: "POST", body: fd });
  const r = await res.json();
  loadKb(r);
  if (r.saved.length) toast(`Uploaded ${r.saved.length} file${r.saved.length === 1 ? "" : "s"}`);
  if (r.rejected.length) toast(r.rejected.map((x) => `${x.name}: ${x.why}`).join(" · "), true);
}
$("#kb-file").onchange = (e) => { uploadKb([...e.target.files]); e.target.value = ""; };
const dz = $("#kb-drop");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => uploadKb([...e.dataTransfer.files]));

/* ---------------- model (display only) ---------------- */
const MODELS = [
  { id: "gpt-6-luna", note: "Fast, low cost · course key", on: true },
  { id: "gpt-6-astra", note: "Highest quality · ~100× the cost" },
  { id: "Claude", note: "Alternative provider" },
  { id: "Gemini", note: "Alternative provider" },
  { id: "Open-source (self-hosted)", note: "Data stays in-house" },
];
function renderModels() {
  const agents = [
    { name: "Receptionist", what: "Talks to callers. Needs speed (every turn is a pause on the phone).", effort: S.settings.reasoning_effort },
    { name: "Call log writer", what: "Writes the summary, priority and missing info after each call.", effort: "none" },
    { name: "Dispatcher", what: "Builds the morning plan. Can afford to be slower and more careful.", effort: "low" },
  ];
  $("#model-cards").innerHTML = agents.map((a) => `<div class="card"><div class="card-title"><h3>${a.name}</h3></div><p class="help" style="margin:-6px 0 14px">${a.what}</p>
    <label style="margin-top:0">Model</label><select class="model-sel">${MODELS.map((m) => `<option ${m.on ? "selected" : "disabled"}>${esc(m.id)} — ${esc(m.note)}${m.on ? "" : " (not connected)"}</option>`).join("")}</select>
    <div class="mini-kv" style="margin-top:14px"><span class="muted">Reasoning effort</span><b>${esc(a.effort)}</b><span class="muted">Price (per 1M tokens)</span><b>$0.10 in · $0.01 cached · $0.50 out</b></div></div>`).join("");
}
/* ---------------- conversation map: interactive canvas ---------------- */
const NW = 210, NH = 76;                   // node size (canvas units)
const FV = { x: 40, y: 30, k: 0.8, sel: null, built: false };   // view: pan x/y, zoom k; sel = {type:'node'|'edge'|'rule', ...}
function autoLayout(force = false) {
  const nodes = S.tree.nodes, byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  if (!force && nodes.every((n) => n.pos)) return;
  const level = {}; const q = [S.tree.start]; level[S.tree.start] = 0;
  while (q.length) { const id = q.shift(); for (const e of byId[id]?.next || []) if (level[e.to] == null && byId[e.to]) { level[e.to] = level[id] + 1; q.push(e.to); } }
  let maxL = Math.max(0, ...Object.values(level));
  for (const n of nodes) if (level[n.id] == null) level[n.id] = ++maxL;
  const rows = {};
  for (const n of nodes) (rows[level[n.id]] ||= []).push(n);
  let y = 40;
  for (const l of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
    const ns = rows[l];
    for (let r = 0; r < ns.length; r += 5) {
      const chunk = ns.slice(r, r + 5);
      chunk.forEach((n, i) => { if (force || !n.pos) n.pos = { x: 1200 + (i - (chunk.length - 1) / 2) * (NW + 50), y }; });
      y += NH + 70;
    }
  }
  (S.tree.safety_rules || []).forEach((r, i) => { if (force || !r.pos) r.pos = { x: 300, y: 40 + i * 100 }; });
}
function renderTree() {
  autoLayout();
  const box = $("#tree-diagram");
  if (!FV.built) {
    box.innerHTML = `<div class="fstage" id="fstage"><svg class="fedges" id="fedges" width="6000" height="4000"><defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8e8e8e"/></marker>
        <marker id="arr-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#3e6ae1"/></marker>
        <marker id="arr-rule" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#b5500b"/></marker></defs><g id="fedge-g"></g><path id="ftemp" class="fedge temp" d=""/></svg><div id="fnodes"></div></div>
      <div class="fzoom no-print"><button data-z="in" title="Zoom in">+</button><button data-z="out" title="Zoom out">−</button><button data-z="reset" title="100%">100%</button><button data-z="fit" title="Fit to screen">Fit</button><button data-z="tidy" title="Arrange automatically">Tidy up</button></div>
      <div class="fhint no-print">Drag steps to move · drag from a step's bottom dot to another step to connect · click an arrow to edit · scroll to zoom · drag the background to pan · Delete removes the selection</div>`;
    bindCanvas(box);
    FV.built = true;
    FV.needFit = true;
  }
  drawNodes(); drawEdges(); applyView();
  // fit once the canvas is actually visible (the tab may still be hidden on first render)
  if (FV.needFit) requestAnimationFrame(function tryFit() { if ($("#tree-diagram").offsetWidth) { FV.needFit = false; fitView(); } else setTimeout(tryFit, 200); });
  $("#global-prompt").value = S.tree.global_prompt || "";
  $("#global-prompt").oninput = (e) => (S.tree.global_prompt = e.target.value);
  $("#rules").innerHTML = (S.tree.safety_rules || []).map((r, i) => `<label${i ? "" : ' style="margin-top:0"'}>${esc(r.label)}</label><input data-rule="${i}" value="${esc(r.keywords.join(", "))}">`).join("");
  $$("#rules input").forEach((inp) => (inp.onchange = () => { S.tree.safety_rules[+inp.dataset.rule].keywords = inp.value.split(",").map((s) => s.trim()).filter(Boolean); }));
  sidePanel();
}
function applyView() { $("#fstage").style.transform = `translate(${FV.x}px, ${FV.y}px) scale(${FV.k})`; $(".fzoom [data-z=reset]").textContent = Math.round(FV.k * 100) + "%"; }
function drawNodes() {
  const sel = FV.sel;
  const typeLabel = { ai: "Conversation", transfer: "Transfer", end: "End call" };
  $("#fnodes").innerHTML = S.tree.nodes.map((n) => `<div class="fnode ${n.type} ${n.id === S.tree.start ? "start" : ""} ${sel?.type === "node" && sel.id === n.id ? "sel" : ""}" data-id="${n.id}" style="left:${n.pos.x}px;top:${n.pos.y}px">
      <span class="fport in"></span>
      <div class="ft">${esc(n.title)}</div>
      <div class="fs">${n.id === S.tree.start ? "Start · " : ""}${typeLabel[n.type] || n.type}${(n.collect || []).length ? ` · collects ${n.collect.length}` : ""}</div>
      ${n.type === "ai" ? '<span class="fport out" title="Drag to another step to connect"></span>' : ""}
    </div>`).join("") + (S.tree.safety_rules || []).map((r, i) => `<div class="fnode rule ${sel?.type === "rule" && sel.i === i ? "sel" : ""}" data-rule="${i}" style="left:${r.pos.x}px;top:${r.pos.y}px"><div class="ft">⚠ ${esc(r.label)}</div><div class="fs">Safety words → ${esc((S.tree.nodes.find((n) => n.id === r.goto)?.title || r.goto).split(":")[0])}</div></div>`).join("");
}
function edgePath(a, b) {
  const x1 = a.x + NW / 2, y1 = a.y + NH, x2 = b.x + NW / 2, y2 = b.y;
  const dy = Math.max(40, Math.abs(y2 - y1) / 2);
  if (y2 > y1 + 10) return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2 - 2}`;
  const side = x2 >= x1 ? 1 : -1, bend = 120;   // target above: loop around the side
  return `M${x1},${y1} C${x1 + side * bend},${y1 + 80} ${x2 + side * bend},${y2 - 80} ${x2},${y2 - 2}`;
}
function drawEdges() {
  const byId = Object.fromEntries(S.tree.nodes.map((n) => [n.id, n]));
  const sel = FV.sel;
  let g = "";
  for (const n of S.tree.nodes) (n.next || []).forEach((e, i) => {
    const t = byId[e.to]; if (!t) return;
    const on = sel?.type === "edge" && sel.from === n.id && sel.i === i;
    const d = edgePath(n.pos, t.pos);
    g += `<g class="fe" data-from="${n.id}" data-i="${i}"><path class="fhit" d="${d}"/><path class="fedge ${on ? "sel" : ""} ${e.when?.trim() ? "" : "nowhen"}" d="${d}" marker-end="url(#${on ? "arr-sel" : "arr"})"/><title>${esc(n.title)} → ${esc(t.title)}: ${esc(e.when || "(no condition yet)")}</title></g>`;
  });
  (S.tree.safety_rules || []).forEach((r) => {
    const t = byId[r.goto]; if (!t) return;
    const a = { x: r.pos.x, y: r.pos.y }, x1 = a.x + NW, y1 = a.y + NH / 2, x2 = t.pos.x, y2 = t.pos.y + NH / 2;
    g += `<path class="fedge rule" d="M${x1},${y1} C${x1 + 80},${y1} ${x2 - 80},${y2} ${x2 - 2},${y2}" marker-end="url(#arr-rule)"/>`;
  });
  $("#fedge-g").innerHTML = g;
  $$("#fedge-g .fe").forEach((el) => (el.onmousedown = (ev) => { ev.stopPropagation(); FV.sel = { type: "edge", from: el.dataset.from, i: +el.dataset.i }; drawNodes(); drawEdges(); sidePanel(); }));
}
const toCanvas = (ev) => { const r = $("#tree-diagram").getBoundingClientRect(); return { x: (ev.clientX - r.left - FV.x) / FV.k, y: (ev.clientY - r.top - FV.y) / FV.k }; };
function bindCanvas(box) {
  let drag = null;
  box.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || ev.target.closest(".fzoom")) return;
    const port = ev.target.closest(".fport.out"), node = ev.target.closest(".fnode");
    if (port) { drag = { mode: "link", from: port.closest(".fnode").dataset.id }; ev.preventDefault(); return; }
    if (node) {
      const item = node.dataset.rule != null ? S.tree.safety_rules[+node.dataset.rule] : S.tree.nodes.find((n) => n.id === node.dataset.id);
      const p = toCanvas(ev);
      drag = { mode: "move", node, item, dx: p.x - item.pos.x, dy: p.y - item.pos.y, moved: false };
      ev.preventDefault(); return;
    }
    drag = { mode: "pan", sx: ev.clientX - FV.x, sy: ev.clientY - FV.y, moved: false };
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    if (drag.mode === "pan") { FV.x = ev.clientX - drag.sx; FV.y = ev.clientY - drag.sy; drag.moved = true; applyView(); }
    else if (drag.mode === "move") {
      const p = toCanvas(ev);
      drag.item.pos = { x: Math.round(p.x - drag.dx), y: Math.round(p.y - drag.dy) };
      drag.node.style.left = drag.item.pos.x + "px"; drag.node.style.top = drag.item.pos.y + "px";
      drag.moved = true; drawEdges();
    } else if (drag.mode === "link") {
      const a = S.tree.nodes.find((n) => n.id === drag.from).pos, p = toCanvas(ev);
      $("#ftemp").setAttribute("d", `M${a.x + NW / 2},${a.y + NH} C${a.x + NW / 2},${a.y + NH + 60} ${p.x},${p.y - 60} ${p.x},${p.y}`);
      $$(".fnode").forEach((n) => n.classList.toggle("drop", n === ev.target.closest(".fnode:not(.rule)") && n.dataset.id !== drag.from));
    }
  });
  window.addEventListener("mouseup", (ev) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.mode === "link") {
      $("#ftemp").setAttribute("d", ""); $$(".fnode.drop").forEach((n) => n.classList.remove("drop"));
      const target = ev.target.closest?.(".fnode:not(.rule)");
      if (target && target.dataset.id !== d.from) {
        const src = S.tree.nodes.find((n) => n.id === d.from);
        src.next = src.next || [];
        let i = src.next.findIndex((e) => e.to === target.dataset.id);
        if (i < 0) { src.next.push({ to: target.dataset.id, when: "" }); i = src.next.length - 1; toast("Connected — now say when the agent should take this path."); }
        FV.sel = { type: "edge", from: d.from, i }; drawNodes(); drawEdges(); sidePanel(true);
      }
    } else if (d.mode === "move" && !d.moved) {
      FV.sel = d.node.dataset.rule != null ? { type: "rule", i: +d.node.dataset.rule } : { type: "node", id: d.node.dataset.id };
      S.selectedNode = FV.sel.id || null; drawNodes(); drawEdges(); sidePanel();
    } else if (d.mode === "pan" && !d.moved) { FV.sel = null; S.selectedNode = null; drawNodes(); drawEdges(); sidePanel(); }
  });
  box.addEventListener("wheel", (ev) => { ev.preventDefault(); const r = box.getBoundingClientRect(); zoomAt(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX - r.left, ev.clientY - r.top); }, { passive: false });
  $$(".fzoom button", box).forEach((b) => (b.onclick = () => {
    const r = box.getBoundingClientRect();
    if (b.dataset.z === "in") zoomAt(1.2, r.width / 2, r.height / 2);
    if (b.dataset.z === "out") zoomAt(1 / 1.2, r.width / 2, r.height / 2);
    if (b.dataset.z === "reset") { zoomAt(1 / FV.k, r.width / 2, r.height / 2); }
    if (b.dataset.z === "fit") fitView();
    if (b.dataset.z === "tidy") { autoLayout(true); drawNodes(); drawEdges(); fitView(); }
  }));
}
function zoomAt(f, cx, cy) {
  const k = Math.min(2, Math.max(0.25, FV.k * f));
  FV.x = cx - ((cx - FV.x) * k) / FV.k; FV.y = cy - ((cy - FV.y) * k) / FV.k; FV.k = k; applyView();
}
function fitView() {
  const items = [...S.tree.nodes, ...(S.tree.safety_rules || [])].map((n) => n.pos).filter(Boolean);
  if (!items.length) return;
  const x0 = Math.min(...items.map((p) => p.x)) - 30, y0 = Math.min(...items.map((p) => p.y)) - 30;
  const x1 = Math.max(...items.map((p) => p.x)) + NW + 30, y1 = Math.max(...items.map((p) => p.y)) + NH + 30;
  const r = $("#tree-diagram").getBoundingClientRect();
  FV.k = Math.min(1.2, Math.max(0.25, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
  FV.x = (r.width - (x1 - x0) * FV.k) / 2 - x0 * FV.k; FV.y = (r.height - (y1 - y0) * FV.k) / 2 - y0 * FV.k;
  applyView();
}
function sidePanel(focusWhen = false) {
  const s = FV.sel;
  if (!s) { $("#node-editor").innerHTML = '<div class="empty">Click a step or an arrow to edit it.<br><br>Use <b>Add step</b> to create one.</div>'; return; }
  if (s.type === "node") { S.selectedNode = s.id; return nodeEditor(); }
  if (s.type === "rule") {
    const r = S.tree.safety_rules[s.i];
    $("#node-editor").innerHTML = `<h3 style="margin:0;font-size:17px">⚠ ${esc(r.label)}</h3><p class="help">Checked in code on every caller sentence. Any match jumps straight to the step below.</p>
      <label>Jumps to</label><select id="re-goto">${S.tree.nodes.map((n) => `<option value="${n.id}" ${n.id === r.goto ? "selected" : ""}>${esc(n.title)}</option>`).join("")}</select>
      <label>Safety words</label><textarea id="re-kw" rows="4">${esc(r.keywords.join(", "))}</textarea>`;
    $("#re-goto").onchange = (e) => { r.goto = e.target.value; drawNodes(); drawEdges(); };
    $("#re-kw").oninput = (e) => { r.keywords = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); };
    return;
  }
  const src = S.tree.nodes.find((n) => n.id === s.from), e = src?.next?.[s.i];
  if (!e) { FV.sel = null; return sidePanel(); }
  const tgt = S.tree.nodes.find((n) => n.id === e.to);
  $("#node-editor").innerHTML = `<div class="row"><h3 style="margin:0;font-size:17px">Connection</h3><button class="btn small danger" style="margin-left:auto" id="ee-del">Delete</button></div>
    <p class="muted" style="margin:10px 0 0">${esc(src.title)} <span style="margin:0 6px">→</span> ${esc(tgt?.title || e.to)}</p>
    <label>Go to</label><select id="ee-to">${S.tree.nodes.filter((n) => n.id !== src.id).map((n) => `<option value="${n.id}" ${n.id === e.to ? "selected" : ""}>${esc(n.title)}</option>`).join("")}</select>
    <label>When should the agent take this path?</label><textarea id="ee-when" rows="4" placeholder="e.g. The caller says the heat is out and someone elderly is home.">${esc(e.when || "")}</textarea>
    <p class="help">The agent reads this condition and decides on every turn. It can only move along arrows that exist.</p>`;
  $("#ee-when").oninput = (ev) => { e.when = ev.target.value; drawEdges(); };
  $("#ee-to").onchange = (ev) => { e.to = ev.target.value; drawEdges(); sidePanel(); };
  $("#ee-del").onclick = () => { src.next.splice(s.i, 1); FV.sel = null; drawEdges(); sidePanel(); };
  if (focusWhen) $("#ee-when").focus();
}
window.selectNode = (id) => { FV.sel = { type: "node", id }; S.selectedNode = id; drawNodes(); drawEdges(); sidePanel(); };
document.addEventListener("keydown", (ev) => {
  if (!$("#page-agent").classList.contains("active") || $("#agent-map").classList.contains("hidden")) return;
  if (!["Delete", "Backspace"].includes(ev.key) || ev.target.closest("input,textarea,select")) return;
  const s = FV.sel; if (!s) return;
  ev.preventDefault();
  if (s.type === "edge") { const src = S.tree.nodes.find((n) => n.id === s.from); src.next.splice(s.i, 1); }
  else if (s.type === "node") {
    if (s.id === S.tree.start) return toast("This is the start step — pick another start step first.", true);
    const n = S.tree.nodes.find((x) => x.id === s.id);
    if (!confirm(`Delete "${n.title}" and every arrow into it?`)) return;
    S.tree.nodes = S.tree.nodes.filter((x) => x.id !== s.id); S.tree.nodes.forEach((x) => (x.next = (x.next || []).filter((e) => e.to !== s.id)));
  } else return;
  FV.sel = null; S.selectedNode = null; drawNodes(); drawEdges(); sidePanel();
});

function nodeEditor() {
  const n = S.tree.nodes.find((x) => x.id === S.selectedNode);
  if (!n) return ($("#node-editor").innerHTML = '<div class="empty">Select a step in the diagram.</div>');
  const ids = S.tree.nodes.map((x) => x.id);
  $("#node-editor").innerHTML = `
    <div class="row"><h3 style="margin:0;font-size:17px">${esc(n.title)}</h3>${S.tree.start === n.id ? '<span class="pill green">Start</span>' : ""}<button class="btn small danger" style="margin-left:auto" id="ne-del">Delete</button></div>
    <label>Title</label><input id="ne-title" value="${esc(n.title)}">
    <label>Type</label><select id="ne-type"><option value="ai">Conversation</option><option value="transfer">Transfer the call</option><option value="end">End the call</option></select>
    <label>What the agent does here</label><textarea id="ne-instr" rows="7">${esc(n.instructions)}</textarea>
    <label>Information to collect</label><div class="chips" id="ne-collect">${S.boot.note_fields.map((f) => `<span class="chip ${(n.collect || []).includes(f.key) ? "on" : ""}" data-k="${f.key}">${esc(f.label)}</span>`).join("")}</div>
    <label>Next steps</label><div id="ne-edges">${(n.next || []).map((e, i) => `<div class="edge-row"><select data-i="${i}" class="ne-to">${ids.map((id) => `<option ${id === e.to ? "selected" : ""} value="${id}">${esc(S.tree.nodes.find((x) => x.id === id).title)}</option>`).join("")}</select><input data-i="${i}" class="ne-when" value="${esc(e.when)}" placeholder="when…"><button class="btn small plain ne-x" data-i="${i}">✕</button></div>`).join("") || '<p class="help" style="margin:0">No arrows — this step ends here.</p>'}</div>
    <button class="btn small plain" id="ne-add-edge" style="margin-top:4px">+ Add arrow</button>
    <label class="row" style="gap:8px;margin-top:16px;color:var(--ink)"><input type="checkbox" id="ne-start" style="width:auto" ${S.tree.start === n.id ? "checked" : ""}>Calls start at this step</label>`;
  $("#ne-type").value = n.type;
  $("#ne-title").oninput = (e) => { n.title = e.target.value; drawNodes(); drawEdges(); };
  $("#ne-type").onchange = (e) => { n.type = e.target.value; renderTree(); };
  $("#ne-instr").oninput = (e) => (n.instructions = e.target.value);
  $$("#ne-collect .chip").forEach((c) => (c.onclick = () => { const k = c.dataset.k; n.collect = (n.collect || []).includes(k) ? n.collect.filter((x) => x !== k) : [...(n.collect || []), k]; c.classList.toggle("on"); }));
  $$(".ne-to").forEach((s) => (s.onchange = () => { n.next[+s.dataset.i].to = s.value; renderTree(); }));
  $$(".ne-when").forEach((s) => (s.oninput = () => (n.next[+s.dataset.i].when = s.value)));
  $$(".ne-x").forEach((b) => (b.onclick = () => { n.next.splice(+b.dataset.i, 1); renderTree(); }));
  $("#ne-add-edge").onclick = () => { n.next = n.next || []; n.next.push({ to: ids[0], when: "" }); renderTree(); };
  $("#ne-start").onchange = (e) => { if (e.target.checked) S.tree.start = n.id; renderTree(); };
  $("#ne-del").onclick = () => { if (n.id === S.tree.start) return toast("This is the start step — pick another start step first.", true); if (!confirm(`Delete "${n.title}" and every arrow into it?`)) return; S.tree.nodes = S.tree.nodes.filter((x) => x.id !== n.id); S.tree.nodes.forEach((x) => (x.next = (x.next || []).filter((e) => e.to !== n.id))); S.selectedNode = null; FV.sel = null; drawNodes(); drawEdges(); sidePanel(); };
}
$("#btn-tree-add").onclick = () => {
  let i = 1, id = "new_step";
  while (S.tree.nodes.some((n) => n.id === id)) id = `new_step_${++i}`;
  const r = $("#tree-diagram").getBoundingClientRect();
  const c = { x: (r.width / 2 - FV.x) / FV.k - NW / 2, y: (r.height / 2 - FV.y) / FV.k - NH / 2 };
  const end = S.tree.nodes.find((n) => n.type === "end");
  S.tree.nodes.push({ id, title: i > 1 ? `New step ${i}` : "New step", type: "ai", instructions: "Describe what the agent should say or ask here.", collect: [],
    next: end ? [{ to: end.id, when: "This step is done." }] : [], pos: { x: Math.round(c.x), y: Math.round(c.y) } });
  FV.sel = { type: "node", id }; S.selectedNode = id;
  drawNodes(); drawEdges(); sidePanel();
  $("#ne-title")?.select();
  toast("Step added — drag from another step's bottom dot onto it to connect.");
};
$("#btn-tree-save").onclick = async () => { $("#tree-errors").textContent = ""; try { await api("/api/tree", { method: "POST", body: S.tree }); S.boot.tree = S.tree; toast("Call flow saved — new calls use it right away."); } catch (e) { $("#tree-errors").textContent = "Not saved:\n• " + (e.data?.errors || [e.message]).join("\n• "); } };
$("#btn-tree-reset").onclick = async () => { if (!confirm("Restore the default call flow?")) return; S.tree = await api("/api/tree/reset", { method: "POST" }); S.selectedNode = null; FV.sel = null; renderTree(); fitView(); toast("Default call flow restored."); };
$("#btn-tree-export").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(S.tree, null, 2)], { type: "application/json" })); a.download = "call_flow.json"; a.click(); };
$("#tree-import").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    let t = JSON.parse(await f.text());
    if (t.conversationFlow || (t.nodes && t.start_node_id)) {  // Retell AI agent export
      const brand = prompt("Imported from Retell. Business name used in that script (it will be replaced with your company name). Leave empty to keep the text as-is.", "") || "";
      const r = await api("/api/tree/import-retell", { method: "POST", body: { export: t, brand } });
      t = r.tree;
      // keep our safety words only if the imported flow has a step for them to jump to
      if (!t.safety_rules?.length) t.safety_rules = (S.tree.safety_rules || []).filter((r) => t.nodes.some((n) => n.id === r.goto));
      if (!t.safety_rules.length) toast("Imported flow has no emergency step — add one so safety words can jump to it.", true);
      toast(`Converted ${t.nodes.length} Retell nodes into steps`);
    }
    const { errors } = await api("/api/tree/validate", { method: "POST", body: t }); if (errors.length) $("#tree-errors").textContent = "Imported flow has problems:\n• " + errors.join("\n• "); S.tree = t; S.selectedNode = null; FV.sel = null; renderTree(); fitView(); toast("Imported — review it, then Save."); }
  catch (err) { toast("Not a valid call-flow file: " + err.message, true); }
  e.target.value = "";
};

/* ---------------- settings ---------------- */
const SET_KEYS = ["reminder_after_s", "reminder_max", "max_call_minutes", "agent_name", "greeting", "persona", "habits", "voice_lang", "voice_name", "speech_rate", "speech_pitch", "response_delay_ms", "use_fillers", "answering_mode", "forward_number", "notify_min_priority", "reasoning_effort", "per_call_budget_usd", "max_turns"];
function fillVoiceSelect() {
  const lang = $("#s-voice_lang").value;
  const list = S.voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
  $("#s-voice_name").innerHTML = `<option value="">Default for this accent</option>` + list.map((v) => `<option ${v.name === S.settings.voice_name ? "selected" : ""} value="${esc(v.name)}">${esc(v.name)}</option>`).join("") + (list.length ? "" : `<option disabled>No ${lang} voices on this computer</option>`);
}
LOADERS.settings = () => {
  const s = S.settings;
  const nm = s.notify_manager === "emergencies" ? "priority" : s.notify_manager;
  $$("#notify-seg button").forEach((b) => b.classList.toggle("on", b.dataset.n === nm));
  $("#notify-prio-wrap").classList.toggle("hidden", nm !== "priority");
  for (const k of SET_KEYS) { const el = $("#s-" + k); if (el) el.type === "checkbox" ? (el.checked = !!s[k]) : (el.value = s[k]); }
  $("#s-fillers").value = (s.fillers || []).join(" | ");
  $("#s-pron").value = (s.pronunciations || []).map((p) => `${p.word} = ${p.say}`).join("\n");
  $("#bh-start").value = s.business_hours.start; $("#bh-end").value = s.business_hours.end;
  $("#bh-days").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<span class="chip ${s.business_hours.days.includes(d) ? "on" : ""}" data-d="${d}">${d}</span>`).join("");
  $$("#bh-days .chip").forEach((c) => (c.onclick = () => c.classList.toggle("on")));
  fillVoiceSelect();
  $("#v-rate").textContent = (+s.speech_rate).toFixed(2); $("#v-pitch").textContent = (+s.speech_pitch).toFixed(2);
};
$$("#notify-seg button").forEach((b) => (b.onclick = () => { $$("#notify-seg button").forEach((x) => x.classList.toggle("on", x === b)); $("#notify-prio-wrap").classList.toggle("hidden", b.dataset.n !== "priority"); }));
$("#s-voice_lang").onchange = () => { S.settings.voice_name = ""; fillVoiceSelect(); };
$("#s-speech_rate").oninput = (e) => ($("#v-rate").textContent = (+e.target.value).toFixed(2));
$("#s-speech_pitch").oninput = (e) => ($("#v-pitch").textContent = (+e.target.value).toFixed(2));
function readSettings() {
  const out = {};
  for (const k of SET_KEYS) { const el = $("#s-" + k); if (el) out[k] = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? +el.value : el.value; }
  out.fillers = $("#s-fillers").value.split("|").map((x) => x.trim()).filter(Boolean);
  out.pronunciations = $("#s-pron").value.split("\n").map((l) => l.split("=")).filter((p) => p.length === 2 && p[0].trim() && p[1].trim()).map(([w, x]) => ({ word: w.trim(), say: x.trim() }));
  out.notify_manager = $("#notify-seg .on")?.dataset.n || "priority";
  out.business_hours = { start: $("#bh-start").value, end: $("#bh-end").value, days: $$("#bh-days .chip.on").map((c) => c.dataset.d) };
  return out;
}
$("#btn-voice-test").onclick = () => { const prev = S.settings, was = $("#opt-voice").checked; S.settings = { ...S.settings, ...readSettings() }; $("#opt-voice").checked = true; speak(`Hi, this is ${S.settings.agent_name} from ${S.boot.business.company_name}. How can I help you tonight?`).then(() => { S.settings = prev; $("#opt-voice").checked = was; }); };
$("#btn-settings-save").onclick = async () => { try { S.settings = await api("/api/settings", { method: "POST", body: readSettings() }); $("#agent-title").textContent = S.settings.agent_name; footAgent(); toast("Agent settings saved"); } catch (e) { toast(e.message, true); } };
$("#btn-demo-reset").onclick = async () => { if (!confirm("Delete all calls, alerts and reports and reload the demo data?")) return; const r = await api("/api/demo/reset", { method: "POST", body: { sample_night: true } }); toast(`Demo reset · ${r.sample_calls} sample calls loaded`); counts(); };


/* ---------------- live monitoring ---------------- */
const stepTitle = (id) => S.tree?.nodes.find((n) => n.id === id)?.title || id || "";
const since = (iso) => { if (!iso) return ""; const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
async function pollLive() {
  let r;
  try { r = await api("/api/live"); } catch { return; }
  S.live = r.calls;
  const n = r.calls.filter((c) => c.status === "active").length;
  $("#n-live").textContent = n || "";
  $("#live-dot").classList.toggle("hidden", !n);
  if ($("#page-live").classList.contains("active")) renderBoard($("#live-board"), true);
  if ($("#page-test").classList.contains("active")) { renderBoard($("#sim-board"), false); if (n || r.queued) loadGenerated(); $("#sim-sub").textContent = `${r.simulated_running} of ${r.lines} lines busy${r.queued ? ` · ${r.queued} waiting` : ""}`; }
}
function renderBoard(el, selectable) {
  const calls = S.live || [];
  if (!calls.length) { el.innerHTML = `<div class="empty" style="grid-column:1/-1">No calls on the line right now.${selectable ? '<br><br><button class="btn primary" data-goto="test">Start test calls</button>' : ""}</div>`; return; }
  el.innerHTML = calls.map((c) => {
    const last = c.pending ? { role: "caller", text: c.pending } : c.last;
    return `<div class="lcard ${S.listenId === c.id ? "on" : ""} ${c.status !== "active" ? "ending" : ""}" data-id="${c.id}">
      <div class="who">${c.status === "active" ? '<span class="live-dot"></span>' : ""}${esc(c.caller_name || c.caller_id)}<span class="muted small" style="margin-left:auto;font-weight:400">${since(c.real_started_at)}</span></div>
      <div class="meta"><span>#${c.id}</span><span>${esc(stepTitle(c.step))}</span>${c.scenario ? `<span>· ${esc(c.scenario)}</span>` : '<span>· person testing</span>'}</div>
      <div class="line">${last ? `<b>${last.role === "agent" ? esc(S.settings.agent_name) : "Caller"}:</b> ${esc(last.text)}` : ""}</div>
      <div class="tags">${c.emergency ? '<span class="pill red">Emergency</span>' : ""}${c.attack ? '<span class="pill orange">Manipulation flagged</span>' : ""}${c.held_window ? '<span class="pill blue">Visit held</span>' : ""}${c.trade ? `<span class="pill">${esc(TRADE[c.trade] || c.trade)}</span>` : ""}${c.status !== "active" ? '<span class="pill">Writing log…</span>' : ""}${S.listenId === c.id ? '<span class="pill green"><span class="wave"><i></i><i></i><i></i><i></i></span> Listening</span>' : ""}</div>
    </div>`;
  }).join("");
  if (selectable) $$(".lcard", el).forEach((c) => (c.onclick = () => startListening(+c.dataset.id)));
  else $$(".lcard", el).forEach((c) => (c.onclick = () => { show("live"); startListening(+c.dataset.id); }));
}
LOADERS.live = () => { pollLive(); if (!S.listenId) $("#live-sub").textContent = ""; };

let listenTimer = null;
function stopListen() {
  clearInterval(listenTimer); listenTimer = null; S.listenId = null; S.listenQueue = []; speechSynthesis.cancel();
  $("#listen").innerHTML = '<div class="empty">Select a call to listen in.<br><br>Audio plays through your speakers — the agent and caller use different voices.</div>';
  renderBoard($("#live-board"), true);
}
async function startListening(id) {
  if (S.listenId === id) return;
  stopListen();
  S.listenId = id; S.listenSeen = 0; S.listenQueue = []; S.listenSpeaking = false;
  $("#listen").innerHTML = `<div class="lhead"><div class="row"><b id="ls-who">Call #${id}</b><span class="pill green" style="margin-left:auto"><span class="wave"><i></i><i></i><i></i><i></i></span> Listening</span></div><div class="muted small" id="ls-meta"></div></div>
    <div class="transcript" id="ls-tr"></div>
    <div class="lfoot"><label class="row" style="margin:0;gap:6px;color:var(--ink)"><input type="checkbox" id="ls-audio" style="width:auto" checked>Audio</label><button class="btn small" onclick="openCall(${id})">Full record</button><button class="btn small" style="margin-left:auto" id="ls-stop">Stop listening</button></div>`;
  $("#ls-stop").onclick = stopListen;
  $("#ls-audio").onchange = (e) => { if (!e.target.checked) { speechSynthesis.cancel(); S.listenQueue = []; } };
  renderBoard($("#live-board"), true);
  // Join mid-call like a real monitor: show history, speak only what is said from now on.
  const first = await api(`/api/live/${id}?since=0`);
  if (S.listenId !== id) return;
  addListenLines(first.lines, false);
  S.listenSeen = first.lines.filter((l) => !l.pending).length;
  updateListenHead(first);
  listenTimer = setInterval(async () => {
    if (S.listenId !== id) return;
    const r = await api(`/api/live/${id}?since=${S.listenSeen}`).catch(() => null);
    if (!r || S.listenId !== id) return;
    const fresh = r.lines.filter((l) => !l.pending);
    const pend = r.lines.find((l) => l.pending);
    if (fresh.length) { addListenLines(fresh, true); S.listenSeen += fresh.length; }
    if (pend && !(S.lastPending === pend.text)) { S.lastPending = pend.text; addListenLines([pend], true); }
    updateListenHead(r);
    if (r.status === "completed") { clearInterval(listenTimer); $("#ls-tr").insertAdjacentHTML("beforeend", '<div class="event">Call ended</div>'); }
  }, 900);
}
function updateListenHead(r) {
  const n = r.notes || {};
  $("#ls-who").textContent = `${n.caller_name || r.caller_id || "Caller"} · #${r.id}`;
  $("#ls-meta").textContent = [stepTitle(r.step), n.town, n.held_window ? "visit held: " + n.held_window : null].filter(Boolean).join(" · ");
}
function addListenLines(lines, speakIt) {
  const tr = $("#ls-tr");
  for (const l of lines) {
    // a caller line is published while it is being "spoken"; skip it when it lands in the transcript
    if (!l.pending && l.role === "caller" && S.lastPending === l.text) { S.lastPending = null; continue; }
    tr.insertAdjacentHTML("beforeend", `<div class="bubble ${l.role}"><span class="meta">${l.role === "agent" ? esc(S.settings.agent_name) : "Caller"}</span>${esc(l.text)}</div>`);
    if (speakIt && $("#ls-audio")?.checked) S.listenQueue.push(l);
  }
  tr.scrollTop = tr.scrollHeight;
  drainListen();
}
async function drainListen() {
  if (S.listenSpeaking) return;
  S.listenSpeaking = true;
  while (S.listenQueue?.length) {
    const l = S.listenQueue.shift();
    const was = $("#opt-voice").checked; $("#opt-voice").checked = true;
    await speak(l.text, l.role === "agent" ? "agent" : "caller");
    $("#opt-voice").checked = was;
  }
  S.listenSpeaking = false;
}

/* ---------------- test: simulate many calls ---------------- */
LOADERS.test = () => {
  loadGenerated();
  if (!$("#sim-scen").children.length) {
    $("#sim-scen").innerHTML = S.boot.scenarios.map((sc) => `<span class="chip" data-id="${sc.id}">${esc(sc.title)}</span>`).join("");
    $$("#sim-scen .chip").forEach((c) => (c.onclick = () => c.classList.toggle("on")));
  }
  pollLive();
};
$$("#test-tabs button").forEach((b) => (b.onclick = () => {
  $$("#test-tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $("#test-sim").classList.toggle("hidden", b.dataset.tab !== "sim");
  $("#test-self").classList.toggle("hidden", b.dataset.tab !== "self");
}));
$("#sim-n").oninput = (e) => ($("#sim-n-v").textContent = e.target.value);
$$("#sim-mode button").forEach((b) => (b.onclick = () => {
  $$("#sim-mode button").forEach((x) => x.classList.toggle("on", x === b));
  $("#sim-cards").classList.toggle("hidden", b.dataset.m !== "cards");
  $("#sim-mode-help").textContent = b.dataset.m === "invent" ? "Every call gets a brand-new person and situation, never a repeat." : "Reuse the fixed scenario cards (good for repeatable tests and the eval script).";
}));
const SIT = { repair: "Repair", urgent_repair: "Urgent repair", emergency: "Emergency", upgrade: "Upgrade / quote", maintenance: "Maintenance", billing: "Billing", person: "Asks for a person", not_offered: "Service not offered", out_of_area: "Out of area", attack: "Attack", wrong_number: "Wrong number" };
async function loadGenerated() {
  const r = await api("/api/generated");
  $("#gen-sub").textContent = `${r.callers.length} invented · also saved to ${r.log_file}`;
  $("#gen-list").innerHTML = r.callers.length ? `<table><thead><tr><th>Invented</th><th>Caller</th><th>Situation</th><th>Town</th><th></th></tr></thead><tbody>${r.callers.slice(0, 25).map((g) => `<tr ${g.call_id ? `class="click" onclick="openCall(${g.call_id})"` : ""}>
    <td class="muted small" style="width:120px">${when(g.ts)}</td>
    <td style="width:200px"><b style="font-weight:500">${esc(g.name)}</b><div class="sub">${esc(g.phone)}</div></td>
    <td>${esc(g.title)}<div class="sub">${esc(g.persona).slice(0, 110)}</div></td>
    <td style="width:120px">${esc(g.town)}</td>
    <td style="width:150px;text-align:right">${["emergency", "attack"].includes(g.situation) ? `<span class="pill ${g.situation === "emergency" ? "red" : "orange"}">${esc(SIT[g.situation])}</span>` : `<span class="pill">${esc(SIT[g.situation] || g.situation)}</span>`}${g.call_id ? `<div class="sub">call #${g.call_id}</div>` : ""}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">No invented callers yet. Start some test calls.</div>';
}
["#sim-pace", "#sim-spread"].forEach((id) => $$(id + " button").forEach((b) => (b.onclick = () => $$(id + " button").forEach((x) => x.classList.toggle("on", x === b)))));
$("#btn-sim-go").onclick = async () => {
  const body = { n: +$("#sim-n").value, pace: $("#sim-pace .on").dataset.p, spread_s: +$("#sim-spread .on").dataset.s, mode: $("#sim-mode .on").dataset.m, scenarios: $$("#sim-scen .chip.on").map((c) => c.dataset.id) };
  try { const r = await api("/api/simulate", { method: "POST", body }); toast(r.launched > 3 ? `${r.launched} test calls queued — 3 at a time` : `${r.launched} test calls started`); setTimeout(pollLive, 800); }
  catch (e) { toast(e.message, true); }
};
$("#btn-sim-stop").onclick = async () => { const r = await api("/api/simulate/stop", { method: "POST" }); toast(`Stopped ${r.stopped} calls`); pollLive(); };

/* ---------------- schedule: calendar ---------------- */
const DAY0 = 7, DAY1 = 18, HPX = 52;   // 7 AM – 6 PM, pixels per hour
const SLOT_H = { AM: [8, 11], MID: [11, 14], PM: [14, 17] };
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monday = (d) => addDays(d, -d.getDay());  // weeks start on Sunday
const initials = (n) => n.split(" ").map((w) => w[0]).join("");
S.cal = { view: "week", date: new Date(), hidden: new Set() };
LOADERS.team = async () => {
  const v = S.cal.view, d = S.cal.date;
  let start, days;
  if (v === "day") { start = d; days = 1; }
  else if (v === "week") { start = monday(d); days = 7; }
  else { start = monday(new Date(d.getFullYear(), d.getMonth(), 1)); days = 42; }
  const g = await api(`/api/schedule?start=${iso(start)}&days=${days}`);
  S.cal.data = g;
  const techs = g.technicians;
  $("#cal-techs").innerHTML = techs.map((t) => `<span class="tchip ${S.cal.hidden.has(t.id) ? "off" : ""}" data-id="${t.id}"><i style="background:${t.color}"></i>${esc(t.name)}</span>`).join("") + '<span class="tchip legend-hold" style="cursor:default"><i></i>Offered on a call (tentative)</span>';
  $$("#cal-techs .tchip[data-id]").forEach((c) => (c.onclick = () => { S.cal.hidden.has(c.dataset.id) ? S.cal.hidden.delete(c.dataset.id) : S.cal.hidden.add(c.dataset.id); LOADERS.team(); }));
  $$("#cal-view button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  const fmt = (o) => start.toLocaleDateString([], o);
  $("#cal-title").textContent = v === "day" ? d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : v === "week" ? `${fmt({ month: "short", day: "numeric" })} – ${addDays(start, 6).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`
    : d.toLocaleDateString([], { month: "long", year: "numeric" });
  const visible = techs.filter((t) => !S.cal.hidden.has(t.id));
  const tmap = Object.fromEntries(techs.map((t) => [t.id, t]));
  const jobs = g.jobs.filter((j) => !S.cal.hidden.has(j.tech_id));
  if (v === "month") return renderMonth(start, jobs, tmap);
  renderTimeGrid(v, start, days, visible, jobs, tmap);
};
function evHtml(j, t, style, row = 0, rows = 1) {
  const [h0, h1] = SLOT_H[j.slot];
  const band = (h1 - h0) * HPX, rh = band / rows;
  const top = (h0 - DAY0) * HPX + row * rh + 1;
  const compact = rows > 2;
  return `<div class="ev ${j.source === "hold" ? "hold" : ""} ${compact ? "compact" : ""}" data-job="${esc(j.job_id)}" title="${esc(t.name)} · ${esc(j.title)} · ${esc(j.customer)}, ${esc(j.town)}" style="${style};top:${top}px;height:${rh - 3}px;background:${t.color}1a;border-left-color:${t.color}">
    <b>${esc(initials(t.name))}</b> <span class="t">${esc(j.title)}</span>${compact ? "" : `<div class="s">${esc(j.customer)} · ${esc(j.town)}</div>${j.source === "hold" ? '<div class="s" style="color:var(--blue)">Offered on call</div>' : ""}`}</div>`;
}
function renderTimeGrid(v, start, days, visible, jobs, tmap) {
  const today = iso(new Date());
  const cols = v === "day" ? visible.map((t) => ({ key: t.id, label: `<div class="tname"><i style="width:10px;height:10px;border-radius:2px;background:${t.color};display:inline-block"></i>${esc(t.name)}</div><div style="margin-top:2px;font-size:11.5px">${esc(t.trades.map((x) => TRADE[x] || x).join(", "))}</div>`, date: iso(start), tech: t }))
    : [...Array(days)].map((_, i) => { const d = addDays(start, i); return { key: iso(d), date: iso(d), label: `${d.toLocaleDateString([], { weekday: "short" })}<b>${d.getDate()}</b>`, today: iso(d) === today }; });
  const tpl = `64px repeat(${cols.length}, minmax(${v === "day" ? 150 : 120}px, 1fr))`;
  const H = (DAY1 - DAY0) * HPX;
  const hours = [...Array(DAY1 - DAY0 + 1)].map((_, i) => DAY0 + i);
  const lines = hours.map((h) => `<div class="hline ${[8, 11, 14, 17].includes(h) ? "slot" : ""}" style="top:${(h - DAY0) * HPX}px"></div>`).join("");
  const dayName = (ds) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(ds + "T12:00").getDay()];
  const body = cols.map((c) => {
    let evs = "";
    if (v === "day") {
      const off = !c.tech.work_days.includes(dayName(c.date));
      evs = jobs.filter((j) => j.tech_id === c.tech.id && j.date === c.date).map((j) => evHtml(j, c.tech, "left:4px;right:4px")).join("");
      return `<div class="cal-col ${off ? "off" : ""}" style="height:${H}px">${lines}${evs}</div>`;
    }
    const dj = jobs.filter((j) => j.date === c.date);
    for (const slot of ["AM", "MID", "PM"]) {
      const sj = dj.filter((j) => j.slot === slot).sort((a, b) => a.tech_id.localeCompare(b.tech_id));
      sj.forEach((j, i) => { evs += evHtml(j, tmap[j.tech_id], "left:3px;right:3px", i, sj.length); });
    }
    return `<div class="cal-col" style="height:${H}px">${lines}${evs}</div>`;
  }).join("");
  const now = new Date(), nowH = now.getHours() + now.getMinutes() / 60;
  const showNow = cols.some((c) => c.date === today) && nowH >= DAY0 && nowH <= DAY1;
  $("#calendar").innerHTML = `<div class="cal-grid"><div class="cal-head" style="grid-template-columns:${tpl}"><div></div>${cols.map((c) => `<div class="${c.today ? "today" : ""}">${c.label}</div>`).join("")}</div>
    <div class="cal-body" style="grid-template-columns:${tpl}"><div class="cal-times" style="height:${H}px">${hours.map((h) => `<span style="top:${(h - DAY0) * HPX}px">${h % 12 || 12} ${h < 12 ? "AM" : "PM"}</span>`).join("")}</div>${body}
    ${showNow ? `<div class="now-line" style="top:${(nowH - DAY0) * HPX}px;left:64px"></div>` : ""}</div></div>`;
  bindEvents(jobs, tmap);
}
function renderMonth(start, jobs, tmap) {
  const m = S.cal.date.getMonth(), today = iso(new Date());
  const cells = [...Array(42)].map((_, i) => {
    const d = addDays(start, i), ds = iso(d), dj = jobs.filter((j) => j.date === ds).sort((a, b) => (a.source === "hold" ? -1 : 0) - (b.source === "hold" ? -1 : 0) || "AM MID PM".indexOf(a.slot) - "AM MID PM".indexOf(b.slot));
    const show = dj.slice(0, 4);
    return `<div class="day ${d.getMonth() !== m ? "other" : ""} ${ds === today ? "today" : ""}" data-date="${ds}"><div class="num"><span>${d.getDate()}</span></div>
      ${show.map((j) => { const t = tmap[j.tech_id]; return `<div class="mev ${j.source === "hold" ? "hold" : ""}" data-job="${esc(j.job_id)}" style="${j.source === "hold" ? "" : `background:${t.color}1a;border-left-color:${t.color}`}"><b>${esc(initials(t.name))}</b> ${esc(j.title)}</div>`; }).join("")}
      ${dj.length > 4 ? `<div class="more">+${dj.length - 4} more</div>` : ""}</div>`;
  }).join("");
  $("#calendar").innerHTML = `<div class="month">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="dow">${d}</div>`).join("")}${cells}</div>`;
  $$("#calendar .day").forEach((c) => (c.onclick = (e) => { if (e.target.closest("[data-job]")) return; S.cal.date = new Date(c.dataset.date + "T12:00"); S.cal.view = "day"; LOADERS.team(); }));
  bindEvents(jobs, tmap);
}
function bindEvents(jobs, tmap) {
  $$("#calendar [data-job]").forEach((el) => (el.onclick = (e) => {
    e.stopPropagation();
    const j = jobs.find((x) => x.job_id === el.dataset.job), t = tmap[j.tech_id];
    $(".pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "pop";
    pop.innerHTML = `<div class="row"><i style="width:10px;height:10px;border-radius:2px;background:${t.color};display:inline-block"></i><h4>${esc(j.title)}</h4></div>
      <div class="muted small">${new Date(j.date + "T12:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })} · ${{ AM: "8–11 AM", MID: "11 AM–2 PM", PM: "2–5 PM" }[j.slot]}</div>
      <dl class="kv"><dt>Technician</dt><dd>${esc(t.name)} (${esc(t.level)})</dd><dt>Customer</dt><dd>${esc(j.customer)}</dd><dt>Town</dt><dd>${esc(j.town)}</dd><dt>Status</dt><dd>${j.source === "hold" ? '<span class="pill blue">Offered on an after-hours call — tentative</span>' : "Booked"}</dd></dl>
      ${j.call_id ? `<button class="btn small primary" style="margin-top:14px" onclick="openCall(${j.call_id});this.closest('.pop').remove()">Open the call</button>` : ""}`;
    document.body.appendChild(pop);
    const r = el.getBoundingClientRect();
    pop.style.left = Math.min(window.innerWidth - 320, r.right + 8) + "px";
    pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 10, r.top) + "px";
  }));
}
document.addEventListener("click", (e) => { if (!e.target.closest(".pop")) $(".pop")?.remove(); });
$$("#cal-view button").forEach((b) => (b.onclick = () => { S.cal.view = b.dataset.v; LOADERS.team(); }));
$("#cal-today").onclick = () => { S.cal.date = new Date(); LOADERS.team(); };
$("#cal-prev").onclick = () => { const v = S.cal.view, d = S.cal.date; S.cal.date = v === "day" ? addDays(d, -1) : v === "week" ? addDays(d, -7) : new Date(d.getFullYear(), d.getMonth() - 1, 1); LOADERS.team(); };
$("#cal-next").onclick = () => { const v = S.cal.view, d = S.cal.date; S.cal.date = v === "day" ? addDays(d, 1) : v === "week" ? addDays(d, 7) : new Date(d.getFullYear(), d.getMonth() + 1, 1); LOADERS.team(); };

boot().catch((e) => toast("Could not start: " + e.message, true));
