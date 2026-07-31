const FALLBACK_STATUSES = [
  { key: "todo", label: "Por hacer", color: "#deded5", sort_order: 10, active: true, system_key: true, is_done: false },
  { key: "in_progress", label: "En progreso", color: "#205db8", sort_order: 20, active: true, system_key: false, is_done: false },
  { key: "needs_help", label: "Necesita ayuda", color: "#ffde00", sort_order: 30, active: true, system_key: false, is_done: false },
  { key: "done", label: "Done", color: "#0a8f5a", sort_order: 90, active: true, system_key: true, is_done: true },
];

const RECURRENCE = {
  "7d": "Cada 7 días",
  "14d": "Cada 14 días",
  monthly: "1 vez al mes",
};

const state = {
  auth: null,
  user: null,
  users: [],
  categories: [],
  statuses: [],
  tasks: [],
  userWorkload: { users: [], statuses: [] },
  monthlyGoals: { users: [], goals: [], month: "", selected_user_id: null, can_manage: false, total_completion: 0 },
  okrs: { periods: [], can_manage: false },
  activeView: "mine",
  dueWindow: "",
  sidebarCollapsed: localStorage.getItem("sidebarCollapsed") === "1",
  notesMode: "notes",
};

sessionStorage.removeItem("taskAuth");

const $ = (selector) => document.querySelector(selector);

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 3000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatInlineText(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<u>$1</u>")
    .replace(/(^|\s)_([^_\n]+)_/g, "$1<em>$2</em>");
}

function formatRichText(value) {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listType = "";
  const closeList = () => {
    if (listType) html += `</${listType}>`;
    listType = "";
  };
  const openList = (type) => {
    if (listType === type) return;
    closeList();
    listType = type;
    html += `<${type}>`;
  };
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      return;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)/);
    if (bullet) {
      openList("ul");
      html += `<li>${formatInlineText(bullet[1])}</li>`;
      return;
    }
    if (numbered) {
      openList("ol");
      html += `<li>${formatInlineText(numbered[1])}</li>`;
      return;
    }
    closeList();
    html += `<p>${formatInlineText(trimmed)}</p>`;
  });
  closeList();
  return html || "<p></p>";
}

function formatDate(value) {
  if (!value) return "Sin fecha";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("es-VE", { month: "short", day: "numeric" });
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function nextBusinessDate(date) {
  const copy = new Date(date);
  while (copy.getDay() === 0 || copy.getDay() === 6) {
    copy.setDate(copy.getDate() + 1);
  }
  return copy;
}

function addRecurrenceInterval(date, interval) {
  const copy = new Date(date);
  if (interval === "7d") copy.setDate(copy.getDate() + 7);
  if (interval === "14d") copy.setDate(copy.getDate() + 14);
  if (interval === "monthly") copy.setMonth(copy.getMonth() + 1);
  return copy;
}

function defaultRecurrenceNext(interval) {
  return isoDate(nextBusinessDate(addRecurrenceInterval(new Date(), interval)));
}

function currentMonth() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(value) {
  if (!value) return "";
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value;
  const label = new Date(year, month - 1, 1).toLocaleDateString("es-ES", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function isGoalManager() {
  return ["admin", "manager"].includes(state.user?.role);
}

function isOkrManager() {
  return state.user?.role === "admin";
}

function isSoon(value) {
  if (!value) return false;
  const due = new Date(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = (due - today) / 86400000;
  return days >= 0 && days <= 3;
}

function isOverdue(value, status) {
  if (!value || isDoneStatus(status)) return false;
  const due = new Date(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.auth?.token) headers.Authorization = `Bearer ${state.auth.token}`;
  const response = await fetch(path, { headers, ...options });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    if (response.status === 401) {
      sessionStorage.removeItem("taskAuth");
      state.auth = null;
      showLogin();
    }
    throw new Error(payload.details || payload.error || "Request falló");
  }
  return payload;
}

async function readFile(input) {
  const file = input.files[0];
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, data: reader.result });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function allStatuses() {
  return (state.statuses.length ? state.statuses : FALLBACK_STATUSES)
    .slice()
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || String(a.label).localeCompare(String(b.label)));
}

function activeStatuses(selected = "") {
  return allStatuses().filter((status) => status.active || String(status.key) === String(selected));
}

function isDoneStatus(value) {
  const status = allStatuses().find((item) => item.key === value);
  return Boolean(status?.is_done) || value === "done";
}

function statusOptions(selected = "") {
  return activeStatuses(selected).map((status) => `<option value="${status.key}" ${status.key === selected ? "selected" : ""}>${escapeHtml(status.label)}</option>`).join("");
}

function filterStatusOptions() {
  return activeStatuses().map((status) => `<option value="${status.key}">${escapeHtml(status.label)}</option>`).join("");
}

function categoryOptions(selected = "") {
  const base = `<option value="">Sin categoría</option>`;
  return base + state.categories
    .filter((category) => category.active || String(category.id) === String(selected))
    .map((category) => `<option value="${category.id}" ${String(category.id) === String(selected) ? "selected" : ""}>${escapeHtml(category.name)}</option>`)
    .join("");
}

function categoryOptionsList(selectedValues = []) {
  const selected = new Set(selectedValues.map(String));
  return state.categories
    .filter((category) => category.active || selected.has(String(category.id)))
    .map((category) => ({ value: String(category.id), label: category.name }));
}

function filterCategoryOptions() {
  return `<option value="">Todas las categorías</option>${state.categories
    .filter((category) => category.active)
    .map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`)
    .join("")}`;
}

function selectedValues(select) {
  if (!select) return [];
  if (select.dataset && Object.prototype.hasOwnProperty.call(select.dataset, "values")) {
    return select.dataset.values.split(",").filter(Boolean);
  }
  return Array.from(select.selectedOptions || []).map((option) => option.value);
}

function userOptions(selected = "") {
  const selectedSet = new Set((Array.isArray(selected) ? selected : [selected]).map((item) => String(item)));
  return state.users
    .filter((user) => user.active || selectedSet.has(String(user.id)))
    .map((user) => `<option value="${user.id}" ${selectedSet.has(String(user.id)) ? "selected" : ""}>${escapeHtml(user.name)}</option>`)
    .join("");
}

function filterUserOptions() {
  return state.users
    .filter((user) => user.active)
    .map((user) => `<option value="${user.id}">${escapeHtml(user.name)}</option>`)
    .join("");
}

function statusLabel(value) {
  return allStatuses().find((status) => status.key === value)?.label || value;
}

function statusColor(value) {
  return allStatuses().find((status) => status.key === value)?.color || "#111111";
}

function statusOptionsList(selectedValues = []) {
  const selected = new Set(selectedValues.map((value) => String(value)));
  return allStatuses()
    .filter((status) => status.active || selected.has(String(status.key)))
    .map((status) => ({ value: status.key, label: status.label }));
}

function assigneeOptionsList() {
  return state.users.filter((user) => user.active).map((user) => ({ value: String(user.id), label: user.name }));
}

function filterLabel(kind, values, emptyLabel = "") {
  const fallback = kind === "status" ? "Todos los estados" : kind === "category" ? "Sin categoría" : "Todos los responsables";
  if (!values.length) return emptyLabel || fallback;
  const source = kind === "status" ? statusOptionsList(values) : kind === "category" ? categoryOptionsList(values) : assigneeOptionsList();
  if (values.length === 1) return source.find((item) => item.value === values[0])?.label || "1 seleccionado";
  return `${values.length} ${kind === "category" ? "seleccionadas" : "seleccionados"}`;
}

function renderFilterMenu(id, kind) {
  const node = $(`#${id}`);
  const values = selectedValues(node);
  const source = kind === "status" ? statusOptionsList(values) : kind === "category" ? categoryOptionsList(values) : assigneeOptionsList();
  const emptyLabel = node.dataset.emptyLabel || (kind === "status" ? "Todos los estados" : kind === "category" ? "Sin categoría" : "Todos los responsables");
  const disabled = node.dataset.disabled === "true";
  node.dataset.values = values.join(",");
  node.innerHTML = `
    <button class="filter-trigger" type="button" data-filter-toggle="${id}" ${disabled ? "disabled" : ""}>
      <span>${escapeHtml(filterLabel(kind, values, emptyLabel))}</span>
      <span aria-hidden="true">⌄</span>
    </button>
    <div class="filter-popover hidden">
      ${source.map((item) => `
        <label class="filter-option">
          <input type="checkbox" value="${escapeHtml(item.value)}" ${values.includes(String(item.value)) ? "checked" : ""} data-filter-option="${id}" ${disabled ? "disabled" : ""} />
          <span>${escapeHtml(item.label)}</span>
        </label>
      `).join("")}
    </div>
  `;
}

