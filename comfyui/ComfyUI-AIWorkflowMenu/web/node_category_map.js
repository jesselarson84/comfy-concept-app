// Re-files node categories for the right-click Add Node menu AND the node library / search,
// without touching ComfyUI core or any node pack's source. Display-only: node type names,
// saved workflows and execution are unchanged (category is UI metadata).
//
// Hooks used (all in the official ComfyExtension interface, src/types/comfy.ts):
//   addCustomNodeDefs(defs)            -> Python node defs, before LiteGraph registration
//   beforeRegisterVueAppNodeDefs(defs) -> node library / search defs (incl. frontend-only nodes)
//   setup()                            -> frontend-only LiteGraph classes (Note, Reroute, PrimitiveNode...)
// Disable by deleting this file (or setting ENABLED=false) and reloading the page.
import { app } from "../../scripts/app.js";

const ENABLED = true;

// --- model families: model/{conditioning,latent,patch}/<family> are gathered per family ----
const FAMILY = {
  // Video
  "wan": "Video/Model-specific/Wan",
  "ltxv": "Video/Model-specific/LTX-Video",
  "hunyuan video": "Video/Model-specific/HunyuanVideo",
  "cosmos": "Video/Model-specific/Cosmos",
  "minimax": "Video/Model-specific/MiniMax H3",
  "kandinsky": "Video/Model-specific/Kandinsky 5",
  "stable video": "Video/Model-specific/Stable Video Diffusion",
  "autoregressive": "Video/Model-specific/Autoregressive Video",
  "void": "Video/Model-specific/VOID",
  "mochi": "Video/Model-specific/Mochi",
  // Audio
  "ace": "Audio/Model-specific/ACE-Step",
  "stable audio": "Audio/Model-specific/Stable Audio",
  "minimax music": "Audio/Model-specific/MiniMax Music 3",
  "yue2": "Audio/Model-specific/YuE2",
  // 3D
  "hunyuan 3d": "3D/Model-specific/Hunyuan3D",
  "trellis": "3D/Model-specific/TRELLIS.2 & Pixal3D",
  "triposplat": "3D/Model-specific/TripoSplat",
  "stable video 3d": "3D/Model-specific/SV3D",
  "stable zero123": "3D/Model-specific/Zero123",
  // Image
  "seedvr": "Image/Upscale/SeedVR2",
  "flux": "Image/Model-specific/FLUX",
  "qwen image": "Image/Model-specific/Qwen-Image",
  "qwen": "Image/Model-specific/Qwen-Image",
  "z-image": "Image/Model-specific/Z-Image",
  "hidream": "Image/Model-specific/HiDream",
  "lumina": "Image/Model-specific/Lumina",
  "pixart": "Image/Model-specific/PixArt",
  "chroma radiance": "Image/Model-specific/Chroma",
  "stable cascade": "Image/Model-specific/Stable Cascade",
  "stable diffusion": "Image/Model-specific/Stable Diffusion",
  "stable diffusion upscaler": "Image/Upscale/SD 4x Upscaler",
  "hunyuan image": "Image/Model-specific/Hunyuan Image",
  "boogu": "Image/Model-specific/Boogu",
  "bernini": "Image/Model-specific/Bernini",
  "fibo": "Image/Model-specific/FIBO",
  "joyimage": "Image/Model-specific/JoyImage",
  "mage": "Image/Model-specific/Mage-Flow",
  "ming image": "Image/Model-specific/Ming Image",
  "moss_image": "Image/Model-specific/MOSS Image",
  "lotus": "Image/Model-specific/Lotus",
  "sensenova": "Image/Model-specific/SenseNova",
  "anima": "Image/Model-specific/Anima",
  "supir": "Image/Upscale/SUPIR",
  "photomaker": "Image/Model-specific/PhotoMaker",
  "instructpix2pix": "Image/Model-specific/InstructPix2Pix",
};

