import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path


class TaskOkrTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = str(Path(self.temp.name) / "test.db")
        os.environ["UPLOAD_DIR"] = str(Path(self.temp.name) / "uploads")
        meeting_brief = types.ModuleType("meeting_brief")
        meeting_brief.create_table = lambda con: None
        sys.modules["meeting_brief"] = meeting_brief
        import app

        self.app = app
        app.DB_PATH = Path(os.environ["DB_PATH"])
        app.UPLOAD_DIR = Path(os.environ["UPLOAD_DIR"])
        app.AUTH_TOKENS.clear()
        app.init_db()
        with app.db() as con:
            timestamp = app.now_iso()
            con.execute(
                """insert into users (name, email, role, team, password_hash, active, created_at, updated_at)
                   values (?, ?, ?, ?, ?, 1, ?, ?)""",
                ("HR Manager", "hr@test", "area_manager", "HR", "unused", timestamp, timestamp),
            )
            self.user_ids = {row["email"]: row["id"] for row in con.execute("select id, email from users")}
        self.tokens = {
            email: app.make_token({"id": user_id}) for email, user_id in self.user_ids.items()
        }

    def tearDown(self):
        self.temp.cleanup()

    def request(self, email, path, payload=None):
        handler = self.app.Handler.__new__(self.app.Handler)
        handler.path = path
        handler.wfile = io.BytesIO()
        raw = json.dumps(payload).encode() if payload is not None else b""
        handler.rfile = io.BytesIO(raw)
        handler.headers = {
            "Authorization": "Bearer " + self.tokens[email],
            "Content-Length": str(len(raw)),
        }
        handler.send_response = lambda status: setattr(handler, "status", status)
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        (handler.do_POST if payload is not None else handler.do_GET)()
        return handler.status, json.loads(handler.wfile.getvalue())

    @staticmethod
    def objective(name, objective_id=None):
        return {
            "id": objective_id,
            "regional_priorities": name,
            "key_north_stars": "North",
            "kpi1_description": "KPI 1",
            "kpi1_from": "1",
            "kpi1_to": "2",
            "kpi2_description": "KPI 2",
            "kpi2_from": "1",
            "kpi2_to": "2",
            "proposed_projects": "Project",
            "kpi_owner": "Owner",
        }

    def test_task_links_stay_with_the_right_area_and_survive_okr_edits(self):
        admin, hr = "admin@yango.local", "hr@test"
        for email, name in ((admin, "Ops goal"), (hr, "HR goal")):
            status, result = self.request(email, "/api/okrs/save", {
                "period_from": "2026-10", "period_to": "2026-12",
                "objectives": [self.objective(name)],
            })
            self.assertEqual((status, result.get("error")), (200, None))

        admin_options = self.request(admin, "/api/task-okrs")[1]["objectives"]
        hr_options = self.request(hr, "/api/task-okrs")[1]["objectives"]
        self.assertEqual(len(admin_options), 2)
        self.assertEqual(len(hr_options), 1)
        self.assertEqual(hr_options[0]["team"], "HR")
        hr_id = hr_options[0]["id"]
        ops_id = next(item["id"] for item in admin_options if item["team"] == "Operaciones")

        task = {
            "title": "Linked task", "assigned_user_ids": [self.user_ids[hr]],
            "status": "todo", "priority": "media", "okr_objective_id": hr_id,
        }
        status, result = self.request(hr, "/api/tasks/save", task)
        self.assertEqual(status, 201, result)
        task["id"] = result["task"]["id"]
        self.assertEqual(result["task"]["okr_objective_id"], hr_id)

        task["okr_objective_id"] = ops_id
        self.assertEqual(self.request(hr, "/api/tasks/save", task)[0], 400)
        task["okr_objective_id"] = hr_id
        task["assigned_user_ids"] = [self.user_ids[admin]]
        self.assertEqual(self.request(admin, "/api/tasks/save", task)[0], 400)
        task["okr_objective_id"] = ""
        self.assertEqual(self.request(admin, "/api/tasks/save", task)[0], 200)

        task["assigned_user_ids"] = [self.user_ids[hr]]
        task["okr_objective_id"] = hr_id
        self.assertEqual(self.request(admin, "/api/tasks/save", task)[0], 200)
        period = self.request(hr, "/api/okrs")[1]["periods"][0]
        status, result = self.request(hr, "/api/okrs/save", {
            "id": period["id"], "period_from": "2026-10", "period_to": "2026-12",
            "objectives": [self.objective("HR goal revised", hr_id)],
        })
        self.assertEqual(status, 200, result)
        tasks = self.request(hr, "/api/tasks")[1]["tasks"]
        self.assertEqual(tasks[0]["okr_objective_id"], hr_id)

        with self.app.db() as con:
            con.execute("update users set can_view_okrs = 0 where id = ?", (self.user_ids[hr],))
        self.assertEqual(self.request(hr, "/api/task-okrs")[1]["objectives"], [])
        hidden_task = self.request(hr, "/api/tasks")[1]["tasks"][0]
        self.assertIsNone(hidden_task["okr_objective_id"])
        self.assertTrue(hidden_task["okr_linked_elsewhere"])
        task["okr_objective_id"] = ""
        self.assertEqual(self.request(hr, "/api/tasks/save", task)[0], 400)
        del task["okr_objective_id"]
        self.assertEqual(self.request(hr, "/api/tasks/save", task)[0], 200)
        with self.app.db() as con:
            self.assertEqual(con.execute(
                "select okr_objective_id from tasks where id = ?", (task["id"],)
            ).fetchone()["okr_objective_id"], hr_id)

        status, result = self.request(admin, "/api/okrs/delete", {"id": period["id"]})
        self.assertEqual(status, 200, result)
        with self.app.db() as con:
            self.assertIsNone(con.execute(
                "select okr_objective_id from tasks where id = ?", (task["id"],)
            ).fetchone()["okr_objective_id"])


if __name__ == "__main__":
    unittest.main()