function renderFilterMenus() {
  renderFilterMenu("mineStatusFilter", "status");
  renderFilterMenu("teamStatusFilter", "status");
  renderFilterMenu("teamAssigneeFilter", "assignee");
}

function renderDueWindowControl() {
  document.querySelectorAll("[data-due-window]").forEach((button) => {
    button.classList.toggle("active", button.dataset.dueWindow === state.dueWindow);
  });
  $("#dueWindowControl").classList.toggle("hidden", !["mine", "team"].includes(state.activeView));
}

function renderSidebar() {
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  $("#sidebarToggle").setAttribute("aria-expanded", String(!state.sidebarCollapsed));
  $("#sidebarToggle").setAttribute("aria-label", state.sidebarCollapsed ? "Expandir menú" : "Colapsar menú");
}

function showLogin() {
  $("#loginView").classList.remove("hidden");
  $("#appView").classList.add("hidden");
}

function showApp() {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
}

function currentFilters(prefix) {
  const status = selectedValues($(`#${prefix}StatusFilter`));
  const category = $(`#${prefix}CategoryFilter`)?.value || "";
  const priority = $(`#${prefix}PriorityFilter`)?.value || "";
  const assignee = selectedValues($(`#${prefix}AssigneeFilter`));
  const q = $(`#${prefix}Search`)?.value || "";
  const params = new URLSearchParams();
  status.forEach((value) => params.append("status", value));
  if (category) params.set("category", category);
  if (priority) params.set("priority", priority);
  assignee.forEach((value) => params.append("assignee", value));
  if (state.dueWindow) params.set("due_window", state.dueWindow);
  if (q) params.set("q", q);
  if (prefix === "mine") params.set("mine", "1");
  return params.toString();
}

async function loadTasks() {
  const prefix = state.activeView === "team" ? "team" : "mine";
  const query = currentFilters(prefix);
  const payload = await api(`/api/tasks${query ? `?${query}` : ""}`);
  state.tasks = payload.tasks;
  render();
}

async function loadUserWorkload() {
  const payload = await api("/api/users/workload");
  state.userWorkload = payload;
  renderUserWorkload();
}

function blankGoal(position) {
  return { id: "", position, objective: "", success_type: "numeric", target_value: "", weight: 25, fact_value: "", completion: 0, weighted_completion: 0 };
}

function fourGoalRows(goals = []) {
  return Array.from({ length: 4 }, (_, index) => goals[index] || blankGoal(index + 1));
}

async function loadMonthlyGoals() {
  const selectedUser = $("#goalsUser").value || state.user?.id;
  const params = new URLSearchParams({ user_id: selectedUser });
  const payload = await api(`/api/monthly-goals?${params.toString()}`);
  state.monthlyGoals = payload;
  renderMonthlyGoals();
}

async function loadMonthlyGoalsForMonth(month) {
  const selectedUser = $("#goalsUser").value || state.user?.id;
  const params = new URLSearchParams({ month, user_id: selectedUser });
  return api(`/api/monthly-goals?${params.toString()}`);
}

async function loadOkrs() {
  const payload = await api("/api/okrs");
  state.okrs = payload;
  renderOkrs();
}

async function bootstrap() {
  const payload = await api("/api/bootstrap");
  state.user = payload.user;
  state.users = payload.users;
  state.categories = payload.categories;
  state.statuses = payload.statuses || [];
  hydrateControls();
  applyPermissions();
  renderSidebar();
  showApp();
  setView("mine");
}

function hydrateControls() {
  renderFilterMenus();
  $("#mineCategoryFilter").innerHTML = filterCategoryOptions();
  $("#teamCategoryFilter").innerHTML = filterCategoryOptions();
  $("#taskStatus").innerHTML = statusOptions("todo");
  $("#taskAssignee").dataset.values = String(state.user?.id || "");
  renderFilterMenu("taskAssignee", "assignee");
  $("#taskCategory").dataset.values = "";
  renderFilterMenu("taskCategory", "category");
  $("#goalsModalMonth").value = $("#goalsModalMonth").value || currentMonth();
}

function applyPermissions() {
  $("#sessionLabel").textContent = `${state.user.name} · ${state.user.role}`;
  document.body.dataset.role = state.user.role;
  const admin = state.user.role === "admin";
  const collaborator = state.user.role === "colaborador";
  document.querySelectorAll(".admin-only").forEach((node) => node.classList.toggle("hidden", !admin));
  document.querySelector('[data-view="team"]').classList.toggle("hidden", collaborator);
}

function setView(view) {
  if (state.user?.role === "colaborador" && !["mine", "goals", "okrs"].includes(view)) view = "mine";
  if (state.user?.role !== "admin" && (view === "categories" || view === "users")) view = "mine";
  state.activeView = view;
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === view));
  document.querySelectorAll(".nav-btn").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  const titles = { mine: "Mi panel", team: "Equipo", goals: "Monthly Goals", okrs: "OKRs", categories: "Categorías", users: "Usuarios" };
  $("#viewTitle").textContent = titles[view];
  $("#newTaskBtn").classList.toggle("hidden", !["mine", "team"].includes(view));
  renderDueWindowControl();
  if (view === "categories") renderCategories();
  if (view === "users") {
    renderUsers();
    loadUserWorkload().catch((error) => toast(error.message));
  }
  if (view === "goals") {
    renderMonthlyGoals();
    loadMonthlyGoals().catch((error) => toast(error.message));
  }
  if (view === "okrs") {
    renderOkrs();
    loadOkrs().catch((error) => toast(error.message));
  }
  if (view === "mine" || view === "team") loadTasks().catch((error) => toast(error.message));
}

function taskCard(task) {
  const overdue = isOverdue(task.due_date, task.status);
  const soon = isSoon(task.due_date) && !overdue && !isDoneStatus(task.status);
  const done = isDoneStatus(task.status);
  const categories = task.categories?.length ? task.categories : [{ name: task.category_name || "Sin categoría", color: task.category_color || "#111111" }];
  const tokenQuery = state.auth?.token ? `?token=${encodeURIComponent(state.auth.token)}` : "";
  return `
    <article class="task-card priority-${task.priority} ${overdue ? "is-overdue" : ""} ${done ? "is-done" : ""}" data-task-id="${task.id}">
      <div class="task-top">
        ${categories.map((category) => `
          <span class="task-category" style="--dot:${escapeHtml(category.color || "#111111")}">
            <span class="category-dot"></span>
            ${escapeHtml(category.name || "Sin categoría")}
          </span>
        `).join("")}
        <span class="priority">${escapeHtml(task.priority)}</span>
      </div>
      <h4>${escapeHtml(task.title)}</h4>
      ${task.notes_mode === "checklist" ? checklistPreview(task) : task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}
      <div class="task-meta">
        <span>${escapeHtml(task.assignee_name || "Sin responsable")}</span>
        <span class="${overdue ? "danger-text" : soon ? "warn-text" : ""}">${formatDate(task.due_date)}</span>
      </div>
      <div class="card-status" style="--status-color:${escapeHtml(statusColor(task.status))}">
        <span>Estado</span>
        <select class="card-status-select" data-status-task="${task.id}" aria-label="Cambiar estado de ${escapeHtml(task.title)}">
          ${statusOptions(task.status)}
        </select>
      </div>
      <div class="task-links">
        ${(task.related_links || (task.related_link ? [task.related_link] : [])).map((link, index) => `
          <a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Ticket o Archivo ${index + 1}</a>
        `).join("")}
        ${task.attachment_url ? `<a href="${escapeHtml(task.attachment_url + tokenQuery)}" target="_blank" rel="noreferrer">${escapeHtml(task.attachment_name || "Archivo")}</a>` : ""}
      </div>
      ${task.recurrence_interval ? `<div class="recurrence-pill">${escapeHtml(RECURRENCE[task.recurrence_interval] || "Recurrente")} · próxima ${formatDate(task.recurrence_next_date)}</div>` : ""}
      <div class="card-actions">
        <button class="icon-action" type="button" data-edit-task="${task.id}" aria-label="Editar">Editar</button>
        <button class="icon-action danger-action" type="button" data-delete-task="${task.id}" aria-label="Borrar">Borrar</button>
      </div>
    </article>
  `;
}