// --- prefix rules: [oldPrefix, newPrefix]; longest prefix wins; the rest of the path is kept ---
const PREFIX = [
  // Loading
  ["model/loaders", "Load Models"],
  ["bootleg", "Load Models/GGUF"],                       // ComfyUI-GGUF loaders
  ["advanced/multigpu", "Load Models/Multi-GPU"],
  // Conditioning
  ["model/conditioning", "Conditioning"],
  ["model/conditioning/transform", "Conditioning/Combine, Area & Mask"],
  ["model/conditioning/controlnet", "Conditioning/ControlNet"],
  ["model/conditioning/gligen", "Conditioning/GLIGEN"],
  ["advanced/hooks", "Conditioning/Hooks"],
  // Sampling
  ["model/sampling", "Sampling"],
  ["model/sampling/custom", "Sampling/Custom Sampling"],
  ["model/sampling/guiders", "Sampling/Custom Sampling/Guiders"],
  ["model/sampling/noise", "Sampling/Custom Sampling/Noise"],
  ["model/sampling/samplers", "Sampling/Custom Sampling/Samplers"],
  ["model/sampling/schedulers", "Sampling/Custom Sampling/Schedulers"],
  ["model/sampling/sigmas", "Sampling/Custom Sampling/Sigmas"],
  ["advanced/guidance", "Sampling/Guidance"],
  ["model/patch", "Sampling/Model Patches"],
  ["model/patch/unet", "Sampling/Model Patches/UNet"],
  // Latent
  ["model/latent", "Latent"],
  ["latent", "Latent"],
  ["model/latent/advanced", "Latent/Advanced"],
  ["model/latent/batch", "Latent/Batch"],
  ["model/latent/transform", "Latent/Transform"],
  // Image
  ["image", "Image"],
  ["image/upscaling", "Image/Upscale"],
  ["image/color", "Image/Color & Filters"],
  ["image/adjustments", "Image/Color & Filters"],
  ["image/filters", "Image/Color & Filters"],
  ["image/shader", "Image/Color & Filters/Shader"],
  ["image/detection", "Image/Detection & Segmentation"],
  ["image/background removal", "Image/Detection & Segmentation"],
  ["image/geometry estimation", "Image/Depth & Geometry"],
  ["image/pre-processors", "Image/Upscale/SeedVR2"],
  ["image/post-processors", "Image/Upscale/SeedVR2"],
  ["image/video", "Video/Model-specific/Wan"],           // WanDancer keyframe helpers
  // Video / Audio / 3D
  ["video", "Video"],
  ["audio", "Audio"],
  ["3d", "3D"],
  ["3d/mesh", "3D/Mesh"],
  ["3d/splat", "3D/Gaussian Splat"],
  ["3d/texturing", "3D/Texturing"],
  // Text & utilities
  ["text", "Text & Utilities/Text"],
  ["utilities", "Text & Utilities"],
  ["utilities/primitive", "Text & Utilities/Primitives"],
  ["utilities/logic", "Text & Utilities/Logic"],
  ["utilities/looping", "Text & Utilities/Looping"],
  ["sd", "Text & Utilities/Looping"],                    // LoopIteration/LoopProgress/LoopResult
  ["utils", "Text & Utilities/Graph"],                   // frontend-only Note/Reroute/Primitive...
  ["utils/string", "Text & Utilities/Text"],             // TTS Audio Suite string helper
  ["advanced/debug", "Text & Utilities/Debug & Performance"],
  // Training / merging / experimental
  ["model/merging", "Training & Merging/Merging"],
  ["model/training", "Training & Merging/Training"],
  ["experimental", "Experimental"],
  // Custom packs installed today
  ["ImageSaver", "Custom Packs/Image Saver"],
  ["CivitaiAPI", "Custom Packs/Image Saver/Civitai (online hash lookup)"],
  // Dialogue / TTS packs (approved, not yet installed) - categories read from their GitHub source
  ["WMNodes/sound/tts", "Audio/Dialogue & TTS"],        // wildminder Chatterbox + VibeVoice (refined by module below)
  ["WMNodes/sound/vc", "Audio/Dialogue & TTS/Chatterbox/Voice Conversion"],
  ["WMNodes/sound/util", "Audio/Dialogue & TTS/Chatterbox/Utilities"],
  ["WMNodes/sound/asr", "Audio/Dialogue & TTS/VibeVoice/Speech to Text"],
  ["TTS Audio Suite", "Audio/Dialogue & TTS/TTS Audio Suite"],
  ["ChatterBox Voice", "Audio/Dialogue & TTS/TTS Audio Suite/ChatterBox Voice"],
  ["F5-TTS Voice", "Audio/Dialogue & TTS/TTS Audio Suite/F5-TTS Voice"],
  // tidy capitalisation of kept sub-folders
  ["image/batch", "Image/Batch"],
  ["image/mask", "Image/Mask"],
  ["image/compositing", "Image/Compositing"],
  ["image/transform", "Image/Transform"],
  ["video/batch", "Video/Batch"],
  ["video/transform", "Video/Transform"],
  ["video/preprocessors", "Video/Preprocessors"],
  ["experimental/attention_experiments", "Experimental/Attention"],
  ["experimental/stable cascade", "Experimental/Stable Cascade"],
  ["model/merging/model specific", "Training & Merging/Merging/Model-specific"],
  ["model/latent/advanced/operations", "Latent/Advanced/Operations"],
  ["ImageSaver/utils", "Custom Packs/Image Saver/Utilities"],
];

