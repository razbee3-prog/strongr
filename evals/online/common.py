# Shared helpers for the LangSmith online code evaluators. setup.py prepends this file to block.py / workout.py
# and replaces __PLAN__ / __WORKOUT_ID__ with the workout from src/workouts/full-body-10.json.
import re
from datetime import datetime

PLAN = __PLAN__
WORKOUT_ID = __WORKOUT_ID__
FAULT_PRIORITY = ["knees_caving", "depth", "uneven", "balance"]
CUE_GAP_S = 15.0 - 0.25
MIN_FPS = 20
BAD_KEY = re.compile(r"landmark|image|frame|video|pixel|base64|keypoint|norm", re.I)


def ts(v):
    """Seconds since epoch from an ISO string, datetime, or epoch number (s or ms)."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else float(v)
    if hasattr(v, "timestamp"):
        return v.timestamp()
    s = str(v).replace("Z", "+00:00")
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    if not re.search(r"[+-]\d\d:\d\d$", s):
        s += "+00:00"
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def leaks(v, depth=0):
    """True if anything looks like video, images, or per-frame landmarks."""
    if depth > 12:
        return False
    if isinstance(v, str):
        return bool(re.match(r"data:(image|video)/", v)) or (len(v) > 2000 and re.fullmatch(r"[A-Za-z0-9+/=]+", v) is not None)
    if isinstance(v, list):
        if len(v) >= 20 and all(isinstance(x, dict) and "x" in x and "y" in x for x in v):
            return True
        return any(leaks(x, depth + 1) for x in v)
    if isinstance(v, dict):
        return any(BAD_KEY.search(str(k)) or leaks(x, depth + 1) for k, x in v.items())
    return False


def run_leaks(run):
    return any(leaks(run.get(part)) for part in ("inputs", "outputs", "events"))