function checklistPreview(task) {
  const items = task.checklist_items || [];
  if (!items.length) return `<div class="checklist-preview empty-checklist">Sin to dos</div>`;
  const pending = items.map((item, index) => ({ item, index })).filter((entry) => !entry.item.done);
  if (!pending.length) return `<div class="checklist-preview empty-checklist">To dos completados</div>`;
  return `
    <div class="checklist-preview">
      ${pending.slice(0, 5).map((entry) => `
        <label class="checklist-line">
          <input type="checkbox" data-card-check="${task.id}" data-check-index="${entry.index}" />
          <span>${escapeHtml(entry.item.text)}</span>
        </label>
      `).join("")}
      ${pending.length > 5 ? `<small>+${pending.length - 5} más pendientes</small>` : ""}
    </div>
  `;
}

async function updateTaskStatus(id, status) {
  await api("/api/tasks/status", {
    method: "POST",
    body: JSON.stringify({ id, status }),
  });
  toast("Estado actualizado");
  await loadTasks();
}

async function updateTaskChecklist(task, index, done) {
  const items = (task.checklist_items || []).map((item, itemIndex) => ({
    text: item.text,
    done: itemIndex === index ? done : item.done,
  }));
  await api("/api/tasks/checklist", {
    method: "POST",
    body: JSON.stringify({ id: task.id, checklist_items: items }),
  });
  await loadTasks();
}

function statusesForBoard(tasks) {
  const used = new Set(tasks.map((task) => task.status));
  const prefix = state.activeView === "team" ? "team" : "mine";
  const selected = selectedValues($(`#${prefix}StatusFilter`));
  if (selected.length) {
    return allStatuses().filter((status) => selected.includes(status.key) && used.has(status.key));
  }
  return allStatuses().filter((status) => status.active || used.has(status.key));
}

function renderBoard(target, tasks) {
  const statuses = statusesForBoard(tasks);
  if (!statuses.length) {
    target.innerHTML = `<div class="empty-state wide">No hay tareas para estos filtros.</div>`;
    return;
  }
  target.innerHTML = statuses.map((status) => {
    const columnTasks = tasks.filter((task) => task.status === status.key);
    return `
      <section class="board-column">
        <div class="column-head" style="--status-color:${escapeHtml(status.color)}">
          <h3>${escapeHtml(status.label)}</h3>
          <span>${columnTasks.length}</span>
        </div>
        <div class="column-body">
          ${columnTasks.map(taskCard).join("") || `<div class="empty-state">Sin tareas</div>`}
        </div>
      </section>
    `;
  }).join("");
}

function renderMine() {
  const tasks = state.tasks;
  $("#metricMineOpen").textContent = tasks.filter((task) => !isDoneStatus(task.status)).length;
  $("#metricMineHelp").textContent = tasks.filter((task) => task.status === "needs_help").length;
  $("#metricMineDue").textContent = tasks.filter((task) => isSoon(task.due_date) || isOverdue(task.due_date, task.status)).length;
  $("#metricMineDone").textContent = tasks.filter((task) => isDoneStatus(task.status)).length;
  renderBoard($("#mineBoard"), tasks);
}

function renderTeam() {
  const tasks = state.tasks;
  const people = [...new Set(tasks.flatMap((task) => task.assigned_user_ids || [task.assigned_user_id]))];
  $("#metricTeamOpen").textContent = tasks.filter((task) => !isDoneStatus(task.status)).length;
  $("#metricTeamHelp").textContent = tasks.filter((task) => task.status === "needs_help").length;
  $("#metricTeamPeople").textContent = people.length;
  $("#metricTeamDone").textContent = tasks.filter((task) => isDoneStatus(task.status)).length;
  const grouped = state.users
    .filter((user) => tasks.some((task) => (task.assigned_user_ids || [task.assigned_user_id]).some((id) => Number(id) === Number(user.id))))
    .map((user) => {
      const owned = tasks.filter((task) => (task.assigned_user_ids || [task.assigned_user_id]).some((id) => Number(id) === Number(user.id)));
      return `
        <section class="person-panel">
          <div class="person-head">
            <div class="avatar">${escapeHtml(user.name.slice(0, 1))}</div>
            <div><h3>${escapeHtml(user.name)}</h3><small>${owned.filter((task) => !isDoneStatus(task.status)).length} abiertas</small></div>
          </div>
          <div class="person-tasks">${owned.map(taskCard).join("")}</div>
        </section>
      `;
    })
    .join("");
  $("#teamBoard").innerHTML = grouped || `<div class="empty-state wide">No hay tareas para estos filtros.</div>`;
}

function renderCategories() {
  $("#categoryGrid").innerHTML = state.categories.map((category) => `
    <article class="management-card">
      <div class="card-line">
        <span class="category-swatch" style="--dot:${escapeHtml(category.color)}"></span>
        <div>
          <h4>${escapeHtml(category.name)}</h4>
          <p>${escapeHtml(category.description || "")}</p>
        </div>
      </div>
      <span class="state-pill">${category.active ? "Activa" : "Inactiva"}</span>
      <div class="card-actions">
        <button type="button" data-edit-category="${category.id}">Editar</button>
        <button class="danger-action" type="button" data-delete-category="${category.id}">Borrar</button>
      </div>
    </article>
  `).join("");
  renderStatuses();
}

function renderStatuses() {
  $("#statusGrid").innerHTML = allStatuses().map((status) => `
    <article class="management-card">
      <div class="card-line">
        <span class="category-swatch" style="--dot:${escapeHtml(status.color)}"></span>
        <div>
          <h4>${escapeHtml(status.label)}</h4>
          <p>${status.system_key ? "Estado base" : escapeHtml(status.key)}</p>
        </div>
      </div>
      <div class="pill-row">
        <span class="state-pill">${status.active ? "Activo" : "Inactivo"}</span>
        <span class="state-pill">Orden ${Number(status.sort_order || 0)}</span>
        ${status.is_done ? `<span class="state-pill">Cierra tarea</span>` : ""}
      </div>
      <div class="card-actions">
        <button type="button" data-edit-status="${escapeHtml(status.key)}">Editar</button>
        <button class="danger-action" type="button" data-delete-status="${escapeHtml(status.key)}" ${status.system_key ? "disabled" : ""}>Borrar</button>
      </div>
    </article>
  `).join("");
}

function renderUsers() {
  $("#userGrid").innerHTML = state.users.map((user) => `
    <article class="management-card">
      <div class="card-line">
        <div class="avatar">${escapeHtml(user.name.slice(0, 1))}</div>
        <div>
          <h4>${escapeHtml(user.name)}</h4>
          <p>${escapeHtml(user.email)}</p>
        </div>
      </div>
      <div class="pill-row">
        <span class="state-pill">${escapeHtml(user.role)}</span>
        <span class="state-pill">${escapeHtml(user.team)}</span>
        <span class="state-pill">${user.active ? "Activo" : "Inactivo"}</span>
      </div>
      <div class="card-actions">
        <button type="button" data-edit-user="${user.id}">Editar</button>
        <button class="danger-action" type="button" data-delete-user="${user.id}">Borrar</button>
      </div>
    </article>
  `).join("");
  renderUserWorkload();
}

