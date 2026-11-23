"""ComfyUI-AIWorkflowMenu (local, frontend-only).

Adds an "AI Workflow" entry to the canvas right-click menu (3D / Image / Video / Audio
submenus, one ready-made workflow per installed free local model family) and, optionally,
re-files node categories in the Add Node menu / node library via the documented
frontend extension hooks. No Python nodes, no network calls, no model downloads.
"""
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
