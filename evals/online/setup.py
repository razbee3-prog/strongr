"""Create/replace the LangSmith online evaluators for the AI Trainer project.

  LANGSMITH_API_KEY=... python3 evals/online/setup.py [--project ai-trainer] [--backfill-days 7] [--print]
"""
import argparse, json, os, pathlib, urllib.request
from datetime import datetime, timedelta, timezone

HERE = pathlib.Path(__file__).parent
WORKOUT = json.loads((HERE.parent.parent / "src/workouts/full-body-10.json").read_text())
API = os.environ.get("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com") + "/api/v1"
RULES = {
    "AI Trainer: block evals": ("block.py", 'and(eq(is_root, false), eq(run_type, "chain"))'),
    "AI Trainer: workout evals": ("workout.py", 'and(eq(is_root, true), eq(name, "workout_session"))'),
}


def code(name):
    plan = [{"type": b["type"], "exercise": b.get("exercise")} for b in WORKOUT["blocks"]]
    src = (HERE / "common.py").read_text() + "\n\n" + (HERE / name).read_text()
    return src.replace("__PLAN__", repr(plan)).replace("__WORKOUT_ID__", repr(WORKOUT["id"]))


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"x-api-key": os.environ["LANGSMITH_API_KEY"], "content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        txt = r.read()
        return json.loads(txt) if txt else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=os.environ.get("LANGSMITH_PROJECT", "ai-trainer"))
    ap.add_argument("--backfill-days", type=float, default=0)
    ap.add_argument("--print", action="store_true", help="print the generated evaluator code and exit")
    a = ap.parse_args()
    if a.print:
        for name, (f, _) in RULES.items():
            print(f"# ==== {name}\n{code(f)}")
        return
    sessions = call("GET", f"/sessions?name={a.project}")
    if not sessions:
        raise SystemExit(f"no LangSmith project named {a.project}")
    sid = sessions[0]["id"]
    existing = {r["display_name"]: r["id"] for r in call("GET", f"/runs/rules?session_id={sid}") or []}
    for name, (f, flt) in RULES.items():
        body = {"display_name": name, "session_id": sid, "is_enabled": True, "sampling_rate": 1.0, "filter": flt,
                "code_evaluators": [{"code": code(f), "language": "python"}]}
        if a.backfill_days:
            body["backfill_from"] = (datetime.now(timezone.utc) - timedelta(days=a.backfill_days)).isoformat()
        r = call("POST", "/runs/rules", body)
        if name in existing:
            call("DELETE", f"/runs/rules/{existing[name]}")
        print(f"{'replaced' if name in existing else 'created'} {name}: {r['id']}")


if __name__ == "__main__":
    main()