function renderUserWorkload() {
  const target = $("#userWorkloadTable");
  if (!target) return;
  const users = state.userWorkload.users || [];
  const statuses = state.userWorkload.statuses || [];
  if (!users.length || !statuses.length) {
    target.innerHTML = `<div class="empty-state wide">Todavía no hay pendientes abiertos para mapear.</div>`;
    return;
  }
  target.innerHTML = `
    <table class="workload-table">
      <thead>
        <tr>
          <th>Usuario</th>
          ${statuses.map((status) => `
            <th>
              <span class="workload-status">
                <span class="category-dot" style="--dot:${escapeHtml(status.color)}"></span>
                ${escapeHtml(status.label)}
              </span>
            </th>
          `).join("")}
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${users.map((user) => {
          const counts = user.counts || {};
          return `
            <tr>
              <th>
                <span>${escapeHtml(user.name)}</span>
                <small>${escapeHtml(user.role)} · ${escapeHtml(user.team || "Sin equipo")}</small>
              </th>
              ${statuses.map((status) => {
                const value = Number(counts[status.key] || 0);
                return `<td class="${value ? "" : "is-empty"}">${value}</td>`;
              }).join("")}
              <td class="workload-total">${Number(user.total_open || 0)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function goalCompletion(goal) {
  const weight = Number(goal.weight || 0);
  let completion = 0;
  if (goal.success_type === "binary") {
    completion = String(goal.fact_value || "").toLowerCase().startsWith("s") ? 100 : 0;
  } else {
    const target = Number(goal.target_value || 0);
    const fact = Number(goal.fact_value || 0);
    completion = target > 0 ? Math.max(0, Math.min((fact / target) * 100, 100)) : 0;
  }
  return { completion, weighted: completion * weight / 100 };
}

function renderGoalUserOptions(users = []) {
  const current = String(state.monthlyGoals.selected_user_id || state.user?.id || "");
  $("#goalsUser").innerHTML = users.map((user) => `<option value="${user.id}" ${String(user.id) === current ? "selected" : ""}>${escapeHtml(user.name)} · ${escapeHtml(user.team || "")}</option>`).join("");
  $("#goalsUser").disabled = !isGoalManager();
}

function selectedGoalUser(users = []) {
  return state.monthlyGoals.selected_user || users.find((user) => Number(user.id) === Number(state.monthlyGoals.selected_user_id)) || state.user || {};
}

function goalFactControl(goal) {
  if (goal.success_type === "binary") {
    return `
      <select data-goal-fact>
        <option value="" ${!goal.fact_value ? "selected" : ""}>Pendiente</option>
        <option value="Sí" ${goal.fact_value === "Sí" ? "selected" : ""}>Sí</option>
        <option value="No" ${goal.fact_value === "No" ? "selected" : ""}>No</option>
      </select>
    `;
  }
  return `<input data-goal-fact type="number" min="0" step="0.01" value="${escapeHtml(goal.fact_value || "")}" placeholder="Real" />`;
}

function renderGoalMonthSection(monthData, canManage) {
  const rows = monthData.goals || [];
  const month = monthData.month;
  const total = rows.reduce((sum, goal) => sum + goalCompletion(goal).weighted, 0);
  return `
    <section class="goals-month-section" data-goal-month="${escapeHtml(month)}">
      <div class="goals-month-head">
        <div>
          <small>Objetivos de</small>
          <h3>${escapeHtml(monthLabel(month))}</h3>
        </div>
        <div class="goals-month-actions">
          <div class="goals-record-score">
            <span data-goals-month-total>${Math.min(total, 100).toFixed(1)}%</span>
            <small>cumplimiento ponderado</small>
          </div>
          ${canManage ? `<button class="secondary tiny-action" type="button" data-edit-goal-month="${escapeHtml(month)}">Editar</button>` : ""}
        </div>
      </div>
      <table class="goals-table goals-record-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Objetivo</th>
            <th>Criterio</th>
            <th>Meta</th>
            <th>Peso</th>
            <th>Fact</th>
            <th>Evidencia</th>
            <th>%</th>
            <th>Aporte</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((goal, index) => {
            const calc = goalCompletion(goal);
            const criterion = goal.success_type === "binary" ? "Sí / No" : "Numérico";
            const target = goal.success_type === "binary" ? "Sí" : goal.target_value;
            const evidence = goal.evidence_url
              ? `<a href="${escapeHtml(goal.evidence_url)}" target="_blank" rel="noreferrer">Abrir evidencia</a>`
              : "";
            return `
              <tr data-goal-fact-row>
                <td>${index + 1}<input type="hidden" data-goal-id value="${escapeHtml(goal.id || "")}" /></td>
                <td><strong>${escapeHtml(goal.objective || "")}</strong></td>
                <td>${criterion}</td>
                <td data-goal-target-value>${escapeHtml(target ?? "")}</td>
                <td data-goal-weight-value>${Number(goal.weight || 0).toFixed(1)}%</td>
                <td>
                  <input type="hidden" data-goal-type-value value="${escapeHtml(goal.success_type || "numeric")}" />
                  ${goalFactControl(goal)}
                </td>
                <td class="goal-evidence-cell">
                  <input data-goal-evidence type="url" value="${escapeHtml(goal.evidence_url || "")}" placeholder="https://" class="${evidence ? "hidden" : ""}" />
                  ${evidence ? `
                    <div class="goal-evidence-link">
                      ${evidence}
                      <button class="link-button" type="button" data-edit-evidence>Cambiar</button>
                    </div>
                  ` : ""}
                </td>
                <td data-goal-completion>${calc.completion.toFixed(1)}%</td>
                <td data-goal-weighted>${calc.weighted.toFixed(1)}%</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function renderGoalRecord(months, user, canManage) {
  if (!months.length) {
    return `
      <div class="goals-empty">
        <h3>${escapeHtml(user.name || "Persona")}</h3>
        <p>No hay objetivos cargados todavía.</p>
      </div>
    `;
  }
  return `
    <div class="goals-record-head">
      <div>
        <small>Histórico de objetivos</small>
        <h2>${escapeHtml(user.name || "Persona")}</h2>
      </div>
      <small>${months.length} ${months.length === 1 ? "mes cargado" : "meses cargados"}</small>
    </div>
    <div class="goals-month-list">
      ${months.map((monthData) => renderGoalMonthSection(monthData, canManage)).join("")}
    </div>
  `;
}

function renderGoalEditor(rows) {
  $("#goalsEditor").innerHTML = `
    <div class="goals-editor-list">
      ${rows.map((goal, index) => {
        const targetDisabled = goal.success_type === "binary" ? "disabled" : "";
        return `
          <div class="goal-editor-card" data-goal-row>
            <div class="goal-editor-number">${index + 1}<input type="hidden" data-goal-id value="${escapeHtml(goal.id || "")}" /></div>
            <label class="goal-editor-objective">Objetivo
              <textarea data-goal-objective rows="2" placeholder="Descripción del objetivo">${escapeHtml(goal.objective || "")}</textarea>
            </label>
            <label>Criterio
              <select data-goal-type>
                <option value="numeric" ${goal.success_type !== "binary" ? "selected" : ""}>Numérico</option>
                <option value="binary" ${goal.success_type === "binary" ? "selected" : ""}>Sí / No</option>
              </select>
            </label>
            <label>Meta
              <input data-goal-target type="number" min="0" step="0.01" value="${goal.target_value ?? ""}" ${targetDisabled} placeholder="${goal.success_type === "binary" ? "Sí" : "Meta"}" />
            </label>
            <label>Peso
              <input data-goal-weight type="number" min="0" max="100" step="0.01" value="${goal.weight || ""}" />
            </label>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderMonthlyGoals() {
  const data = state.monthlyGoals || {};
  const users = data.users?.length ? data.users : [state.user].filter(Boolean);
  renderGoalUserOptions(users);
  const canManage = Boolean(data.can_manage);
  const months = data.months || [];
  const user = selectedGoalUser(users);
  $("#editGoalsBtn").classList.toggle("hidden", !canManage);
  $("#editGoalsBtn").textContent = "+ Crear nuevos objetivos";
  $("#saveFactsBtn").classList.toggle("hidden", !months.length);
  $("#goalsTotal").textContent = String(months.length);
  $("#goalsTotalLabel").textContent = months.length === 1 ? "mes cargado" : "meses cargados";
  $("#goalsNotice").textContent = months.length
    ? "Actualiza Fact para ver el cumplimiento real de cada mes."
    : (canManage ? "Crea objetivos desde el botón para empezar el histórico." : "Todavía no tienes objetivos cargados.");
  $("#goalsRecord").innerHTML = renderGoalRecord(months, user, canManage);
  renderGoalEditor(fourGoalRows([]));
  updateGoalsSummary();
}

function collectGoalRows() {
  return [...$("#goalsEditor").querySelectorAll("[data-goal-row]")].map((row, index) => ({
    id: row.querySelector("[data-goal-id]").value,
    position: index + 1,
    objective: row.querySelector("[data-goal-objective]").value.trim(),
    success_type: row.querySelector("[data-goal-type]").value,
    target_value: row.querySelector("[data-goal-target]").value,
    weight: row.querySelector("[data-goal-weight]").value,
  }));
}

function collectGoalFacts() {
  return [...$("#goalsRecord").querySelectorAll("[data-goal-fact-row]")].map((row) => ({
    id: row.querySelector("[data-goal-id]").value,
    success_type: row.querySelector("[data-goal-type-value]").value,
    target_value: row.querySelector("[data-goal-target-value]").textContent.trim(),
    weight: row.querySelector("[data-goal-weight-value]").textContent.replace("%", "").trim(),
    fact_value: row.querySelector("[data-goal-fact]").value,
    evidence_url: row.querySelector("[data-goal-evidence]").value.trim(),
  }));
}

function factGoalFromRow(row) {
  return {
    id: row.querySelector("[data-goal-id]").value,
    success_type: row.querySelector("[data-goal-type-value]").value,
    target_value: row.querySelector("[data-goal-target-value]").textContent.trim(),
    weight: row.querySelector("[data-goal-weight-value]").textContent.replace("%", "").trim(),
    fact_value: row.querySelector("[data-goal-fact]").value,
  };
}

function updateGoalsSummary() {
  const sections = [...$("#goalsRecord").querySelectorAll("[data-goal-month]")];
  if (sections.length) {
    sections.forEach((section) => {
      let sectionTotal = 0;
      section.querySelectorAll("[data-goal-fact-row]").forEach((row) => {
        const calc = goalCompletion(factGoalFromRow(row));
        sectionTotal += calc.weighted;
        row.querySelector("[data-goal-completion]").textContent = `${calc.completion.toFixed(1)}%`;
        row.querySelector("[data-goal-weighted]").textContent = `${calc.weighted.toFixed(1)}%`;
      });
      section.querySelector("[data-goals-month-total]").textContent = `${Math.min(sectionTotal, 100).toFixed(1)}%`;
    });
    $("#goalsTotal").textContent = String(sections.length);
    $("#goalsTotalLabel").textContent = sections.length === 1 ? "mes cargado" : "meses cargados";
    return;
  }
  let total = 0;
  collectGoalRows().forEach((goal) => {
    const calc = goalCompletion(goal);
    total += calc.weighted;
  });
}

function syncGoalRowType(row) {
  const type = row.querySelector("[data-goal-type]").value;
  const target = row.querySelector("[data-goal-target]");
  target.disabled = type === "binary";
  target.placeholder = type === "binary" ? "Sí" : "Meta";
  if (type === "binary") {
    target.value = "";
  }
  updateGoalsSummary();
}

function updateDeleteGoalsButton(hasGoals) {
  $("#deleteGoalsBtn").classList.toggle("hidden", !(state.user?.role === "admin" && hasGoals));
}

async function setGoalsModalMonth(month) {
  const safeMonth = month || currentMonth();
  $("#goalsModalMonth").value = safeMonth;
  if ($("#goalsOriginalMonth").value) return;
  try {
    const payload = await loadMonthlyGoalsForMonth(safeMonth);
    const hasGoals = Boolean(payload.goals?.length);
    $("#goalsModalTitle").textContent = hasGoals ? "Editar objetivos" : "Crear nuevos objetivos";
    $("#goalsOriginalMonth").value = hasGoals ? safeMonth : "";
    updateDeleteGoalsButton(hasGoals);
    renderGoalEditor(fourGoalRows(payload.goals || []));
  } catch (error) {
    toast(error.message);
    updateDeleteGoalsButton(false);
    renderGoalEditor(fourGoalRows([]));
  }
}

function openGoalsModal(month = currentMonth(), goals = null) {
  const users = state.monthlyGoals.users?.length ? state.monthlyGoals.users : [state.user].filter(Boolean);
  const user = selectedGoalUser(users);
  $("#goalsModalTitle").textContent = goals?.length ? "Editar objetivos" : "Crear nuevos objetivos";
  $("#goalsModalSubtitle").textContent = user.name || "Persona";
  $("#goalsModalMonth").value = month || currentMonth();
  $("#goalsOriginalMonth").value = goals?.length ? (month || currentMonth()) : "";
  updateDeleteGoalsButton(Boolean(goals?.length));
  renderGoalEditor(fourGoalRows(goals || []));
  $("#goalsModal").classList.remove("hidden");
  if (!goals) setGoalsModalMonth($("#goalsModalMonth").value);
}

function closeGoalsModal() {
  $("#goalsModal").classList.add("hidden");
}

function okrRangeLabel(period) {
  return `${monthLabel(period.period_from)} - ${monthLabel(period.period_to)}`;
}

function blankOkrObjective() {
  return {
    regional_priorities: "",
    key_north_stars: "",
    kpi1_description: "",
    kpi1_from: "",
    kpi1_to: "",
    kpi2_description: "",
    kpi2_from: "",
    kpi2_to: "",
    proposed_projects: "",
    kpi_owner: "",
  };
}

function renderOkrs() {
  const canManage = Boolean(state.okrs?.can_manage);
  $("#newOkrBtn").classList.toggle("hidden", !canManage);
  const periods = state.okrs?.periods || [];
  if (!periods.length) {
    $("#okrRecord").innerHTML = `
      <div class="goals-empty">
        <h3>OKRs</h3>
        <p>Todavía no hay OKRs cargados.</p>
      </div>
    `;
    return;
  }
  $("#okrRecord").innerHTML = periods.map((period) => `
    <section class="okr-period-card">
      <div class="okr-period-head">
        <div>
          <small>Período</small>
          <h3>${escapeHtml(okrRangeLabel(period))}</h3>
        </div>
        ${canManage ? `<button class="secondary tiny-action" type="button" data-edit-okr="${period.id}">Editar</button>` : ""}
      </div>
      <div class="okr-objective-list">
        ${(period.objectives || []).map((objective, index) => `
          <article class="okr-objective-card">
            <div class="okr-objective-title">
              <span>${index + 1}</span>
              <div>
                <small>Regional priorities</small>
                <div class="okr-rich-text">${formatRichText(objective.regional_priorities)}</div>
              </div>
            </div>
            <div class="okr-two-col">
              <div>
                <small>Key north stars</small>
                <div class="okr-rich-text">${formatRichText(objective.key_north_stars)}</div>
              </div>
              <div>
                <small>KPI owner</small>
                <div class="okr-rich-text">${formatRichText(objective.kpi_owner)}</div>
              </div>
            </div>
            <div class="okr-kpis">
              <div><div class="okr-rich-text okr-kpi-desc">${formatRichText(objective.kpi1_description)}</div><span>${escapeHtml(objective.kpi1_from)} → ${escapeHtml(objective.kpi1_to)}</span></div>
              <div><div class="okr-rich-text okr-kpi-desc">${formatRichText(objective.kpi2_description)}</div><span>${escapeHtml(objective.kpi2_from)} → ${escapeHtml(objective.kpi2_to)}</span></div>
            </div>
            <div>
              <small>Proposed projects</small>
              <div class="okr-rich-text">${formatRichText(objective.proposed_projects)}</div>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `).join("");
}

function okrObjectiveEditorItem(objective = blankOkrObjective(), index = 0) {
  const wrap = document.createElement("div");
  wrap.className = "okr-editor-card";
  wrap.dataset.okrObjective = "1";
  wrap.innerHTML = `
    <div class="okr-editor-head">
      <strong>Objetivo ${index + 1}</strong>
      <button class="danger-action tiny-action" type="button" data-remove-okr-objective>Quitar</button>
    </div>
    <label>Regional priorities
      <textarea data-okr-regional rows="2" required>${escapeHtml(objective.regional_priorities || "")}</textarea>
    </label>
    <label>Key north stars
      <textarea data-okr-north rows="2" required>${escapeHtml(objective.key_north_stars || "")}</textarea>
    </label>
    <div class="okr-kpi-editor">
      <label>KPI 1
        <input data-okr-kpi1-desc required value="${escapeHtml(objective.kpi1_description || "")}" placeholder="Descripción del KPI" />
      </label>
      <label>From
        <input data-okr-kpi1-from required value="${escapeHtml(objective.kpi1_from || "")}" />
      </label>
      <label>To
        <input data-okr-kpi1-to required value="${escapeHtml(objective.kpi1_to || "")}" />
      </label>
    </div>
    <div class="okr-kpi-editor">
      <label>KPI 2
        <input data-okr-kpi2-desc required value="${escapeHtml(objective.kpi2_description || "")}" placeholder="Descripción del KPI" />
      </label>
      <label>From
        <input data-okr-kpi2-from required value="${escapeHtml(objective.kpi2_from || "")}" />
      </label>
      <label>To
        <input data-okr-kpi2-to required value="${escapeHtml(objective.kpi2_to || "")}" />
      </label>
    </div>
    <label>Proposed projects
      <textarea data-okr-projects rows="2" required>${escapeHtml(objective.proposed_projects || "")}</textarea>
    </label>
    <label>KPI owner
      <input data-okr-owner required value="${escapeHtml(objective.kpi_owner || "")}" />
    </label>
  `;
  return wrap;
}

function renderOkrObjectiveEditors(objectives = [blankOkrObjective()]) {
  $("#okrObjectives").innerHTML = "";
  objectives.forEach((objective, index) => $("#okrObjectives").appendChild(okrObjectiveEditorItem(objective, index)));
}

function openOkrModal(period = null) {
  $("#okrForm").reset();
  $("#okrId").value = period?.id || "";
  $("#okrModalTitle").textContent = period ? "Editar OKRs" : "Crear OKRs";
  $("#okrPeriodFrom").value = period?.period_from || currentMonth();
  $("#okrPeriodTo").value = period?.period_to || currentMonth();
  $("#deleteOkrBtn").classList.toggle("hidden", !period?.id);
  renderOkrObjectiveEditors(period?.objectives?.length ? period.objectives : [blankOkrObjective()]);
  $("#okrModal").classList.remove("hidden");
}

function closeOkrModal() {
  $("#okrModal").classList.add("hidden");
}

function collectOkrObjectives() {
  return [...$("#okrObjectives").querySelectorAll("[data-okr-objective]")].map((row) => ({
    regional_priorities: row.querySelector("[data-okr-regional]").value.trim(),
    key_north_stars: row.querySelector("[data-okr-north]").value.trim(),
    kpi1_description: row.querySelector("[data-okr-kpi1-desc]").value.trim(),
    kpi1_from: row.querySelector("[data-okr-kpi1-from]").value.trim(),
    kpi1_to: row.querySelector("[data-okr-kpi1-to]").value.trim(),
    kpi2_description: row.querySelector("[data-okr-kpi2-desc]").value.trim(),
    kpi2_from: row.querySelector("[data-okr-kpi2-from]").value.trim(),
    kpi2_to: row.querySelector("[data-okr-kpi2-to]").value.trim(),
    proposed_projects: row.querySelector("[data-okr-projects]").value.trim(),
    kpi_owner: row.querySelector("[data-okr-owner]").value.trim(),
  }));
}

function render() {
  if (state.activeView === "mine") renderMine();
  if (state.activeView === "team") renderTeam();
}

function setNotesMode(mode) {
  state.notesMode = mode === "checklist" ? "checklist" : "notes";
  document.querySelectorAll("[data-notes-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.notesMode === state.notesMode);
  });
  $("#notesTextWrap").classList.toggle("hidden", state.notesMode !== "notes");
  $("#checklistWrap").classList.toggle("hidden", state.notesMode !== "checklist");
}

function checklistEditorItem(item = { text: "", done: false }) {
  const wrap = document.createElement("label");
  wrap.className = `checklist-edit-line ${item.done ? "done" : ""}`;
  wrap.innerHTML = `
    <input type="checkbox" ${item.done ? "checked" : ""} data-checklist-done />
    <input type="text" value="${escapeHtml(item.text)}" placeholder="Nuevo pendiente" data-checklist-text />
    <button class="icon-action danger-action" type="button" data-remove-checklist>Quitar</button>
  `;
  return wrap;
}

function renderChecklistEditor(items = []) {
  const target = $("#checklistItems");
  target.innerHTML = "";
  const source = items.length ? items : [{ text: "", done: false }];
  source.forEach((item) => target.appendChild(checklistEditorItem(item)));
}

function checklistFromEditor() {
  return [...document.querySelectorAll(".checklist-edit-line")]
    .map((row) => ({
      text: row.querySelector("[data-checklist-text]").value.trim(),
      done: row.querySelector("[data-checklist-done]").checked,
    }))
    .filter((item) => item.text);
}

function relatedLinkEditorItem(value = "") {
  const wrap = document.createElement("div");
  wrap.className = "related-link-line";
  wrap.innerHTML = `
    <input type="url" value="${escapeHtml(value)}" placeholder="https://" data-related-link />
    <button class="icon-action danger-action" type="button" data-remove-related-link>Quitar</button>
  `;
  return wrap;
}

function renderRelatedLinksEditor(links = []) {
  const target = $("#taskRelatedLinks");
  target.innerHTML = "";
  const source = links.length ? links : [""];
  source.forEach((link) => target.appendChild(relatedLinkEditorItem(link)));
}

function relatedLinksFromEditor() {
  return [...document.querySelectorAll("[data-related-link]")]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function syncRecurrenceFields({ fillDefault = true } = {}) {
  const interval = $("#taskRecurrence").value;
  $("#taskRecurrenceNextWrap").classList.toggle("hidden", !interval);
  if (interval && fillDefault && !$("#taskRecurrenceNext").value) {
    $("#taskRecurrenceNext").value = defaultRecurrenceNext(interval);
  }
  if (!interval) $("#taskRecurrenceNext").value = "";
}

function openTask(task = null) {
  $("#taskForm").reset();
  $("#taskId").value = task?.id || "";
  $("#taskTitle").value = task?.title || "";
  $("#taskDescription").value = task?.description || "";
  setNotesMode(task?.notes_mode || "notes");
  renderChecklistEditor(task?.checklist_items || []);
  $("#taskAssignee").dataset.values = (task?.assigned_user_ids || [state.user.id]).map((id) => String(id)).join(",");
  $("#taskAssignee").dataset.disabled = state.user.role === "colaborador" ? "true" : "false";
  renderFilterMenu("taskAssignee", "assignee");
  $("#taskCategory").dataset.values = (task?.category_ids || (task?.category_id ? [task.category_id] : [])).map((id) => String(id)).join(",");
  renderFilterMenu("taskCategory", "category");
  $("#taskStatus").innerHTML = statusOptions(task?.status || "todo");
  $("#taskPriority").value = task?.priority || "media";
  $("#taskDueDate").value = task?.due_date || "";
  renderRelatedLinksEditor(task?.related_links || (task?.related_link ? [task.related_link] : []));
  $("#taskRecurrence").value = task?.recurrence_interval || "";
  $("#taskRecurrenceNext").value = task?.recurrence_next_date || "";
  syncRecurrenceFields({ fillDefault: false });
  $("#taskModalTitle").textContent = task ? "Editar tarea" : "Nueva tarea";
  $("#taskModal").classList.remove("hidden");
}

function closeTask() {
  $("#taskModal").classList.add("hidden");
}

function openCategory(category = null) {
  $("#categoryForm").reset();
  $("#categoryId").value = category?.id || "";
  $("#categoryName").value = category?.name || "";
  $("#categoryColor").value = category?.color || "#ff1f1f";
  $("#categoryDescription").value = category?.description || "";
  $("#categoryActive").checked = category ? Boolean(category.active) : true;
  $("#categoryModal").classList.remove("hidden");
}

function openStatus(status = null) {
  $("#statusForm").reset();
  $("#statusKey").value = status?.key || "";
  $("#statusLabel").value = status?.label || "";
  $("#statusColor").value = status?.color || "#deded5";
  $("#statusOrder").value = status?.sort_order || 100;
  $("#statusActive").checked = status ? Boolean(status.active) : true;
  $("#statusActive").disabled = Boolean(status?.system_key);
  $("#statusModalTitle").textContent = status ? "Editar estado" : "Nuevo estado";
  $("#statusModal").classList.remove("hidden");
}

function openUser(user = null) {
  $("#userForm").reset();
  $("#userId").value = user?.id || "";
  $("#userName").value = user?.name || "";
  $("#userEmail").value = user?.email || "";
  $("#userRole").value = user?.role || "colaborador";
  $("#userTeam").value = user?.team || "Operaciones";
  $("#userActive").checked = user ? Boolean(user.active) : true;
  $("#userModal").classList.remove("hidden");
}

async function refreshBootstrapLists() {
  const payload = await api("/api/bootstrap");
  state.user = payload.user;
  state.users = payload.users;
  state.categories = payload.categories;
  state.statuses = payload.statuses || [];
  hydrateControls();
  renderCategories();
  renderUsers();
  if (state.activeView === "users") await loadUserWorkload();
  await loadTasks();
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: $("#loginEmail").value, password: $("#loginPassword").value }),
    });
    state.auth = { token: payload.token };
    await bootstrap();
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("click", async (event) => {
  const nav = event.target.closest(".nav-btn");
  if (nav) setView(nav.dataset.view);

  const filterToggle = event.target.closest("[data-filter-toggle]");
  if (filterToggle) {
    const menu = $(`#${filterToggle.dataset.filterToggle}`);
    document.querySelectorAll(".filter-popover").forEach((node) => {
      if (!menu.contains(node)) node.classList.add("hidden");
    });
    menu.querySelector(".filter-popover").classList.toggle("hidden");
    return;
  }

  if (!event.target.closest(".filter-menu")) {
    document.querySelectorAll(".filter-popover").forEach((node) => node.classList.add("hidden"));
  }

  const dueWindow = event.target.closest("[data-due-window]");
  if (dueWindow) {
    state.dueWindow = state.dueWindow === dueWindow.dataset.dueWindow ? "" : dueWindow.dataset.dueWindow;
    renderDueWindowControl();
    if (state.activeView === "mine" || state.activeView === "team") {
      loadTasks().catch((error) => toast(error.message));
    }
  }

  if (event.target.closest("#sidebarToggle")) {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    localStorage.setItem("sidebarCollapsed", state.sidebarCollapsed ? "1" : "0");
    renderSidebar();
  }

  if (event.target.closest("#newTaskBtn")) openTask();
  if (event.target.closest("[data-close-modal]")) closeTask();
  const editEvidence = event.target.closest("[data-edit-evidence]");
  if (editEvidence) {
    const cell = editEvidence.closest(".goal-evidence-cell");
    cell.querySelector("[data-goal-evidence]").classList.remove("hidden");
    editEvidence.closest(".goal-evidence-link").remove();
  }
  if (event.target.closest("#newCategoryBtn")) openCategory();
  if (event.target.closest("[data-close-category]")) $("#categoryModal").classList.add("hidden");
  if (event.target.closest("#newStatusBtn")) openStatus();
  if (event.target.closest("[data-close-status]")) $("#statusModal").classList.add("hidden");
  if (event.target.closest("#newUserBtn")) openUser();
  if (event.target.closest("[data-close-user]")) $("#userModal").classList.add("hidden");
  const editGoalMonth = event.target.closest("[data-edit-goal-month]");
  if (editGoalMonth) {
    const monthData = (state.monthlyGoals.months || []).find((item) => item.month === editGoalMonth.dataset.editGoalMonth);
    openGoalsModal(editGoalMonth.dataset.editGoalMonth, monthData?.goals || []);
  }
  if (event.target.closest("#editGoalsBtn")) openGoalsModal();
  if (event.target.closest("[data-close-goals]")) closeGoalsModal();
  if (event.target.closest("#newOkrBtn")) openOkrModal();
  if (event.target.closest("[data-close-okr]")) closeOkrModal();
  const editOkr = event.target.closest("[data-edit-okr]");
  if (editOkr) {
    const period = (state.okrs.periods || []).find((item) => Number(item.id) === Number(editOkr.dataset.editOkr));
    if (period) openOkrModal(period);
  }
  if (event.target.closest("#addOkrObjectiveBtn")) {
    $("#okrObjectives").appendChild(okrObjectiveEditorItem(blankOkrObjective(), $("#okrObjectives").children.length));
  }
  const removeOkrObjective = event.target.closest("[data-remove-okr-objective]");
  if (removeOkrObjective) {
    removeOkrObjective.closest("[data-okr-objective]").remove();
    if (!$("#okrObjectives").children.length) $("#okrObjectives").appendChild(okrObjectiveEditorItem(blankOkrObjective(), 0));
  }

  const editTask = event.target.closest("[data-edit-task]");
  if (editTask) openTask(state.tasks.find((task) => Number(task.id) === Number(editTask.dataset.editTask)));

  const notesMode = event.target.closest("[data-notes-mode]");
  if (notesMode) setNotesMode(notesMode.dataset.notesMode);

  if (event.target.closest("#addChecklistItem")) {
    $("#checklistItems").appendChild(checklistEditorItem());
  }

  if (event.target.closest("#addRelatedLink")) {
    $("#taskRelatedLinks").appendChild(relatedLinkEditorItem());
  }

  const removeChecklist = event.target.closest("[data-remove-checklist]");
  if (removeChecklist) {
    removeChecklist.closest(".checklist-edit-line").remove();
    if (!$("#checklistItems").children.length) $("#checklistItems").appendChild(checklistEditorItem());
  }

  const removeRelatedLink = event.target.closest("[data-remove-related-link]");
  if (removeRelatedLink) {
    removeRelatedLink.closest(".related-link-line").remove();
    if (!$("#taskRelatedLinks").children.length) $("#taskRelatedLinks").appendChild(relatedLinkEditorItem());
  }

  const deleteTask = event.target.closest("[data-delete-task]");
  if (deleteTask && window.confirm("¿Borrar esta tarea?")) {
    try {
      await api("/api/tasks/delete", { method: "POST", body: JSON.stringify({ id: deleteTask.dataset.deleteTask }) });
      toast("Tarea borrada");
      await loadTasks();
    } catch (error) {
      toast(error.message);
    }
  }

  const editCategory = event.target.closest("[data-edit-category]");
  if (editCategory) openCategory(state.categories.find((category) => Number(category.id) === Number(editCategory.dataset.editCategory)));

  const deleteCategory = event.target.closest("[data-delete-category]");
  if (deleteCategory && window.confirm("¿Borrar esta categoría?")) {
    try {
      await api("/api/categories/delete", { method: "POST", body: JSON.stringify({ id: deleteCategory.dataset.deleteCategory }) });
      toast("Categoría borrada");
      await refreshBootstrapLists();
    } catch (error) {
      toast(error.message);
    }
  }

  const editStatus = event.target.closest("[data-edit-status]");
  if (editStatus) openStatus(state.statuses.find((status) => status.key === editStatus.dataset.editStatus));

  const deleteStatus = event.target.closest("[data-delete-status]");
  if (deleteStatus && !deleteStatus.disabled && window.confirm("¿Borrar este estado?")) {
    try {
      await api("/api/statuses/delete", { method: "POST", body: JSON.stringify({ key: deleteStatus.dataset.deleteStatus }) });
      toast("Estado borrado");
      await refreshBootstrapLists();
    } catch (error) {
      toast(error.message);
    }
  }

  const editUser = event.target.closest("[data-edit-user]");
  if (editUser) openUser(state.users.find((user) => Number(user.id) === Number(editUser.dataset.editUser)));

  const deleteUser = event.target.closest("[data-delete-user]");
  if (deleteUser && window.confirm("¿Borrar este usuario?")) {
    try {
      await api("/api/users/delete", { method: "POST", body: JSON.stringify({ id: deleteUser.dataset.deleteUser }) });
      toast("Usuario borrado");
      await refreshBootstrapLists();
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener("change", async (event) => {
  const statusSelect = event.target.closest(".card-status-select[data-status-task]");
  if (statusSelect) {
    try {
      await updateTaskStatus(statusSelect.dataset.statusTask, statusSelect.value);
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  const filterOption = event.target.closest("[data-filter-option]");
  if (filterOption) {
    const menu = $(`#${filterOption.dataset.filterOption}`);
    const values = [...menu.querySelectorAll("[data-filter-option]:checked")].map((input) => input.value);
    menu.dataset.values = values.join(",");
    renderFilterMenu(menu.id, menu.dataset.filterMenu);
    menu.querySelector(".filter-popover")?.classList.remove("hidden");
    if (menu.id === "taskAssignee" || menu.id === "taskCategory") return;
    try {
      await loadTasks();
    } catch (error) {
      toast(error.message);
    }
  }

  const cardCheck = event.target.closest("[data-card-check]");
  if (cardCheck) {
    const task = state.tasks.find((item) => Number(item.id) === Number(cardCheck.dataset.cardCheck));
    if (!task) return;
    try {
      await updateTaskChecklist(task, Number(cardCheck.dataset.checkIndex), cardCheck.checked);
    } catch (error) {
      toast(error.message);
    }
  }

  const editorCheck = event.target.closest("[data-checklist-done]");
  if (editorCheck) {
    editorCheck.closest(".checklist-edit-line").classList.toggle("done", editorCheck.checked);
  }

  if (event.target.closest("#taskRecurrence")) {
    $("#taskRecurrenceNext").value = "";
    syncRecurrenceFields();
  }
});

$("#taskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/tasks/save", {
      method: "POST",
      body: JSON.stringify({
        id: $("#taskId").value,
        title: $("#taskTitle").value,
        description: $("#taskDescription").value,
        notes_mode: state.notesMode,
        checklist_items: checklistFromEditor(),
        assigned_user_ids: selectedValues($("#taskAssignee")),
        category_ids: selectedValues($("#taskCategory")),
        status: $("#taskStatus").value,
        priority: $("#taskPriority").value,
        due_date: $("#taskDueDate").value,
        related_links: relatedLinksFromEditor(),
        recurrence_interval: $("#taskRecurrence").value,
        recurrence_next_date: $("#taskRecurrenceNext").value,
        attachment_file: await readFile($("#taskAttachment")),
      }),
    });
    toast("Tarea guardada");
    closeTask();
    await loadTasks();
  } catch (error) {
    toast(error.message);
  }
});

$("#categoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/categories/save", {
      method: "POST",
      body: JSON.stringify({
        id: $("#categoryId").value,
        name: $("#categoryName").value,
        color: $("#categoryColor").value,
        description: $("#categoryDescription").value,
        active: $("#categoryActive").checked,
      }),
    });
    toast("Categoría guardada");
    $("#categoryModal").classList.add("hidden");
    await refreshBootstrapLists();
  } catch (error) {
    toast(error.message);
  }
});

$("#statusForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/statuses/save", {
      method: "POST",
      body: JSON.stringify({
        key: $("#statusKey").value,
        label: $("#statusLabel").value,
        color: $("#statusColor").value,
        sort_order: $("#statusOrder").value,
        active: $("#statusActive").checked,
      }),
    });
    toast("Estado guardado");
    $("#statusModal").classList.add("hidden");
    $("#statusActive").disabled = false;
    await refreshBootstrapLists();
  } catch (error) {
    toast(error.message);
  }
});

