"""ComfyUI-AIWorkflowMenu (local).

Adds an "AI Workflow" entry to the canvas right-click menu (3D / Image / Video / Audio
submenus, one ready-made workflow per installed free local model family) and, optionally,
re-files node categories in the Add Node menu / node library via the documented
frontend extension hooks. No Python nodes, no model downloads.

Batch 12 (Comfy UI app): progress for every job. ComfyUI sends live progress
("step 12 of 30", "now running node 7") only to the browser window that queued the
job, so the phone app could not show a percentage for jobs started in desktop
ComfyUI. This keeps a copy of the latest progress of whatever job is running and
answers it at GET /concept/progress (read-only, same machine/port as ComfyUI).
It only reads events ComfyUI already sends; nothing about how jobs run changes.
"""
import time

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

_progress = {}


def _record(event, data):
    """Keep the running job's prompt id, current node, step value/max and nodes done."""
    try:
        if not isinstance(data, dict):
            return
        pid = data.get("prompt_id")
        if not pid:
            return
        if event == "execution_start" or _progress.get("prompt_id") != pid:
            _progress.clear()
            _progress.update(prompt_id=pid, started=time.time(), node=None, value=0, max=0, nodes_done=0, done=False)
        if event == "executing":
            node = data.get("node")
            if node is None:
                _progress.update(done=True, node=None)
            else:
                if _progress.get("node") is not None:
                    _progress["nodes_done"] = _progress.get("nodes_done", 0) + 1
                _progress.update(node=str(node), value=0, max=0)
        elif event == "progress":
            _progress.update(value=data.get("value", 0) or 0, max=data.get("max", 0) or 0)
            if data.get("node") is not None:
                _progress["node"] = str(data.get("node"))
        elif event == "execution_cached":
            _progress["cached"] = len(data.get("nodes") or [])
        elif event in ("execution_success", "execution_error", "execution_interrupted"):
            _progress.update(done=True)
        _progress["updated"] = time.time()
    except Exception:  # never let this break ComfyUI's own messages
        pass


def _install():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return
    inst = getattr(PromptServer, "instance", None)
    if inst is None or getattr(inst, "_concept_progress", False):
        return
    original = inst.send_sync

    def send_sync(event, data, sid=None):
        _record(event, data)
        return original(event, data, sid)

    inst.send_sync = send_sync
    inst._concept_progress = True

    @inst.routes.get("/concept/progress")
    async def concept_progress(request):
        return web.json_response(dict(_progress))


_install()