// --- per-pack rules by python_module (custom_nodes.<folder>), checked before prefixes -------
const MODULE = [
  // Image Saver scatters nodes over conditioning/, utils/, image/generators -> keep them together
  [/^custom_nodes\.comfyui-image-saver/i, (cat) => {
    if (cat.startsWith("ImageSaver") || cat.startsWith("CivitaiAPI")) return null; // prefix rules handle it
    return "Custom Packs/Image Saver/Extras";
  }],
  [/^custom_nodes\.[^.]*chatterbox/i, (cat) => cat === "WMNodes/sound/tts" ? "Audio/Dialogue & TTS/Chatterbox" : null],
  [/^custom_nodes\.[^.]*vibevoice/i, (cat) => cat === "WMNodes/sound/tts" ? "Audio/Dialogue & TTS/VibeVoice" : null],
];

// --- per-node overrides -------------------------------------------------------------------------
const NODE = {
  wanBlockSwap: "Video/Model-specific/Wan",              // has an empty category in core
  SeedVR2Conditioning: "Image/Upscale/SeedVR2",
  LoadMoGeModel: "Load Models",
};

const NEW_ROOTS = ["Load Models", "Conditioning", "Sampling", "Latent", "Image", "Video", "Audio", "3D",
  "Text & Utilities", "Training & Merging", "Experimental", "Custom Packs", "Subgraph Blueprints"];
const SORTED_PREFIX = [...PREFIX].sort((a, b) => b[0].length - a[0].length);
const FAMILY_ROOTS = ["model/conditioning/", "model/latent/", "model/patch/", "model/sampling/"];

export function remapCategory(category, pythonModule = "", name = "") {
  const cat = category ?? "";
  if (NEW_ROOTS.some((r) => cat === r || cat.startsWith(r + "/"))) return cat; // already re-filed (idempotent)
  if (name in NODE) return NODE[name];
  for (const [re, fn] of MODULE) {
    if (re.test(pythonModule || "")) {
      const r = fn(cat);
      if (r) return r;
    }
  }
  for (const root of FAMILY_ROOTS) {
    if (cat.startsWith(root)) {
      const fam = cat.slice(root.length).split("/")[0];
      if (fam in FAMILY) return FAMILY[fam];
    }
  }
  for (const [oldP, newP] of SORTED_PREFIX) {
    if (cat === oldP) return newP;
    if (cat.startsWith(oldP + "/")) return newP + cat.slice(oldP.length);
  }
  if (cat.startsWith("custom_nodes") || pythonModule.startsWith("custom_nodes.")) {
    // unknown custom pack: file under Custom Packs/<pack>/<original category>
    const pack = (pythonModule.split(".")[1] || "Other").split("@")[0];
    return `Custom Packs/${pack}/${cat || "Uncategorized"}`;
  }
  return cat; // anything unknown (e.g. partner/API nodes if re-enabled) stays where it was
}

if (ENABLED) {
  app.registerExtension({
    name: "Local.AIWorkflowMenu.NodeCategoryMap",
    addCustomNodeDefs(defs) {
      for (const [name, def] of Object.entries(defs)) {
        def.category = remapCategory(def.category, def.python_module, name);
      }
    },
    beforeRegisterVueAppNodeDefs(defs) {
      for (const def of defs) {
        def.category = remapCategory(def.category, def.python_module, def.name);
      }
    },
    setup() {
      const LG = window.LiteGraph;
      if (!LG?.registered_node_types) return;
      for (const [type, cls] of Object.entries(LG.registered_node_types)) {
        if (cls?.nodeData?.python_module && !cls.nodeData.python_module.startsWith("custom_nodes.frontend_only")) continue; // python nodes done above
        if (typeof cls.category === "string") cls.category = remapCategory(cls.category, "", type);
      }
    },
  });
}