$("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/users/save", {
      method: "POST",
      body: JSON.stringify({
        id: $("#userId").value,
        name: $("#userName").value,
        email: $("#userEmail").value,
        role: $("#userRole").value,
        team: $("#userTeam").value,
        password: $("#userPassword").value,
        active: $("#userActive").checked,
      }),
    });
    toast("Usuario guardado");
    $("#userModal").classList.add("hidden");
    await refreshBootstrapLists();
  } catch (error) {
    toast(error.message);
  }
});

$("#goalsUser").addEventListener("change", () => loadMonthlyGoals().catch((error) => toast(error.message)));
$("#goalsModalMonth").addEventListener("change", () => setGoalsModalMonth($("#goalsModalMonth").value));

$("#goalsRecord").addEventListener("input", updateGoalsSummary);
$("#goalsRecord").addEventListener("change", updateGoalsSummary);
$("#goalsEditor").addEventListener("input", updateGoalsSummary);
$("#goalsEditor").addEventListener("change", (event) => {
  const type = event.target.closest("[data-goal-type]");
  if (type) syncGoalRowType(type.closest("[data-goal-row]"));
  updateGoalsSummary();
});

$("#goalsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/monthly-goals/save", {
      method: "POST",
      body: JSON.stringify({
        user_id: $("#goalsUser").value,
        month: $("#goalsModalMonth").value,
        original_month: $("#goalsOriginalMonth").value,
        goals: collectGoalRows(),
      }),
    });
    closeGoalsModal();
    await loadMonthlyGoals();
    toast("Monthly goals guardados");
  } catch (error) {
    toast(error.message);
  }
});

