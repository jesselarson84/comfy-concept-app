// concept_sidebar.js - batch 22: the Comfy UI app (the phone / tablet app's server on this
// PC) as a "Concept" tab in ComfyUI's left sidebar, next to Assets, Nodes, Models...
// The tab shows the app's own page in a frame, so it is the same app as on the phone:
// presets, prompt, batches, Files, projects and Claude. The node graph stays where it is
// beside it (so the app hides its node-view button there: /?in=comfy).
// Uses only the documented frontend API: app.registerExtension and
// app.extensionManager.registerSidebarTab (type "custom": render(el) fills the panel).
// Drag the panel's edge to make it wider; ComfyUI's default sidebar width is too narrow
// for the app, so the first time it opens narrower than MIN_WIDTH it is widened once.
import { app } from "../../scripts/app.js";

// The app's server (config.json "port", default 3100). It always runs on this PC.
const APP_URL = "http://127.0.0.1:3100/?in=comfy";
const MIN_WIDTH = 420;
const START_WIDTH = 460;

let frame = null;

/** One frame for the whole session (re-attached when the tab opens again). */
function appFrame() {
  if (frame) return frame;
  frame = document.createElement("iframe");
  frame.src = APP_URL;
  frame.title = "Comfy UI app";
  // camera / microphone for Import and Talk prompt, clipboard for Copy prompt
  frame.allow = "camera; microphone; clipboard-read; clipboard-write";
  frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:#171718";
  return frame;
}

/** Widen the sidebar panel once if it is narrower than the app needs (nothing is saved). */
function widen(el) {
  const panel = el.closest(".side-bar-panel");
  if (!panel || panel.dataset.conceptWidened) return;
  panel.dataset.conceptWidened = "1";
  const row = panel.parentElement;
  const total = row?.getBoundingClientRect().width || 0;
  if (!total || panel.getBoundingClientRect().width >= MIN_WIDTH) return;
  const k = Math.min(60, (START_WIDTH / total) * 100);
  for (const c of row.children) {
    if (!/flex:/.test(c.getAttribute("style") || "")) continue;
    c.style.flex = c === panel ? `${k} 1 0px` : `${100 - k} 1 0px`;
  }
}

app.registerExtension({
  name: "ComfyConcept.Sidebar",
  async setup() {
    const em = app.extensionManager;
    if (!em?.registerSidebarTab) {
      console.warn("[Concept] this ComfyUI frontend has no sidebar tab API");
      return;
    }
    em.registerSidebarTab({
      id: "concept-app",
      icon: "pi pi-mobile",
      title: "Concept",
      tooltip: "Comfy UI app",
      type: "custom",
      render: (el) => {
        el.style.height = "100%";
        el.replaceChildren(appFrame());
        requestAnimationFrame(() => widen(el));
      },
    });
  },
});
