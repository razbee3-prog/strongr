"""Offline check of the online evaluators: python3 evals/online/test_evaluators.py"""
import copy, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from setup import code

def load(f):
    ns = {}
    exec(code(f), ns)
    return ns["perform_eval"]

block, workout = load("block.py"), load("workout.py")
T0 = 1_793_900_000

def iso(s):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(T0 + s, timezone.utc).isoformat().replace("+00:00", "Z")

def squat_block():
    reps = [{"type": "rep", "t": iso(2.5 * (k + 1)), "n": k + 1, "min_knee_angle": 120 if k < 3 else 85, "faults": ["depth"] if k < 3 else []} for k in range(12)]
    cues = [{"type": "cue_fired", "t": iso(5), "fault": "depth", "rep": 2}, {"type": "cue_resolved", "t": iso(12.5), "fault": "depth", "rep": 5}]
    return {"name": "block_1_squat", "start_time": iso(0), "end_time": iso(40), "inputs": {"index": 1, "type": "exercise", "exercise": "squat", "mode": "reps"},
            "outputs": {"actual_reps": 12, "ended_by": "target", "reps": reps, "cues": cues, "tracking_lost": []},
            "events": [{"name": e["type"], "time": e["t"], "kwargs": e} for e in reps + cues]}

root = {"name": "workout_session", "start_time": iso(0), "end_time": iso(700), "inputs": {"workout_id": "full-body-10"},
        "outputs": {"completed": True, "total_reps": 66, "blocks_done": 11, "avg_fps": 28}}

clean = block(squat_block())
assert clean == {"trace_structure": True, "privacy": True, "cue_timing": True, "cue_persistence": True, "cue_priority": True, "praise_after_fix": True}, clean
assert workout(root) == {"trace_structure": True, "fps_at_least_20": True, "privacy": True}, workout(root)
rest = {"name": "rest_3", "inputs": {"index": 3, "type": "rest"}, "outputs": {"reps": [], "cues": []}}
assert block(rest) == {"trace_structure": True, "privacy": True}

def mutate(f):
    b = squat_block(); f(b); return block(b)
def mroot(f):
    r = copy.deepcopy(root); f(r); return workout(r)

cases = [
    ("trace_structure", lambda: mutate(lambda b: b["inputs"].update(exercise="reverse_lunge"))),
    ("trace_structure", lambda: mroot(lambda r: r["outputs"].update(blocks_done=9))),
    ("fps_at_least_20", lambda: mroot(lambda r: r["outputs"].update(avg_fps=14))),
    ("cue_spacing", lambda: mutate(lambda b: b["outputs"]["cues"].append({"type": "cue_fired", "t": iso(11), "fault": "depth", "rep": 4}))),
    ("cue_timing", lambda: mutate(lambda b: b["outputs"]["cues"][0].update(rep=1))),
    ("cue_timing", lambda: mutate(lambda b: b["outputs"]["cues"][0].update(t=iso(-2)))),
    ("cue_persistence", lambda: mutate(lambda b: b["outputs"]["reps"][0].update(faults=[]))),
    ("cue_priority", lambda: mutate(lambda b: [b["outputs"]["reps"][k]["faults"].append("knees_caving") for k in (0, 1)])),
    ("praise_after_fix", lambda: mutate(lambda b: b["outputs"]["cues"].pop())),
    ("privacy", lambda: mutate(lambda b: b["outputs"].update(landmarks=[[{"x": 0, "y": 0}]]))),
    ("privacy", lambda: mroot(lambda r: r["inputs"].update(snap="data:image/png;base64,AAAA"))),
]
for key, f in cases:
    assert f()[key] is False, (key, f())
print(f"online evaluators ok: clean runs pass, {len(cases)} faulty runs caught")