$("#deleteGoalsBtn").addEventListener("click", async () => {
  if (!window.confirm("¿Borrar los objetivos de este mes para esta persona?")) return;
  try {
    await api("/api/monthly-goals/delete", {
      method: "POST",
      body: JSON.stringify({
        user_id: $("#goalsUser").value,
        month: $("#goalsOriginalMonth").value || $("#goalsModalMonth").value,
      }),
    });
    closeGoalsModal();
    await loadMonthlyGoals();
    toast("Objetivos borrados");
  } catch (error) {
    toast(error.message);
  }
});

$("#saveFactsBtn").addEventListener("click", async () => {
  try {
    const payload = await api("/api/monthly-goals/facts", {
      method: "POST",
      body: JSON.stringify({
        user_id: $("#goalsUser").value,
        facts: collectGoalFacts().filter((goal) => goal.id).map((goal) => ({ id: goal.id, fact_value: goal.fact_value, evidence_url: goal.evidence_url })),
      }),
    });
    state.monthlyGoals = payload;
    renderMonthlyGoals();
    toast("Facts guardados");
  } catch (error) {
    toast(error.message);
  }
});

$("#okrForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/okrs/save", {
      method: "POST",
      body: JSON.stringify({
        id: $("#okrId").value,
        period_from: $("#okrPeriodFrom").value,
        period_to: $("#okrPeriodTo").value,
        objectives: collectOkrObjectives(),
      }),
    });
    state.okrs = payload;
    renderOkrs();
    closeOkrModal();
    toast("OKRs guardados");
  } catch (error) {
    toast(error.message);
  }
});

