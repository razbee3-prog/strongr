# Runs on each workout_session root run when the workout ends.
def perform_eval(run):
    i = run.get("inputs") or {}
    o = run.get("outputs") or {}
    fps = o.get("avg_fps")
    done = o.get("blocks_done")
    structure = i.get("workout_id") == WORKOUT_ID and isinstance(done, int) and 0 <= done <= len(PLAN)
    if o.get("completed") is True:
        structure = structure and done == len(PLAN)
    return {
        "trace_structure": structure,
        "fps_at_least_20": isinstance(fps, (int, float)) and fps >= MIN_FPS,
        "privacy": not run_leaks(run),
    }
