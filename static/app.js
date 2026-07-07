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
  const fallback = kind === "status" ? "Todos los estados" : "Todos los responsables";
  if (!values.length) return emptyLabel || fallback;
  const source = kind === "status" ? statusOptionsList(values) : assigneeOptionsList();
  if (values.length === 1) return source.find((item) => item.value === values[0])?.label || "1 seleccionado";
  return `${values.length} seleccionados`;
}

function renderFilterMenu(id, kind) {
  const node = $(`#${id}`);
  const values = selectedValues(node);
  const source = kind === "status" ? statusOptionsList(values) : assigneeOptionsList();
  const emptyLabel = node.dataset.emptyLabel || (kind === "status" ? "Todos los estados" : "Todos los responsables");
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
  $("#taskCategory").innerHTML = categoryOptions();
  $("#taskAssignee").dataset.values = String(state.user?.id || "");
  renderFilterMenu("taskAssignee", "assignee");
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
  if (state.user?.role === "colaborador" && view !== "mine") view = "mine";
  if (state.user?.role !== "admin" && (view === "categories" || view === "users")) view = "mine";
  state.activeView = view;
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === view));
  document.querySelectorAll(".nav-btn").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  const titles = { mine: "Mi panel", team: "Equipo", categories: "Categorías", users: "Usuarios" };
  $("#viewTitle").textContent = titles[view];
  renderDueWindowControl();
  if (view === "categories") renderCategories();
  if (view === "users") renderUsers();
  if (view === "mine" || view === "team") loadTasks().catch((error) => toast(error.message));
}

function taskCard(task) {
  const overdue = isOverdue(task.due_date, task.status);
  const soon = isSoon(task.due_date) && !overdue && !isDoneStatus(task.status);
  const done = isDoneStatus(task.status);
  const color = task.category_color || "#111111";
  const tokenQuery = state.auth?.token ? `?token=${encodeURIComponent(state.auth.token)}` : "";
  return `
    <article class="task-card priority-${task.priority} ${overdue ? "is-overdue" : ""} ${done ? "is-done" : ""}" data-task-id="${task.id}">
      <div class="task-top">
        <span class="category-dot" style="--dot:${escapeHtml(color)}"></span>
        <span class="task-category">${escapeHtml(task.category_name || "Sin categoría")}</span>
        <span class="priority">${escapeHtml(task.priority)}</span>
      </div>
      <h4>${escapeHtml(task.title)}</h4>
      ${task.notes_mode === "checklist" ? checklistPreview(task) : task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}
      <div class="task-meta">
        <span>${escapeHtml(task.assignee_name || "Sin responsable")}</span>
        <span class="${overdue ? "danger-text" : soon ? "warn-text" : ""}">${formatDate(task.due_date)}</span>
      </div>
      <div class="status-pills" role="group" aria-label="Estado de tarea">
        ${activeStatuses(task.status).map((status) => `
          <button class="status-pill ${task.status === status.key ? "active" : ""}" style="--status-color:${escapeHtml(status.color)}" type="button" data-status-task="${task.id}" data-status-value="${escapeHtml(status.key)}">
            ${escapeHtml(status.label)}
          </button>
        `).join("")}
      </div>
      <div class="task-links">
        ${task.related_link ? `<a href="${escapeHtml(task.related_link)}" target="_blank" rel="noreferrer">Ticket o Archivo</a>` : ""}
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
  return `
    <div class="checklist-preview">
      ${items.slice(0, 5).map((item, index) => `
        <label class="checklist-line ${item.done ? "done" : ""}">
          <input type="checkbox" ${item.done ? "checked" : ""} data-card-check="${task.id}" data-check-index="${index}" />
          <span>${escapeHtml(item.text)}</span>
        </label>
      `).join("")}
      ${items.length > 5 ? `<small>+${items.length - 5} más</small>` : ""}
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
  $("#taskCategory").innerHTML = categoryOptions(task?.category_id || "");
  $("#taskStatus").innerHTML = statusOptions(task?.status || "todo");
  $("#taskPriority").value = task?.priority || "media";
  $("#taskDueDate").value = task?.due_date || "";
  $("#taskRelatedLink").value = task?.related_link || "";
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
  if (event.target.closest("#newCategoryBtn")) openCategory();
  if (event.target.closest("[data-close-category]")) $("#categoryModal").classList.add("hidden");
  if (event.target.closest("#newStatusBtn")) openStatus();
  if (event.target.closest("[data-close-status]")) $("#statusModal").classList.add("hidden");
  if (event.target.closest("#newUserBtn")) openUser();
  if (event.target.closest("[data-close-user]")) $("#userModal").classList.add("hidden");

  const editTask = event.target.closest("[data-edit-task]");
  if (editTask) openTask(state.tasks.find((task) => Number(task.id) === Number(editTask.dataset.editTask)));

  const statusButton = event.target.closest("[data-status-task]");
  if (statusButton) {
    try {
      await updateTaskStatus(statusButton.dataset.statusTask, statusButton.dataset.statusValue);
    } catch (error) {
      toast(error.message);
    }
  }

  const notesMode = event.target.closest("[data-notes-mode]");
  if (notesMode) setNotesMode(notesMode.dataset.notesMode);

  if (event.target.closest("#addChecklistItem")) {
    $("#checklistItems").appendChild(checklistEditorItem());
  }

  const removeChecklist = event.target.closest("[data-remove-checklist]");
  if (removeChecklist) {
    removeChecklist.closest(".checklist-edit-line").remove();
    if (!$("#checklistItems").children.length) $("#checklistItems").appendChild(checklistEditorItem());
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
  const filterOption = event.target.closest("[data-filter-option]");
  if (filterOption) {
    const menu = $(`#${filterOption.dataset.filterOption}`);
    const values = [...menu.querySelectorAll("[data-filter-option]:checked")].map((input) => input.value);
    menu.dataset.values = values.join(",");
    renderFilterMenu(menu.id, menu.dataset.filterMenu);
    menu.querySelector(".filter-popover")?.classList.remove("hidden");
    if (menu.id === "taskAssignee") return;
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
        category_id: $("#taskCategory").value,
        status: $("#taskStatus").value,
        priority: $("#taskPriority").value,
        due_date: $("#taskDueDate").value,
        related_link: $("#taskRelatedLink").value,
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

["mineCategoryFilter", "minePriorityFilter", "teamCategoryFilter"].forEach((id) => {
  $(`#${id}`).addEventListener("change", () => loadTasks().catch((error) => toast(error.message)));
});

["mineSearch"].forEach((id) => {
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
