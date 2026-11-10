# Runs on every block run (child of workout_session) as soon as the block ends.
def perform_eval(run):
    i = run.get("inputs") or {}
    o = run.get("outputs") or {}
    idx = i.get("index")
    want = PLAN[idx] if isinstance(idx, int) and 0 <= idx < len(PLAN) else None
    out = {
        "trace_structure": bool(want) and want.get("type") == i.get("type") and want.get("exercise") == i.get("exercise"),
        "privacy": not run_leaks(run),
    }
    reps = o.get("reps") or []
    cues = o.get("cues") or []
    fired = [c for c in cues if c.get("type") == "cue_fired"]
    if not fired:
        return out

    times = sorted(t for t in (ts(c.get("t")) for c in fired) if t is not None)
    if len(times) >= 2:
        out["cue_spacing"] = all(b - a >= CUE_GAP_S for a, b in zip(times, times[1:]))

    # Block runs start when the active phase starts (after intro + countdown).
    start, end = ts(run.get("start_time")), ts(run.get("end_time"))

    def in_active(c):
        t = ts(c.get("t"))
        return t is not None and (start is None or t >= start) and (end is None or t <= end)

    out["cue_timing"] = all((c.get("rep") or 0) >= 2 and in_active(c) for c in fired)

    persistent = top_ok = True
    for c in fired:
        n = c.get("rep") or 0
        window = [r for r in reps if n - 3 < (r.get("n") or 0) <= n]
        count = lambda f: sum(f in (r.get("faults") or []) for r in window)
        if count(c.get("fault")) < 2:
            persistent = False
        top = next((f for f in FAULT_PRIORITY if count(f) >= 2), None)
        if top and top != c.get("fault"):
            top_ok = False
    out["cue_persistence"] = persistent
    out["cue_priority"] = top_ok

    # Praise exactly when a cued fault has been gone for 2 reps.
    fired_at = {c.get("rep"): c.get("fault") for c in fired}
    praised_at = {c.get("rep"): c.get("fault") for c in cues if c.get("type") == "cue_resolved"}
    ok, active = True, None
    for r in reps:
        n, due = r.get("n"), None
        if active:
            if active[0] in (r.get("faults") or []):
                active[1] = 0
            else:
                active[1] += 1
                if active[1] >= 2:
                    due, active = active[0], None
        if due and praised_at.get(n) != due:
            ok = False
        if not due and n in praised_at:
            ok = False
        if n in fired_at:
            active = [fired_at[n], 0]
    out["praise_after_fix"] = ok
    return out
