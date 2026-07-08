#!/usr/bin/env python3
import base64
import csv
import hashlib
import io
import json
import calendar
import mimetypes
import os
import sqlite3
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DB_PATH", ROOT / "yango_tasks.db"))
STATIC_DIR = ROOT / "static"
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", ROOT / "uploads"))
AUTH_TOKENS = {}
DB_LOCK = threading.Lock()
RECURRENCE_INTERVALS = {"7d", "14d", "monthly"}
DEFAULT_STATUSES = [
    ("todo", "Por hacer", "#deded5", 10, 1, 0),
    ("in_progress", "En progreso", "#205db8", 20, 0, 0),
    ("needs_help", "Necesita ayuda", "#ffde00", 30, 0, 0),
    ("done", "Done", "#0a8f5a", 90, 1, 1),
]
SYSTEM_STATUS_KEYS = {"todo", "done"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def hash_password(password):
    return hashlib.sha256(str(password).encode("utf-8")).hexdigest()


def row_to_dict(row):
    return dict(row) if row else None


def clean_text(value):
    return str(value or "").strip()


def slugify_status(value):
    source = clean_text(value).lower()
    slug = []
    previous_dash = False
    for char in source:
        if char.isalnum():
            slug.append(char)
            previous_dash = False
        elif not previous_dash:
            slug.append("_")
            previous_dash = True
    return "".join(slug).strip("_")[:48] or f"status_{uuid.uuid4().hex[:8]}"


def parse_date_value(value):
    value = clean_text(value)
    if not value:
        return None
    return date.fromisoformat(value)


def next_business_date(value):
    while value.weekday() >= 5:
        value += timedelta(days=1)
    return value


def add_month(value):
    month = value.month + 1
    year = value.year
    if month > 12:
        month = 1
        year += 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def add_recurrence_interval(value, interval):
    if interval == "7d":
        return value + timedelta(days=7)
    if interval == "14d":
        return value + timedelta(days=14)
    if interval == "monthly":
        return add_month(value)
    return value


def default_recurrence_next(interval):
    return next_business_date(add_recurrence_interval(date.today(), interval))


def due_date_for_recurrence(created_on):
    return next_business_date(created_on + timedelta(days=3))


def due_window_bounds(window):
    today = date.today()
    if window == "today":
        return today, today
    if window == "this_week":
        return today, today + timedelta(days=6 - today.weekday())
    if window == "next_week":
        start = today + timedelta(days=7 - today.weekday())
        return start, start + timedelta(days=6)
    return None, None


def parse_json_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if not length:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8") or "{}")


def send_json(handler, payload, status=200):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def send_text(handler, text, content_type, status=200, headers=None):
    data = text.encode("utf-8-sig")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(data)


def send_file(handler, path, content_type):
    data = path.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def make_token(user):
    token = uuid.uuid4().hex
    AUTH_TOKENS[token] = {"user_id": user["id"], "created_at": now_iso()}
    return token


def auth_context(handler):
    header = handler.headers.get("Authorization", "")
    token = ""
    if header.lower().startswith("bearer "):
        token = header.split(" ", 1)[1].strip()
    else:
        parsed = urlparse(handler.path)
        token = parse_qs(parsed.query).get("token", [""])[0]
    session = AUTH_TOKENS.get(token)
    if not session:
        return None
    with db() as con:
        row = con.execute(
            "select id, name, email, role, team, active from users where id = ?",
            (session["user_id"],),
        ).fetchone()
    if not row or not row["active"]:
        return None
    return row_to_dict(row)


def require_user(handler):
    user = auth_context(handler)
    if not user:
        send_json(handler, {"error": "No autorizado"}, 401)
        return None
    return user


def can_manage_admin_data(user):
    return user["role"] == "admin"


def visible_user_where(user):
    if user["role"] == "admin":
        return "", []
    if user["role"] == "manager":
        return "where team = ? and active = 1", [user["team"]]
    return "where id = ? and active = 1", [user["id"]]


def can_view_task(user, task):
    if user["role"] == "admin":
        return True
    assignee_ids = task_assignee_ids(task)
    assignee_teams = task_assignee_teams(task)
    if user["role"] == "manager":
        return user["team"] in assignee_teams
    return int(user["id"]) in assignee_ids


def can_edit_task(user, task):
    if user["role"] == "admin":
        return True
    assignee_ids = task_assignee_ids(task)
    assignee_teams = task_assignee_teams(task)
    if user["role"] == "manager":
        return user["team"] in assignee_teams
    return int(user["id"]) in assignee_ids


def save_upload(file_info):
    if not file_info or not file_info.get("data"):
        return None, None, None
    raw_data = file_info["data"]
    if "," in raw_data:
        raw_data = raw_data.split(",", 1)[1]
    data = base64.b64decode(raw_data)
    if not data:
        return None, None, None
    original = Path(file_info.get("name") or "archivo").name
    suffix = Path(original).suffix[:12]
    stored = f"task-{uuid.uuid4().hex}{suffix}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    target = UPLOAD_DIR / stored
    target.write_bytes(data)
    content_type = file_info.get("type") or mimetypes.guess_type(original)[0] or "application/octet-stream"
    return str(Path("uploads") / stored), original, content_type


def public_user(row):
    data = row_to_dict(row)
    if not data:
        return None
    data.pop("password_hash", None)
    return data


def task_assignee_ids(task):
    raw = clean_text(task.get("assignee_ids") or task.get("assigned_user_id"))
    return [int(item) for item in raw.split("||") if clean_text(item).isdigit()]


def task_assignee_teams(task):
    raw = clean_text(task.get("assignee_teams") or task.get("assignee_team"))
    return [item for item in raw.split("||") if item]


def task_select(clause=""):
    return f"""
        select
            tasks.*,
            coalesce(group_concat(users.id, '||'), tasks.assigned_user_id) as assignee_ids,
            coalesce(group_concat(users.name, '||'), '') as assignee_name,
            coalesce(group_concat(users.email, '||'), '') as assignee_email,
            coalesce(group_concat(users.team, '||'), '') as assignee_team,
            coalesce(group_concat(users.team, '||'), '') as assignee_teams,
            statuses.label as status_label,
            statuses.color as status_color,
            statuses.sort_order as status_sort_order,
            statuses.is_done as status_is_done,
            categories.name as category_name,
            categories.color as category_color
        from tasks
        left join task_assignees on task_assignees.task_id = tasks.id
        left join users on users.id = task_assignees.user_id
        left join statuses on statuses.key = tasks.status
        left join categories on categories.id = tasks.category_id
        {clause}
        group by tasks.id
    """


def normalize_checklist(items):
    if not isinstance(items, list):
        return []
    normalized = []
    for item in items:
        if isinstance(item, dict):
            text = clean_text(item.get("text"))
            done = bool(item.get("done"))
        else:
            text = clean_text(item)
            done = False
        if text:
            normalized.append({"text": text[:240], "done": done})
    return normalized[:24]


def normalize_related_links(value):
    if isinstance(value, str):
        raw_links = [value]
    elif isinstance(value, list):
        raw_links = value
    else:
        raw_links = []
    links = []
    for item in raw_links:
        link = clean_text(item.get("url") or item.get("href")) if isinstance(item, dict) else clean_text(item)
        if link and link not in links:
            links.append(link[:500])
    return links[:12]


def public_task(row):
    data = row_to_dict(row)
    if not data:
        return None
    ids = task_assignee_ids(data)
    names = [item for item in clean_text(data.get("assignee_name")).split("||") if item]
    emails = [item for item in clean_text(data.get("assignee_email")).split("||") if item]
    teams = task_assignee_teams(data)
    data["assigned_user_ids"] = ids
    data["assigned_user_id"] = ids[0] if ids else data.get("assigned_user_id")
    data["assignee_name"] = ", ".join(names)
    data["assignee_team"] = ", ".join(dict.fromkeys(teams))
    data["assignees"] = [
        {"id": ids[index], "name": names[index], "email": emails[index] if index < len(emails) else "", "team": teams[index] if index < len(teams) else ""}
        for index in range(min(len(ids), len(names)))
    ]
    data["notes_mode"] = data.get("notes_mode") or "notes"
    data["status_label"] = data.get("status_label") or data.get("status")
    data["status_color"] = data.get("status_color") or "#111111"
    data["status_is_done"] = bool(data.get("status_is_done")) or data.get("status") == "done"
    try:
        data["checklist_items"] = normalize_checklist(json.loads(data.get("checklist_json") or "[]"))
    except json.JSONDecodeError:
        data["checklist_items"] = []
    try:
        related_links = normalize_related_links(json.loads(data.get("related_links_json") or "[]"))
    except json.JSONDecodeError:
        related_links = []
    if not related_links and data.get("related_link"):
        related_links = normalize_related_links(data.get("related_link"))
    data["related_links"] = related_links
    data["related_link"] = related_links[0] if related_links else clean_text(data.get("related_link"))
    data["attachment_url"] = "/" + data["attachment_path"] if data.get("attachment_path") else ""
    return data


def normalize_recurrence(body):
    interval = clean_text(body.get("recurrence_interval"))
    if not interval:
        return "", ""
    if interval not in RECURRENCE_INTERVALS:
        raise ValueError("Recurrencia inválida")
    next_date = parse_date_value(body.get("recurrence_next_date")) or default_recurrence_next(interval)
    return interval, next_business_date(next_date).isoformat()


def list_users_for(user):
    where, params = visible_user_where(user)
    with db() as con:
        return [
            public_user(row)
            for row in con.execute(
                f"select * from users {where} order by active desc, name collate nocase",
                params,
            )
        ]


def user_workload_for(user):
    with DB_LOCK:
        with db() as con:
            create_due_recurring_tasks(con)

    where, params = visible_user_where(user)
    with db() as con:
        users = [
            public_user(row)
            for row in con.execute(
                f"select * from users {where} order by active desc, name collate nocase",
                params,
            )
        ]
        if not users:
            return {"users": [], "statuses": []}

        user_ids = [item["id"] for item in users]
        placeholders = ",".join("?" for _ in user_ids)
        count_rows = [
            row_to_dict(row)
            for row in con.execute(
                f"""
                select task_assignees.user_id, tasks.status, count(distinct tasks.id) as count
                from task_assignees
                join tasks on tasks.id = task_assignees.task_id
                left join statuses on statuses.key = tasks.status
                where task_assignees.user_id in ({placeholders})
                  and coalesce(statuses.is_done, 0) = 0
                group by task_assignees.user_id, tasks.status
                """,
                user_ids,
            )
        ]
        used_statuses = sorted({row["status"] for row in count_rows if row.get("status")})
        status_params = list(used_statuses)
        status_clause = "or key in ({})".format(",".join("?" for _ in used_statuses)) if used_statuses else ""
        statuses = [
            public_status(row)
            for row in con.execute(
                f"""
                select *
                from statuses
                where is_done = 0 and (active = 1 {status_clause})
                order by sort_order, label collate nocase
                """,
                status_params,
            )
        ]

    counts_by_user = {item["id"]: {} for item in users}
    for row in count_rows:
        user_counts = counts_by_user.setdefault(row["user_id"], {})
        user_counts[row["status"]] = row["count"]

    workload_users = []
    for item in users:
        counts = counts_by_user.get(item["id"], {})
        user_data = dict(item)
        user_data["counts"] = counts
        user_data["total_open"] = sum(int(value or 0) for value in counts.values())
        workload_users.append(user_data)
    return {"users": workload_users, "statuses": statuses}


def list_categories():
    with db() as con:
        return [
            row_to_dict(row)
            for row in con.execute("select * from categories order by active desc, name collate nocase")
        ]


def public_status(row):
    data = row_to_dict(row)
    if not data:
        return None
    data["active"] = bool(data.get("active"))
    data["system_key"] = bool(data.get("system_key"))
    data["is_done"] = bool(data.get("is_done"))
    return data


def list_statuses():
    with db() as con:
        return [
            public_status(row)
            for row in con.execute("select * from statuses order by sort_order, label collate nocase")
        ]


def status_keys(con, active_only=False):
    where = "where active = 1" if active_only else ""
    return {
        row["key"]
        for row in con.execute(f"select key from statuses {where}")
    }


def unique_status_key(con, label):
    base = slugify_status(label)
    key = base
    counter = 2
    while con.execute("select 1 from statuses where key = ?", (key,)).fetchone():
        suffix = f"_{counter}"
        key = f"{base[:48 - len(suffix)]}{suffix}"
        counter += 1
    return key


def query_values(query, key, allowed=None, numeric=False):
    values = []
    for raw in query.get(key, []):
        for item in str(raw).split(","):
            value = clean_text(item)
            if not value:
                continue
            if numeric:
                if value.isdigit():
                    values.append(int(value))
            elif allowed is None or value in allowed:
                values.append(value)
    return list(dict.fromkeys(values))


def list_tasks_for(user, query):
    with DB_LOCK:
        with db() as con:
            create_due_recurring_tasks(con)

    params = []
    where = []
    if user["role"] == "manager":
        where.append(
            """
            exists (
                select 1
                from task_assignees visible_assignees
                join users visible_users on visible_users.id = visible_assignees.user_id
                where visible_assignees.task_id = tasks.id and visible_users.team = ?
            )
            """
        )
        params.append(user["team"])
    elif user["role"] == "colaborador":
        where.append("exists (select 1 from task_assignees mine_assignees where mine_assignees.task_id = tasks.id and mine_assignees.user_id = ?)")
        params.append(user["id"])

    with db() as con:
        allowed_statuses = status_keys(con)
    statuses = query_values(query, "status", allowed=allowed_statuses)
    assignees = query_values(query, "assignee", numeric=True)
    category = clean_text(query.get("category", [""])[0])
    priority = clean_text(query.get("priority", [""])[0])
    mine = clean_text(query.get("mine", [""])[0])
    due_window = clean_text(query.get("due_window", [""])[0])
    search = clean_text(query.get("q", [""])[0])

    if statuses:
        placeholders = ",".join("?" for _ in statuses)
        where.append(f"tasks.status in ({placeholders})")
        params.extend(statuses)
    if assignees:
        placeholders = ",".join("?" for _ in assignees)
        where.append(f"exists (select 1 from task_assignees filtered_assignees where filtered_assignees.task_id = tasks.id and filtered_assignees.user_id in ({placeholders}))")
        params.extend(assignees)
    if category:
        where.append("tasks.category_id = ?")
        params.append(int(category))
    if priority:
        where.append("tasks.priority = ?")
        params.append(priority)
    due_start, due_end = due_window_bounds(due_window)
    if due_start and due_end:
        where.append("tasks.due_date between ? and ?")
        where.append("coalesce(statuses.is_done, 0) = 0")
        params.extend([due_start.isoformat(), due_end.isoformat()])
    if mine == "1":
        where.append("exists (select 1 from task_assignees own_assignees where own_assignees.task_id = tasks.id and own_assignees.user_id = ?)")
        params.append(user["id"])
    if search:
        where.append("(tasks.title like ? or tasks.description like ?)")
        params.extend([f"%{search}%", f"%{search}%"])

    clause = "where " + " and ".join(where) if where else ""
    sql = f"""
        {task_select(clause)}
        order by
            coalesce(statuses.sort_order, 999),
            case tasks.priority
                when 'alta' then 1
                when 'media' then 2
                else 3
            end,
            coalesce(tasks.due_date, '9999-12-31'),
            tasks.updated_at desc
    """
    with db() as con:
        return [public_task(row) for row in con.execute(sql, params)]


def get_task(con, task_id):
    return con.execute(task_select("where tasks.id = ?"), (task_id,)).fetchone()


def get_task_assignee_ids(con, task_id):
    return [
        int(row["user_id"])
        for row in con.execute(
            "select user_id from task_assignees where task_id = ? order by user_id",
            (task_id,),
        )
    ]


def set_task_assignees(con, task_id, assignee_ids):
    con.execute("delete from task_assignees where task_id = ?", (task_id,))
    for assignee_id in dict.fromkeys(int(item) for item in assignee_ids):
        con.execute(
            "insert into task_assignees (task_id, user_id) values (?, ?)",
            (task_id, assignee_id),
        )


def resolve_assignees(con, body, current_user, task_id=0):
    if current_user["role"] == "colaborador":
        if task_id:
            assignee_ids = get_task_assignee_ids(con, task_id)
            if int(current_user["id"]) not in assignee_ids:
                raise ValueError("No autorizado")
            return assignee_ids
        return [int(current_user["id"])]

    raw_ids = body.get("assigned_user_ids")
    if raw_ids is None:
        raw_ids = [body.get("assigned_user_id")]
    if not isinstance(raw_ids, list):
        raw_ids = [raw_ids]
    assignee_ids = []
    for raw_id in raw_ids:
        value = clean_text(raw_id)
        if value.isdigit() and int(value) not in assignee_ids:
            assignee_ids.append(int(value))
    if not assignee_ids:
        raise ValueError("Selecciona al menos un responsable")

    placeholders = ",".join("?" for _ in assignee_ids)
    assignees = [
        row_to_dict(row)
        for row in con.execute(
            f"select id, name, team from users where active = 1 and id in ({placeholders})",
            assignee_ids,
        )
    ]
    if len(assignees) != len(assignee_ids):
        raise ValueError("Responsable no encontrado")
    if current_user["role"] == "manager" and any(item["team"] != current_user["team"] for item in assignees):
        raise ValueError("Todos los responsables deben pertenecer a tu equipo")
    return assignee_ids


def migrate_task_assignees(con):
    con.execute(
        """
        insert or ignore into task_assignees (task_id, user_id)
        select id, assigned_user_id
        from tasks
        where assigned_user_id is not null
        """
    )


def ensure_task_columns(con):
    existing = {row["name"] for row in con.execute("pragma table_info(tasks)")}
    if "notes_mode" not in existing:
        con.execute("alter table tasks add column notes_mode text not null default 'notes'")
    if "checklist_json" not in existing:
        con.execute("alter table tasks add column checklist_json text not null default '[]'")
    if "recurrence_interval" not in existing:
        con.execute("alter table tasks add column recurrence_interval text not null default ''")
    if "recurrence_next_date" not in existing:
        con.execute("alter table tasks add column recurrence_next_date text")
    if "recurrence_source_id" not in existing:
        con.execute("alter table tasks add column recurrence_source_id integer")
    if "recurrence_run_date" not in existing:
        con.execute("alter table tasks add column recurrence_run_date text")
    if "related_links_json" not in existing:
        con.execute("alter table tasks add column related_links_json text not null default '[]'")


def tasks_table_sql():
    return """
        create table if not exists tasks (
            id integer primary key autoincrement,
            title text not null,
            description text,
            assigned_user_id integer not null references users(id),
            category_id integer references categories(id),
            status text not null,
            priority text not null check (priority in ('alta', 'media', 'baja')),
            due_date text,
            related_link text,
            related_links_json text not null default '[]',
            attachment_path text,
            attachment_name text,
            attachment_type text,
            notes_mode text not null default 'notes',
            checklist_json text not null default '[]',
            recurrence_interval text not null default '',
            recurrence_next_date text,
            recurrence_source_id integer,
            recurrence_run_date text,
            created_by integer not null references users(id),
            created_at text not null,
            updated_at text not null
        )
    """


def create_statuses_table(con):
    con.execute(
        """
        create table if not exists statuses (
            key text primary key,
            label text not null,
            color text not null default '#deded5',
            sort_order integer not null default 100,
            active integer not null default 1,
            system_key integer not null default 0,
            is_done integer not null default 0,
            created_at text not null,
            updated_at text not null
        )
        """
    )


def ensure_default_statuses(con):
    timestamp = now_iso()
    for key, label, color, sort_order, system_key, is_done in DEFAULT_STATUSES:
        con.execute(
            """
            insert into statuses (key, label, color, sort_order, active, system_key, is_done, created_at, updated_at)
            values (?, ?, ?, ?, 1, ?, ?, ?, ?)
            on conflict(key) do update set
                label = case when label = '' then excluded.label else label end,
                color = case when color = '' then excluded.color else color end,
                sort_order = case when sort_order = 100 then excluded.sort_order else sort_order end,
                system_key = excluded.system_key,
                is_done = excluded.is_done,
                active = case when excluded.system_key = 1 then 1 else active end
            """,
            (key, label, color, sort_order, system_key, is_done, timestamp, timestamp),
        )


def ensure_tasks_status_flexible(con):
    row = con.execute("select sql from sqlite_master where type = 'table' and name = 'tasks'").fetchone()
    if not row or "check (status in" not in (row["sql"] or "").lower():
        return
    assignee_exists = con.execute("select 1 from sqlite_master where type = 'table' and name = 'task_assignees'").fetchone()
    if assignee_exists:
        con.execute("create temp table task_assignees_backup as select * from task_assignees")
        con.execute("drop table task_assignees")
    con.execute("alter table tasks rename to tasks_with_status_check")
    con.execute(tasks_table_sql())
    columns = [
        "id", "title", "description", "assigned_user_id", "category_id", "status", "priority",
        "due_date", "related_link", "related_links_json", "attachment_path", "attachment_name",
        "attachment_type", "notes_mode", "checklist_json", "recurrence_interval", "recurrence_next_date",
        "recurrence_source_id", "recurrence_run_date", "created_by", "created_at", "updated_at",
    ]
    joined = ", ".join(columns)
    con.execute(f"insert into tasks ({joined}) select {joined} from tasks_with_status_check")
    con.execute("drop table tasks_with_status_check")
    if assignee_exists:
        con.execute(
            """
            create table task_assignees (
                task_id integer not null references tasks(id) on delete cascade,
                user_id integer not null references users(id),
                primary key (task_id, user_id)
            )
            """
        )
        con.execute("insert or ignore into task_assignees select * from task_assignees_backup")
        con.execute("drop table task_assignees_backup")


def create_due_recurring_tasks(con):
    today = date.today()
    timestamp = now_iso()
    rows = con.execute(
        task_select(
            """
            where tasks.recurrence_interval != ''
              and tasks.recurrence_next_date is not null
              and tasks.recurrence_next_date <= ?
            """
        ),
        (today.isoformat(),),
    ).fetchall()

    for row in rows:
        task = row_to_dict(row)
        interval = clean_text(task.get("recurrence_interval"))
        if interval not in RECURRENCE_INTERVALS:
            continue
        run_date = next_business_date(parse_date_value(task.get("recurrence_next_date")) or today)
        while run_date <= today:
            run_date_text = run_date.isoformat()
            exists = con.execute(
                """
                select id from tasks
                where recurrence_source_id = ? and recurrence_run_date = ?
                """,
                (task["id"], run_date_text),
            ).fetchone()
            if not exists:
                due_date = due_date_for_recurrence(run_date).isoformat()
                child_id = con.execute(
                    """
                    insert into tasks (
                        title, description, assigned_user_id, category_id, status, priority,
                        due_date, related_link, related_links_json, attachment_path, attachment_name, attachment_type,
                        notes_mode, checklist_json, recurrence_interval, recurrence_next_date,
                        recurrence_source_id, recurrence_run_date, created_by, created_at, updated_at
                    ) values (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, '', null, ?, ?, ?, ?, ?)
                    """,
                    (
                        task["title"],
                        task.get("description"),
                        task["assigned_user_id"],
                        task.get("category_id"),
                        task["priority"],
                        due_date,
                        task.get("related_link"),
                        task.get("related_links_json") or "[]",
                        task.get("attachment_path"),
                        task.get("attachment_name"),
                        task.get("attachment_type"),
                        task.get("notes_mode") or "notes",
                        task.get("checklist_json") or "[]",
                        task["id"],
                        run_date_text,
                        task["created_by"],
                        timestamp,
                        timestamp,
                    ),
                ).lastrowid
                set_task_assignees(con, child_id, task_assignee_ids(task))
            run_date = next_business_date(add_recurrence_interval(run_date, interval))
        con.execute(
            "update tasks set recurrence_next_date = ?, updated_at = ? where id = ?",
            (run_date.isoformat(), timestamp, task["id"]),
        )


def ensure_seed_data(con):
    existing = con.execute("select count(*) as count from users").fetchone()["count"]
    if existing:
        return
    timestamp = now_iso()
    users = [
        ("Admin Yango", "admin@yango.local", "admin", "Operaciones", "admin123"),
        ("María Manager", "manager@yango.local", "manager", "Operaciones", "manager123"),
        ("Ana Colaborador", "ana@yango.local", "colaborador", "Operaciones", "ana123"),
        ("Carlos Colaborador", "carlos@yango.local", "colaborador", "Operaciones", "carlos123"),
    ]
    for name, email, role, team, password in users:
        con.execute(
            """
            insert into users (name, email, role, team, password_hash, active, created_at, updated_at)
            values (?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (name, email, role, team, hash_password(password), timestamp, timestamp),
        )
    categories = [
        ("Operaciones", "#ff1f1f", "Ejecución diaria"),
        ("Soporte", "#205db8", "Casos y tickets"),
        ("Growth", "#0a8f5a", "Campañas y mejoras"),
    ]
    for name, color, description in categories:
        con.execute(
            """
            insert into categories (name, color, description, active, created_at, updated_at)
            values (?, ?, ?, 1, ?, ?)
            """,
            (name, color, description, timestamp, timestamp),
        )
    ana = con.execute("select id from users where email = 'ana@yango.local'").fetchone()["id"]
    carlos = con.execute("select id from users where email = 'carlos@yango.local'").fetchone()["id"]
    ops = con.execute("select id from categories where name = 'Operaciones'").fetchone()["id"]
    support = con.execute("select id from categories where name = 'Soporte'").fetchone()["id"]
    sample_tasks = [
        ("Actualizar tablero semanal", "Revisar pendientes abiertos y cerrar tareas completadas.", [ana, carlos], ops, "in_progress", "media", "2026-07-10", "", ""),
        ("Responder ticket de facturación", "Necesita apoyo para validar el caso con soporte.", [carlos], support, "needs_help", "alta", "2026-07-08", "https://example.com/ticket/1234", ""),
        ("Preparar lista de prioridades", "", [ana], ops, "todo", "baja", "2026-07-15", "", ""),
    ]
    for title, description, assignee_ids, category_id, status, priority, due_date, related_link, attachment_path in sample_tasks:
        task_id = con.execute(
            """
            insert into tasks (
                title, description, assigned_user_id, category_id, status, priority,
                due_date, related_link, attachment_path, attachment_name, attachment_type,
                created_by, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 1, ?, ?)
            """,
            (
                title,
                description,
                assignee_ids[0],
                category_id,
                status,
                priority,
                due_date,
                related_link,
                attachment_path,
                timestamp,
                timestamp,
            ),
        ).lastrowid
        set_task_assignees(con, task_id, assignee_ids)


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.execute(
            """
            create table if not exists users (
                id integer primary key autoincrement,
                name text not null,
                email text not null unique,
                role text not null check (role in ('admin', 'manager', 'colaborador')),
                team text not null default 'Operaciones',
                password_hash text not null,
                active integer not null default 1,
                created_at text not null,
                updated_at text not null
            )
            """
        )
        con.execute(
            """
            create table if not exists categories (
                id integer primary key autoincrement,
                name text not null unique,
                color text not null default '#ff1f1f',
                description text,
                active integer not null default 1,
                created_at text not null,
                updated_at text not null
            )
            """
        )
        create_statuses_table(con)
        ensure_default_statuses(con)
        con.execute(tasks_table_sql())
        ensure_task_columns(con)
        ensure_tasks_status_flexible(con)
        con.execute(
            """
            create unique index if not exists idx_tasks_recurrence_instance
            on tasks(recurrence_source_id, recurrence_run_date)
            where recurrence_source_id is not null and recurrence_run_date is not null
            """
        )
        con.execute(
            """
            create table if not exists task_assignees (
                task_id integer not null references tasks(id) on delete cascade,
                user_id integer not null references users(id),
                primary key (task_id, user_id)
            )
            """
        )
        ensure_seed_data(con)
        migrate_task_assignees(con)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/dashboard", "/admin"):
            return send_file(self, STATIC_DIR / "index.html", "text/html; charset=utf-8")
        if parsed.path == "/static/styles.css":
            return send_file(self, STATIC_DIR / "styles.css", "text/css; charset=utf-8")
        if parsed.path == "/static/app.js":
            return send_file(self, STATIC_DIR / "app.js", "application/javascript; charset=utf-8")
        if parsed.path.startswith("/uploads/"):
            user = require_user(self)
            if user is None:
                return
            upload_relative = parsed.path.removeprefix("/uploads/").lstrip("/")
            target = (UPLOAD_DIR / upload_relative).resolve()
            upload_root = UPLOAD_DIR.resolve()
            if upload_root != target.parent and upload_root not in target.parents:
                return send_json(self, {"error": "No encontrado"}, 404)
            if not target.exists() or not target.is_file():
                return send_json(self, {"error": "No encontrado"}, 404)
            with db() as con:
                row = con.execute(
                    task_select("where tasks.attachment_path = ?"),
                    (f"uploads/{upload_relative}",),
                ).fetchone()
            if not row or not can_view_task(user, row_to_dict(row)):
                return send_json(self, {"error": "No autorizado"}, 403)
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            return send_file(self, target, content_type)
        if parsed.path == "/api/me":
            user = require_user(self)
            if user is None:
                return
            return send_json(self, {"user": user})
        if parsed.path == "/api/bootstrap":
            user = require_user(self)
            if user is None:
                return
            return send_json(
                self,
                {
                    "user": user,
                    "users": list_users_for(user),
                    "categories": list_categories(),
                    "statuses": list_statuses(),
                },
            )
        if parsed.path == "/api/users":
            user = require_user(self)
            if user is None:
                return
            return send_json(self, {"users": list_users_for(user)})
        if parsed.path == "/api/users/workload":
            user = require_user(self)
            if user is None:
                return
            return send_json(self, user_workload_for(user))
        if parsed.path == "/api/categories":
            user = require_user(self)
            if user is None:
                return
            return send_json(self, {"categories": list_categories()})
        if parsed.path == "/api/statuses":
            user = require_user(self)
            if user is None:
                return
            return send_json(self, {"statuses": list_statuses()})
        if parsed.path == "/api/tasks":
            user = require_user(self)
            if user is None:
                return
            tasks = list_tasks_for(user, parse_qs(parsed.query))
            return send_json(self, {"tasks": tasks})
        if parsed.path == "/api/export":
            user = require_user(self)
            if user is None:
                return
            tasks = list_tasks_for(user, parse_qs(parsed.query))
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(["Titulo", "Responsables", "Equipos", "Categoria", "Estado", "Prioridad", "Fecha limite", "Link", "Actualizado"])
            for item in tasks:
                writer.writerow(
                    [
                        item["title"],
                        item["assignee_name"],
                        item["assignee_team"],
                        item.get("category_name") or "",
                        item.get("status_label") or item["status"],
                        item["priority"],
                        item.get("due_date") or "",
                        " | ".join(item.get("related_links") or ([item.get("related_link")] if item.get("related_link") else [])),
                        item["updated_at"],
                    ]
                )
            return send_text(
                self,
                output.getvalue(),
                "text/csv; charset=utf-8",
                headers={"Content-Disposition": 'attachment; filename="yango-tareas.csv"'},
            )
        return send_json(self, {"error": "No encontrado"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            body = parse_json_body(self)
            if parsed.path == "/api/auth/login":
                email = clean_text(body.get("email")).lower()
                password = body.get("password", "")
                with db() as con:
                    row = con.execute(
                        "select * from users where lower(email) = ? and active = 1",
                        (email,),
                    ).fetchone()
                if not row or row["password_hash"] != hash_password(password):
                    return send_json(self, {"error": "Email o clave incorrectos"}, 401)
                user = public_user(row)
                token = make_token(user)
                return send_json(self, {"token": token, "user": user})

            user = require_user(self)
            if user is None:
                return

            if parsed.path == "/api/tasks/save":
                task_id = int(body.get("id") or 0)
                title = clean_text(body.get("title"))
                if not title:
                    return send_json(self, {"error": "El título es obligatorio"}, 400)
                status = clean_text(body.get("status")) or "todo"
                priority = clean_text(body.get("priority")) or "media"
                if priority not in ("alta", "media", "baja"):
                    return send_json(self, {"error": "Prioridad inválida"}, 400)
                notes_mode = clean_text(body.get("notes_mode")) or "notes"
                if notes_mode not in ("notes", "checklist"):
                    return send_json(self, {"error": "Modo de notas inválido"}, 400)
                checklist_json = json.dumps(normalize_checklist(body.get("checklist_items")), ensure_ascii=False)
                related_links = normalize_related_links(body.get("related_links"))
                if not related_links and clean_text(body.get("related_link")):
                    related_links = normalize_related_links(body.get("related_link"))
                related_link = related_links[0] if related_links else ""
                related_links_json = json.dumps(related_links, ensure_ascii=False)
                recurrence_interval, recurrence_next_date = normalize_recurrence(body)
                timestamp = now_iso()
                with DB_LOCK:
                    with db() as con:
                        if status not in status_keys(con):
                            return send_json(self, {"error": "Estado inválido"}, 400)
                        attachment_path, attachment_name, attachment_type = save_upload(body.get("attachment_file"))
                        if task_id:
                            current = get_task(con, task_id)
                            if not current:
                                return send_json(self, {"error": "Tarea no encontrada"}, 404)
                            current_data = row_to_dict(current)
                            if not can_edit_task(user, current_data):
                                return send_json(self, {"error": "No autorizado"}, 403)
                            assigned_user_ids = resolve_assignees(con, body, user, task_id=task_id)
                            if not attachment_path:
                                attachment_path = current_data.get("attachment_path")
                                attachment_name = current_data.get("attachment_name")
                                attachment_type = current_data.get("attachment_type")
                            con.execute(
                                """
                                update tasks set
                                    title = ?, description = ?, assigned_user_id = ?, category_id = ?,
                                    status = ?, priority = ?, due_date = ?, related_link = ?, related_links_json = ?,
                                    attachment_path = ?, attachment_name = ?, attachment_type = ?,
                                    notes_mode = ?, checklist_json = ?,
                                    recurrence_interval = ?, recurrence_next_date = ?,
                                    updated_at = ?
                                where id = ?
                                """,
                                (
                                    title,
                                    clean_text(body.get("description")),
                                    assigned_user_ids[0],
                                    int(body["category_id"]) if clean_text(body.get("category_id")) else None,
                                    status,
                                    priority,
                                    clean_text(body.get("due_date")),
                                    related_link,
                                    related_links_json,
                                    attachment_path,
                                    attachment_name,
                                    attachment_type,
                                    notes_mode,
                                    checklist_json,
                                    recurrence_interval,
                                    recurrence_next_date or None,
                                    timestamp,
                                    task_id,
                                ),
                            )
                            set_task_assignees(con, task_id, assigned_user_ids)
                        else:
                            assigned_user_ids = resolve_assignees(con, body, user)
                            task_id = con.execute(
                                """
                                insert into tasks (
                                    title, description, assigned_user_id, category_id, status, priority,
                                    due_date, related_link, related_links_json, attachment_path, attachment_name, attachment_type,
                                    notes_mode, checklist_json, recurrence_interval, recurrence_next_date,
                                    created_by, created_at, updated_at
                                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """,
                                (
                                    title,
                                    clean_text(body.get("description")),
                                    assigned_user_ids[0],
                                    int(body["category_id"]) if clean_text(body.get("category_id")) else None,
                                    status,
                                    priority,
                                    clean_text(body.get("due_date")),
                                    related_link,
                                    related_links_json,
                                    attachment_path,
                                    attachment_name,
                                    attachment_type,
                                    notes_mode,
                                    checklist_json,
                                    recurrence_interval,
                                    recurrence_next_date or None,
                                    user["id"],
                                    timestamp,
                                    timestamp,
                                ),
                            ).lastrowid
                            set_task_assignees(con, task_id, assigned_user_ids)
                        row = get_task(con, task_id)
                return send_json(self, {"task": public_task(row)}, 201 if not body.get("id") else 200)

            if parsed.path == "/api/tasks/status":
                task_id = int(body.get("id") or 0)
                status = clean_text(body.get("status"))
                timestamp = now_iso()
                with db() as con:
                    if status not in status_keys(con):
                        return send_json(self, {"error": "Estado inválido"}, 400)
                    current = get_task(con, task_id)
                    if not current:
                        return send_json(self, {"error": "Tarea no encontrada"}, 404)
                    if not can_edit_task(user, row_to_dict(current)):
                        return send_json(self, {"error": "No autorizado"}, 403)
                    con.execute(
                        "update tasks set status = ?, updated_at = ? where id = ?",
                        (status, timestamp, task_id),
                    )
                    row = get_task(con, task_id)
                return send_json(self, {"task": public_task(row)})

            if parsed.path == "/api/tasks/checklist":
                task_id = int(body.get("id") or 0)
                checklist_json = json.dumps(normalize_checklist(body.get("checklist_items")), ensure_ascii=False)
                timestamp = now_iso()
                with db() as con:
                    current = get_task(con, task_id)
                    if not current:
                        return send_json(self, {"error": "Tarea no encontrada"}, 404)
                    if not can_edit_task(user, row_to_dict(current)):
                        return send_json(self, {"error": "No autorizado"}, 403)
                    con.execute(
                        "update tasks set notes_mode = 'checklist', checklist_json = ?, updated_at = ? where id = ?",
                        (checklist_json, timestamp, task_id),
                    )
                    row = get_task(con, task_id)
                return send_json(self, {"task": public_task(row)})

            if parsed.path == "/api/tasks/delete":
                task_id = int(body.get("id") or 0)
                with db() as con:
                    current = get_task(con, task_id)
                    if not current:
                        return send_json(self, {"error": "Tarea no encontrada"}, 404)
                    if not can_edit_task(user, row_to_dict(current)):
                        return send_json(self, {"error": "No autorizado"}, 403)
                    con.execute("delete from task_assignees where task_id = ?", (task_id,))
                    con.execute("delete from tasks where id = ?", (task_id,))
                return send_json(self, {"ok": True})

            if parsed.path == "/api/categories/save":
                if not can_manage_admin_data(user):
                    return send_json(self, {"error": "Solo admin puede gestionar categorías"}, 403)
                category_id = int(body.get("id") or 0)
                name = clean_text(body.get("name"))
                if not name:
                    return send_json(self, {"error": "El nombre es obligatorio"}, 400)
                timestamp = now_iso()
                with db() as con:
                    if category_id:
                        con.execute(
                            "update categories set name = ?, color = ?, description = ?, active = ?, updated_at = ? where id = ?",
                            (name, clean_text(body.get("color")) or "#ff1f1f", clean_text(body.get("description")), 1 if body.get("active", True) else 0, timestamp, category_id),
                        )
                    else:
                        category_id = con.execute(
                            "insert into categories (name, color, description, active, created_at, updated_at) values (?, ?, ?, 1, ?, ?)",
                            (name, clean_text(body.get("color")) or "#ff1f1f", clean_text(body.get("description")), timestamp, timestamp),
                        ).lastrowid
                    row = con.execute("select * from categories where id = ?", (category_id,)).fetchone()
                return send_json(self, {"category": row_to_dict(row)})

            if parsed.path == "/api/categories/delete":
                if not can_manage_admin_data(user):
                    return send_json(self, {"error": "Solo admin puede gestionar categorías"}, 403)
                category_id = int(body.get("id") or 0)
                with db() as con:
                    used = con.execute("select count(*) as count from tasks where category_id = ?", (category_id,)).fetchone()["count"]
                    if used:
                        return send_json(self, {"error": "No se puede borrar una categoría con tareas asociadas"}, 400)
                    con.execute("delete from categories where id = ?", (category_id,))
                return send_json(self, {"ok": True})

            if parsed.path == "/api/statuses/save":
                if not can_manage_admin_data(user):
                    return send_json(self, {"error": "Solo admin puede gestionar estados"}, 403)
                status_key = clean_text(body.get("key"))
                label = clean_text(body.get("label"))
                color = clean_text(body.get("color")) or "#deded5"
                sort_order = int(body.get("sort_order") or 100)
                active = 1 if body.get("active", True) else 0
                if not label:
                    return send_json(self, {"error": "El nombre del estado es obligatorio"}, 400)
                timestamp = now_iso()
                with db() as con:
                    if status_key:
                        current = con.execute("select * from statuses where key = ?", (status_key,)).fetchone()
                        if not current:
                            return send_json(self, {"error": "Estado no encontrado"}, 404)
                        if status_key in SYSTEM_STATUS_KEYS:
                            active = 1
                        con.execute(
                            """
                            update statuses
                            set label = ?, color = ?, sort_order = ?, active = ?, updated_at = ?
                            where key = ?
                            """,
                            (label, color, sort_order, active, timestamp, status_key),
                        )
                    else:
                        status_key = unique_status_key(con, label)
                        max_order = con.execute("select coalesce(max(sort_order), 0) as value from statuses").fetchone()["value"]
                        if not body.get("sort_order"):
                            sort_order = int(max_order) + 10
                        con.execute(
                            """
                            insert into statuses (key, label, color, sort_order, active, system_key, is_done, created_at, updated_at)
                            values (?, ?, ?, ?, 1, 0, 0, ?, ?)
                            """,
                            (status_key, label, color, sort_order, timestamp, timestamp),
                        )
                    row = con.execute("select * from statuses where key = ?", (status_key,)).fetchone()
                return send_json(self, {"status": public_status(row)})

            if parsed.path == "/api/statuses/delete":
                if not can_manage_admin_data(user):
                    return send_json(self, {"error": "Solo admin puede gestionar estados"}, 403)
                status_key = clean_text(body.get("key"))
                if status_key in SYSTEM_STATUS_KEYS:
                    return send_json(self, {"error": "Este estado es base del tablero y no se puede borrar"}, 400)
                with db() as con:
                    used = con.execute("select count(*) as count from tasks where status = ?", (status_key,)).fetchone()["count"]
                    if used:
                        return send_json(self, {"error": "No se puede borrar un estado con tareas asociadas. Desactívalo o cambia esas tareas de estado."}, 400)
                    con.execute("delete from statuses where key = ?", (status_key,))
                return send_json(self, {"ok": True})

            if parsed.path == "/api/users/save":
                if not can_manage_admin_data(user):
                    return send_json(self, {"error": "Solo admin puede gestionar usuarios"}, 403)
                user_id = int(body.get("id") or 0)
                name = clean_text(body.get("name"))
                email = clean_text(body.get("email")).lower()
                role = clean_text(body.get("role")) or "colaborador"
                team = clean_text(body.get("team")) or "Operaciones"
                password = body.get("password", "")
                if not name or not email:
                    return send_json(self, {"error": "Nombre y email son obligatorios"}, 400)
                if role not in ("admin", "manager", "colaborador"):
                    return send_json(self, {"error": "Rol inválido"}, 400)
                timestamp = now_iso()
                with db() as con:
                    if user_id:
                        if password:
                            con.execute(
                                "update users set name = ?, email = ?, role = ?, team = ?, active = ?, password_hash = ?, updated_at = ? where id = ?",
                                (name, email, role, team, 1 if body.get("active", True) else 0, hash_password(password), timestamp, user_id),
                            )
                        else:
                            con.execute(
                                "update users set name = ?, email = ?, role = ?, team = ?, active = ?, updated_at = ? where id = ?",
                                (name, email, role, team, 1 if body.get("active", True) else 0, timestamp, user_id),
                            )
                    else:
                        if not password:
                            return send_json(self, {"error": "La clave es obligatoria para usuarios nuevos"}, 400)
                        user_id = con.execute(
                            """
                            insert into users (name, email, role, team, password_hash, active, created_at, updated_at)
                            values (?, ?, ?, ?, ?, 1, ?, ?)
                            """,
                            (name, email, role, team, hash_password(password), timestamp, timestamp),
                        ).lastrowid
                    row = con.execute("select * from users where id = ?", (user_id,)).fetchone()
                return send_json(self, {"user": public_user(row)})

            if parsed.path == "/api/users/delete":
                if not can_manage_admin_data(user):
                    return send_json(self, {"error": "Solo admin puede gestionar usuarios"}, 403)
                user_id = int(body.get("id") or 0)
                if user_id == user["id"]:
                    return send_json(self, {"error": "No puedes borrar tu propio usuario"}, 400)
                with db() as con:
                    used = con.execute(
                        """
                        select count(*) as count
                        from tasks
                        where assigned_user_id = ?
                           or exists (
                                select 1
                                from task_assignees
                                where task_assignees.task_id = tasks.id
                                  and task_assignees.user_id = ?
                           )
                        """,
                        (user_id, user_id),
                    ).fetchone()["count"]
                    if used:
                        return send_json(self, {"error": "No se puede borrar un usuario con tareas asignadas. Desactívalo o reasigna sus tareas."}, 400)
                    con.execute("delete from users where id = ?", (user_id,))
                return send_json(self, {"ok": True})

            return send_json(self, {"error": "No encontrado"}, 404)
        except sqlite3.IntegrityError as exc:
            return send_json(self, {"error": "Hay un dato duplicado o inválido", "details": str(exc)}, 400)
        except Exception as exc:
            return send_json(self, {"error": str(exc)}, 400)


def main():
    init_db()
    port = int(os.environ.get("PORT", "8787"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Yango tareas: http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
