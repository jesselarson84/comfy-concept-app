// AI menus on the canvas right-click:
//   AI Models    > 3D / Image / Video / Audio (> sub section) > <model preset>
//   AI Workflows > Textures / Concept / VFX / 3D Assets / Sound > <multi-step workflow>
// The same presets as the Comfy Concept app's picker (Models | Workflows tabs).
// The manifest and the API-format graphs are written by the app's
// scripts/sync-comfy-menu.mjs from its workflows/ai/*.json; don't edit them here.
// Uses only documented frontend APIs: app.registerExtension, setup(),
// getCanvasMenuItems(), app.loadGraphData() (UI-format files) and
// app.loadApiJson() (API-format files). Files are static JSON served from this
// pack's WEB_DIRECTORY.
import { app } from "../../scripts/app.js";

const BASE = new URL("./workflows/", import.meta.url).href;
let manifest = null;

async function loadManifest() {
  try {
    const r = await fetch(BASE + "manifest.json", { cache: "no-store" });
    manifest = r.ok ? await r.json() : null;
  } catch (e) {
    console.error("[AI menu] could not load manifest", e);
    manifest = null;
  }
}

async function openWorkflow(entry) {
  const title = entry.path.split("/").pop();
  try {
    const r = await fetch(BASE + entry.file, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const graph = await r.json();
    if (entry.format === "api") {
      // API-format graph (the app's preset): loaded as a new tab, then laid out.
      await app.loadApiJson(graph, `${title}.json`);
      try { app.graph.arrange?.(); app.graph.setDirtyCanvas?.(true, true); } catch {}
    } else {
      // 4th arg = workflow name -> the frontend opens it as a new temporary tab
      // (current tab's state is kept as a draft), same as opening a workflow file.
      await app.loadGraphData(graph, true, true, title);
    }
  } catch (e) {
    console.error("[AI menu] failed to open", entry.file, e);
    alert(`${entry.menu === "workflows" ? "AI Workflows" : "AI Models"}: could not open "${title}": ${e.message}`);
  }
}

/** Tree of one menu: its groups in order, then folders from each entry's path. */
function buildTree(menu) {
  const root = { children: new Map(), items: [] };
  for (const g of menu.groups ?? []) root.children.set(g, { children: new Map(), items: [] });
  for (const entry of (manifest.entries ?? []).filter((e) => e.menu === menu.key)) {
    const parts = entry.path.split("/");
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (!node.children.has(p)) node.children.set(p, { children: new Map(), items: [] });
      node = node.children.get(p);
    }
    node.items.push(entry);
  }
  return root;
}

function toOptions(node) {
  const opts = [];
  for (const [label, child] of node.children) {
    const sub = toOptions(child);
    opts.push(
      sub.length
        ? { content: label, submenu: { options: sub } }
        : { content: `${label} (none installed yet)`, disabled: true }
    );
  }
  for (const entry of node.items) {
    opts.push({ content: entry.path.split("/").pop(), callback: () => openWorkflow(entry) });
  }
  return opts;
}

app.registerExtension({
  name: "Local.AIWorkflowMenu",
  async setup() {
    await loadManifest();
  },
  getCanvasMenuItems() {
    if (!manifest?.menus) return [];
    return [
      null,
      ...manifest.menus.map((m) => ({ content: m.label, submenu: { options: toOptions(buildTree(m)) } })),
    ];
  },
});