$("#deleteOkrBtn").addEventListener("click", async () => {
  const okrId = $("#okrId").value;
  if (!okrId || !window.confirm("¿Borrar este período de OKRs completo?")) return;
  try {
    const payload = await api("/api/okrs/delete", {
      method: "POST",
      body: JSON.stringify({ id: okrId }),
    });
    state.okrs = payload;
    renderOkrs();
    closeOkrModal();
    toast("OKRs borrados");
  } catch (error) {
    toast(error.message);
  }
});

["mineCategoryFilter", "minePriorityFilter", "teamCategoryFilter"].forEach((id) => {
  $(`#${id}`).addEventListener("change", () => loadTasks().catch((error) => toast(error.message)));
});

["mineSearch", "teamSearch"].forEach((id) => {
  $(`#${id}`).addEventListener("input", () => loadTasks().catch((error) => toast(error.message)));
});

$("#logoutBtn").addEventListener("click", () => {
  state.auth = null;
  state.user = null;
  sessionStorage.removeItem("taskAuth");
  showLogin();
});

$("#exportBtn").addEventListener("click", async () => {
  try {
    const query = currentFilters("team");
    const response = await fetch(`/api/export${query ? `?${query}` : ""}`, {
      headers: { Authorization: `Bearer ${state.auth.token}` },
    });
    if (!response.ok) throw new Error("No se pudo descargar el CSV");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "yango-tareas.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeTask();
    $("#categoryModal").classList.add("hidden");
    $("#statusModal").classList.add("hidden");
    $("#userModal").classList.add("hidden");
  }
});

showLogin();
