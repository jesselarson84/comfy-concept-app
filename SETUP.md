# Setting up Comfy UI (the Comfy Concept app)

This guide takes you from a fresh clone to using the app on your phone or tablet. Do the steps in order; each one says how to check that it worked.

```
phone / tablet --HTTPS over Tailscale--> this app (Node, 127.0.0.1:3100 on the PC) --localhost--> ComfyUI (127.0.0.1:8188)
```

The app runs on the same Windows PC as ComfyUI. Your phone only ever talks to the app, through Tailscale. ComfyUI is never opened to the network.

**Contents**

1. [What you need](#1-what-you-need)
2. [Install ComfyUI](#2-install-comfyui)
3. [Install the custom nodes](#3-install-the-custom-nodes)
4. [Download the models](#4-download-the-models)
5. [Get the app and start it](#5-get-the-app-and-start-it)
6. [Configure it (config.local.json)](#6-configure-it-configlocaljson)
7. [Keep it running](#7-keep-it-running)
8. [Reach it from your phone with Tailscale](#8-reach-it-from-your-phone-with-tailscale)
9. [Install it on the phone or tablet](#9-install-it-on-the-phone-or-tablet)
10. [Claude features (optional)](#10-claude-features-optional)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. What you need

- **A Windows PC with an NVIDIA GPU.** The presets were tuned on an 11 GB card (RTX 2080 Ti); bigger cards just get more headroom. The app checks free VRAM and RAM and tells you when a preset is tight or will spill into system RAM.
- **ComfyUI Desktop** (section 2).
- **Node.js 22 or newer**: https://nodejs.org (the LTS installer is fine). Check with `node --version`.
- **git**: https://git-scm.com/download/win
- **Tailscale** on the PC and on every phone or tablet (section 8).
- **Disk space.** The full model set (section 4) is well over 150 GB. You only need the models of the presets you use.
- **Optional:** an Anthropic API key with credits, for the Claude features (section 10).

## 2. Install ComfyUI

1. Install **Comfy Desktop** from https://www.comfy.org/download and finish its first-run setup.
2. Leave its network settings at their defaults. ComfyUI must stay on **localhost only** (port 8188). You do **not** need `--listen`: the app runs on the same PC and talks to ComfyUI over localhost.
3. Check: open http://127.0.0.1:8188/ on the PC and you see the ComfyUI canvas.

Where things live in Comfy Desktop (you'll need these paths below; `<you>` is your Windows user name):

| What | Folder |
|---|---|
| Models | `C:\Users\<you>\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models\` |
| Outputs | `C:\Users\<you>\AppData\Local\Comfy-Desktop\ComfyUI-Shared\output\` |
| Custom nodes | `C:\Users\<you>\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\` |

If you installed ComfyUI another way (portable, manual), use its own `models`, `output` and `custom_nodes` folders instead.

## 3. Install the custom nodes

Most presets use only ComfyUI's built-in nodes. These need extra node packs. Install them with **ComfyUI Manager** (in Comfy Desktop: *Manager* → *Custom Nodes Manager*, search the name, Install), then restart ComfyUI.

| Node pack | Used by |
|---|---|
| **ComfyUI-GGUF** (city96) | FLUX.1 Dev / Schnell / Fill, Qwen Image Edit 2511, Concept Looks (FLUX.1 Dev), and the Texture workflows built on Qwen Edit 2511 |
| **comfyui_controlnet_aux** (Fannovel16) | Concept Looks (Pose, FLUX.1 Dev, Qwen-Image): the DWPose pose detector. It downloads its own small detector files on first use. |
| **ComfyUI-Inpaint-CropAndStitch** (lquesada) | FLUX.1 Fill and Klein 4B Inpaint |
| **comfyui-inpaint-nodes** (Acly) | FLUX.1 Fill and Klein 4B Inpaint |
| **ComfyUI-Chatterbox** (wildminder) | Chatterbox TTS, Chatterbox Voice Swap, Voice Line with Sound, Voice Line in Any Voice |
| **ComfyUI-VibeVoice** (wildminder) | VibeVoice TTS |
| **ComfyUI-Chord** | PBR Maps (CHORD) only. Research-only license, see the model list. |

Also install the app's own menu add-on, which adds the **AI Models** / **AI Workflows** entries to ComfyUI's right-click menu (handy in the node view). From the app folder, after section 5:

```
node scripts/sync-comfy-menu.mjs --install "C:\Users\<you>\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes"
```

You don't need any of this to start the app: a preset whose node pack is missing simply shows **missing node** in the picker.

## 4. Download the models

Put each file in the `models` subfolder named in the table (create the subfolder if it doesn't exist), then restart ComfyUI or press *Refresh* in it. You only need the rows for the presets you want: the app's preset picker shows **needs download** (with the missing file name) for anything that's not there yet. The app never downloads models itself.

Some models have their own license. Check it on the model's page before using results commercially (notably CHORD, which is research-only, and FLUX.1 Dev / Fill, which are non-commercial).

### Image

| File | Folder | Download | Used by |
|---|---|---|---|
| `z_image_turbo_bf16.safetensors` | `diffusion_models` | [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors) | Z-Image Turbo (the default preset), Concept Looks, Make Seamless, Grunge Map, Photo to Texture |
| `qwen_3_4b.safetensors` | `text_encoders` | [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors) | Z-Image Turbo, FLUX.2 Klein 4B (all) |
| `ae.safetensors` | `vae` | [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors) | Z-Image Turbo, FLUX.1 (all) |
| `flux-2-klein-base-4b.safetensors` | `diffusion_models` | [Comfy-Org/flux2-klein](https://huggingface.co/Comfy-Org/flux2-klein/resolve/main/split_files/diffusion_models/flux-2-klein-base-4b.safetensors) | FLUX.2 Klein 4B Text to Image |
| `flux-2-klein-4b.safetensors` | `diffusion_models` | [black-forest-labs/FLUX.2-klein-4b-fp8](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b.safetensors) | FLUX.2 Klein 4B Image Edit, Inpaint, and Share → app |
| `flux2-vae.safetensors` | `vae` | [Comfy-Org/flux2-dev](https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors) | FLUX.2 Klein 4B (all) |
| `flux1-dev-Q5_K_S.gguf` | `diffusion_models` | [city96/FLUX.1-dev-gguf](https://huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/flux1-dev-Q5_K_S.gguf) | FLUX.1 Dev, Concept Looks (FLUX.1 Dev) |
| `flux1-schnell-Q5_K_S.gguf` | `diffusion_models` | [city96/FLUX.1-schnell-gguf](https://huggingface.co/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q5_K_S.gguf) | FLUX.1 Schnell |
| `flux1-fill-dev-Q5_K_S.gguf` | `diffusion_models` | [YarvixPA/FLUX.1-Fill-dev-GGUF](https://huggingface.co/YarvixPA/FLUX.1-Fill-dev-GGUF/resolve/main/flux1-fill-dev-Q5_K_S.gguf) | FLUX.1 Fill (inpaint / outpaint) |
| `t5xxl_fp8_e4m3fn.safetensors` | `text_encoders` | [comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors) | FLUX.1 (all) |
| `clip_l.safetensors` | `text_encoders` | [comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors) | FLUX.1 (all) |
| `qwen_image_2512_fp8_e4m3fn.safetensors` | `diffusion_models` | [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors) | Qwen 2512, Concept Looks (Qwen-Image) |
| `qwen-image-2512-Q5_K_M.gguf` | `diffusion_models` | [unsloth/Qwen-Image-2512-GGUF](https://huggingface.co/unsloth/Qwen-Image-2512-GGUF/resolve/main/qwen-image-2512-Q5_K_M.gguf) | Qwen 2512 on GPUs under 12 GB (used there instead of the fp8 file) |
| `Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors` | `loras` | [lightx2v/Qwen-Image-2512-Lightning](https://huggingface.co/lightx2v/Qwen-Image-2512-Lightning/resolve/main/Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors) | Qwen 2512, Concept Looks (Qwen-Image) |
| `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `diffusion_models` | [Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors) | Qwen Image Edit 2509 |
| `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `loras` | [lightx2v/Qwen-Image-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors) | Qwen Image Edit 2509 |
| `qwen-image-edit-2511-Q5_K_M.gguf` | `diffusion_models` | [unsloth/Qwen-Image-Edit-2511-GGUF](https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF/resolve/main/qwen-image-edit-2511-Q5_K_M.gguf) | Qwen Image Edit 2511, Remove Lighting, Photo to Texture, Photo to 3D Model |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | `loras` | [lightx2v/Qwen-Image-Edit-2511-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors) | the same as Qwen Image Edit 2511 |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `text_encoders` | [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors) | every Qwen preset |
| `qwen_image_vae.safetensors` | `vae` | [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors) | every Qwen preset |
| `seedvr2_7b_int8_convrot.safetensors` | `diffusion_models` | [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_7b_int8_convrot.safetensors) | SeedVR2 7B (image upscale) |
| `seedvr2_ema_vae_fp16.safetensors` | `vae` | [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors) | SeedVR2 (image and video) |
| `4x-UltraSharp.safetensors` | `upscale_models` | [Kim2091/UltraSharp](https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.safetensors) | 4x Model (upscale), Upscale Texture, Photo to Texture, and the 4K resolution option |

### Concept and texture workflows (extra files)

| File | Folder | Download | Used by |
|---|---|---|---|
| `Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors` (full, 6.7 GB) | `model_patches` | [alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1](https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1/resolve/main/Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors) | Concept Looks (Edges, Depth, Pose) |
| `Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors` (lite, 2 GB) | `model_patches` | [alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1](https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1/resolve/main/Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors) | Make Seamless, Photo to Texture |
| `FLUX.1-dev-ControlNet-Union-Pro-2.0.safetensors` | `controlnet` | [Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro-2.0](https://huggingface.co/Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro-2.0/resolve/main/diffusion_pytorch_model.safetensors). The file downloads as `diffusion_pytorch_model.safetensors`: **rename it** to the name on the left. | Concept Looks (FLUX.1 Dev) |
| `Qwen-Image-InstantX-ControlNet-Union.safetensors` | `controlnet` | [Comfy-Org/Qwen-Image-InstantX-ControlNets](https://huggingface.co/Comfy-Org/Qwen-Image-InstantX-ControlNets/resolve/main/split_files/controlnet/Qwen-Image-InstantX-ControlNet-Union.safetensors) | Concept Looks (Qwen-Image). See [Troubleshooting](#black-images-from-concept-looks-qwen-image-on-rtx-20-series) for RTX 20-series cards. |
| `depth_anything_3_base.safetensors` | `geometry_estimation` | [Comfy-Org/Depth-Anything-3](https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_base.safetensors) | Concept Looks (Depth, FLUX.1 Dev, Qwen-Image) |
| `moge_2_vitl_normal_fp16.safetensors` | `geometry_estimation` | [Comfy-Org/MoGe](https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_2_vitl_normal_fp16.safetensors) | Depth + Normal, Pixal3D |
| `chord_v1.safetensors` | `checkpoints` | [Ubisoft/ubisoft-laforge-chord](https://huggingface.co/Ubisoft/ubisoft-laforge-chord) (sign in and accept the terms first). **Research-only license.** | PBR Maps (CHORD). Needs the ComfyUI-Chord node pack. |

PBR Maps (the non-CHORD one) needs no model at all.

### 3D

| File | Folder | Download | Used by |
|---|---|---|---|
| `hunyuan_3d_v2.1.safetensors` | `checkpoints` | [Comfy-Org/hunyuan3D_2.1_repackaged](https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged/resolve/main/hunyuan_3d_v2.1.safetensors) | Hunyuan3D 2.1, Photo to 3D Model |
| `birefnet.safetensors` | `background_removal` | [Comfy-Org/BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors) | Hunyuan3D 2.1, Pixal3D, Photo to 3D Model |
| `pixal3d_int8_convrot.safetensors` | `diffusion_models` | [Comfy-Org/Pixal3D](https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/diffusion_models/pixal3d_int8_convrot.safetensors) | Pixal3D |
| `trellis_2_int8_convrot.safetensors` | `diffusion_models` | [Comfy-Org/TRELLIS.2](https://huggingface.co/Comfy-Org/TRELLIS.2/resolve/main/diffusion_models/trellis_2_int8_convrot.safetensors) | Pixal3D |
| `trellis_2_shape_vae_bf16.safetensors` | `vae` | [Comfy-Org/Pixal3D](https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_shape_vae_bf16.safetensors) | Pixal3D |
| `trellis_2_texture_vae_bf16.safetensors` | `vae` | [Comfy-Org/Pixal3D](https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_texture_vae_bf16.safetensors) | Pixal3D |
| `dino_v3_L_naf_fp32.safetensors` | `clip_vision` | [Comfy-Org/Pixal3D](https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/clip_vision/dino_v3_L_naf_fp32.safetensors) | Pixal3D |

### Video

| File | Folder | Download | Used by |
|---|---|---|---|
| `wan2.2_ti2v_5B_fp16.safetensors` | `diffusion_models` | [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors) | Wan 2.2 5B (video), Flipbook Sheet |
| `wan2.2_vae.safetensors` | `vae` | [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors) | Wan 2.2 5B (video), Flipbook Sheet |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders` | [Comfy-Org/Wan_2.1_ComfyUI_repackaged](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors) | Wan 2.2 5B (video), Flipbook Sheet |
| `seedvr2_3b_int8_convrot.safetensors` | `diffusion_models` | [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors) | SeedVR2 Video Upscale (also needs `seedvr2_ema_vae_fp16` above) |
| `RealESRGAN_x4plus.safetensors` | `upscale_models` | [Comfy-Org/Real-ESRGAN_repackaged](https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors) | Real-ESRGAN Video Upscale |

### Audio

| File | Folder | Download | Used by |
|---|---|---|---|
| `acestep_v1.5_turbo.safetensors` | `diffusion_models` | [Comfy-Org/ace_step_1.5_ComfyUI_files](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_turbo.safetensors) | ACE-Step 1.5 (music) |
| `qwen_0.6b_ace15.safetensors` | `text_encoders` | [Comfy-Org/ace_step_1.5_ComfyUI_files](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors) | ACE-Step 1.5 |
| `qwen_1.7b_ace15.safetensors` | `text_encoders` | [Comfy-Org/ace_step_1.5_ComfyUI_files](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_1.7b_ace15.safetensors) | ACE-Step 1.5 |
| `ace_1.5_vae.safetensors` | `vae` | [Comfy-Org/ace_step_1.5_ComfyUI_files](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors) | ACE-Step 1.5 |
| `stable_audio_3_small_sfx.safetensors` | `checkpoints` | [Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/checkpoints/stable_audio_3_small_sfx.safetensors) | Stable Audio 3 SFX, Sound Effect Set, Voice Line with Sound |
| `t5gemma_b_b_ul2.safetensors` | `text_encoders` | [Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/text_encoders/t5gemma_b_b_ul2.safetensors) | the same as Stable Audio 3 SFX |
| `t3_cfg.safetensors`, `s3gen.safetensors`, `ve.safetensors` | `chatterbox\chatterbox\` | [ResembleAI/chatterbox](https://huggingface.co/ResembleAI/chatterbox/tree/main) | Chatterbox TTS, Chatterbox Voice Swap, Voice Line with Sound, Voice Line in Any Voice |
| the whole `VibeVoice-1.5B` repo (3 `model-0000x-of-00003.safetensors` files plus its `.json` files) | `tts\VibeVoice\VibeVoice-1.5B\` | [microsoft/VibeVoice-1.5B](https://huggingface.co/microsoft/VibeVoice-1.5B/tree/main) | VibeVoice TTS |

The Chatterbox and VibeVoice node packs can also fetch their own models on first use. If a preset still shows **needs download**, put the files in the folders above yourself.

**Check:** open the app's preset picker (section 5). Every preset whose files and nodes are in place shows normally; the rest are greyed out with the reason.

## 5. Get the app and start it

1. Clone the repo:
   ```
   git clone https://github.com/<owner>/comfy-concept-app.git
   cd comfy-concept-app
   ```
2. Install the one dependency (the Claude SDK; without it everything works except Claude):
   ```
   npm install
   ```
3. Start ComfyUI first, then the app: double-click `start.bat`, or run `npm start`.
4. **Check:** open http://127.0.0.1:3100/ on the PC. You see the form with the preset picker at the top. If it says *ComfyUI not reachable*, see [Troubleshooting](#comfyui-not-reachable).

`start.bat` uses `runtime\node.exe` if it exists and otherwise your installed Node. The `runtime` folder isn't in git; README.md ("Bundled Node runtime") explains how to put a pinned Node there if you want one.

## 6. Configure it (config.local.json)

`config.json` holds the shared defaults and is committed. **Don't edit it for your own PC.** Put your own settings in `config.local.json` next to it: git ignores that file, so your paths never end up in the repo. Anything you put there overrides `config.json`, and environment variables override both.

A sample `config.local.json` (every key is optional; replace the `<…>` parts):

```json
{
  "comfyUrl": "http://127.0.0.1:8188",
  "port": 3100,
  "comfyOutputDir": "C:\\Users\\<you>\\AppData\\Local\\Comfy-Desktop\\ComfyUI-Shared\\output"
}
```

- `comfyUrl`: where ComfyUI listens. Default `http://127.0.0.1:8188`; at startup the app also tries 8000.
- `port`: the app's own port. Default 3100. If you change it, use the new port in section 8 too.
- `comfyOutputDir`: ComfyUI's output folder. The app needs it to delete files from **Files** and for the *From Comfy UI* picker. It can usually find it by itself, but setting it is the most reliable. Backslashes are doubled in JSON.

The full list of settings is in README.md under **Run it**. The app keeps its own data (history, settings, the Claude key) in `data\`, which is also git-ignored.

## 7. Keep it running

- **Start it hidden at sign-in:** double-click `install-autostart.bat` once. It adds a small launcher to your Windows Startup folder and starts the app now. `remove-autostart.bat` undoes it.
- **Start it hidden now, without autostart:** double-click `start-background.vbs`. Its log goes to `data\server.log`.
- **Stop it:** `stop-app.bat`.
- **Tray icon (optional):** `tools\tray\Tray.vbs` adds a tray icon with Start / Stop / Restart / Open log. See `tools\tray\README.md`.

The app and ComfyUI are separate programs: keep Comfy Desktop running too.

## 8. Reach it from your phone with Tailscale

Tailscale gives your PC a private HTTPS address that only your own devices can reach. Nothing is opened to the internet.

1. **Install Tailscale** on the PC (https://tailscale.com/download/windows) and on the phone or tablet (Play Store or App Store). Sign in with the **same account** everywhere.
2. In the **Tailscale admin console** (https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS Certificates**.
3. **Publish the app** on the PC. Double-click `enable-remote.bat`, or run in a terminal:
   ```
   tailscale serve --bg 3100
   ```
   It prints an address like `https://<pc-name>.<tailnet>.ts.net/`. That address forwards to the app on `127.0.0.1:3100` and handles HTTPS and websockets. Tailscale remembers it after a restart.
   - `tailscale serve status` shows the address again.
   - `tailscale serve reset` turns it off.
   - Don't use `tailscale funnel`: that would put the app on the public internet. The app has no login of its own; anyone in your tailnet can use it.
4. **Check:** on the phone, with Tailscale connected, open `https://<pc-name>.<tailnet>.ts.net/`. You see the same form as on the PC.

## 9. Install it on the phone or tablet

**Android (recommended):** open the HTTPS address from section 8 in **Chrome**, then menu → **Install app** (or *Add to Home screen*). It then:

- opens full screen like a normal app, as **Comfy UI**;
- appears in the Android **Share** sheet: share a photo or screenshot to Comfy UI and it opens on an image-edit preset with that picture loaded.

The install option and the Share entry only appear over HTTPS, which is why section 8 matters.

**iPhone / iPad:** open the address in Safari → Share → **Add to Home Screen**. It works as a web app; the Android Share-sheet entry isn't available there.

**Android wrapper app (optional):** there's also a small native Android app that wraps the same page and adds saving to the gallery, sharing and voice input. How it's built and installed is in [ANDROID_SPEC.md](ANDROID_SPEC.md) and `android/README-ANDROID.md`.

## 10. Claude features (optional)

Claude is **off by default**. With it on, the app can write prompts for you (the ⋮ on Prompt and Negative prompt), fix a result, work with several pictures from Files, and chat about ComfyUI through the floating Claude button, which can also set up the form and build workflows. Everything else in the app works without it.

It uses the **Anthropic API**, which is billed separately from a Claude.ai subscription:

1. **Make an account** at https://platform.claude.com and add a payment method.
2. **Buy credits** on the console's Billing page. The API is prepaid: requests stop when the credits run out.
3. **Make a separate Workspace** for this app in the console, and give it a **monthly spend limit**. This is your backstop if something goes wrong.
4. **Create an API key in that Workspace.** Copy it; it starts with `sk-ant-`.
5. **Put the key in the app:** on the PC or phone, open **Settings** (gear, top right) → **Claude** → paste the key → **Save**, then turn on **Use Claude**. The key is stored only on the PC, in `data\claude-key.json` (git-ignored); the phone never sees it. Alternatively set the `ANTHROPIC_API_KEY` environment variable on the PC before starting the app.
6. **Set the in-app monthly limit** in the same Settings card (default **$20**). The app adds up the real cost of every request and stops using Claude for the rest of the month once the limit is reached. The bar in Settings shows how much is used and when it resets.

You can also pick which model Claude starts on (Haiku is cheapest, Opus is strongest). Fixing pictures, variations and building workflows always use Opus.

**Check:** the floating Claude button appears in the bottom right of the form. Ask it a question.

## 11. Troubleshooting

### ComfyUI not reachable

- Make sure Comfy Desktop is running and http://127.0.0.1:8188/ opens on the PC.
- If your ComfyUI uses another port, set `comfyUrl` in `config.local.json` (section 6) and restart the app.
- Don't add `--listen` to ComfyUI. It's not needed and it opens ComfyUI to your network.

### A preset says "needs download" or "missing node"

Tap the greyed-out preset: it names the missing file or node. Add the model (section 4) or the node pack (section 3), restart ComfyUI, then reopen the picker. The app re-checks every minute.

### Black images from Concept Looks (Qwen-Image) on RTX 20-series

GPUs without bf16 support (for example the RTX 20-series, like the 2080 Ti) can give **all-black images** with Qwen-Image plus the InstantX ControlNet. The model runs, but the result is black. Use **Concept Looks (Edges / Depth / Pose)**, which use Z-Image Turbo, or **Concept Looks (FLUX.1 Dev)** on those cards. RTX 30-series and newer support bf16 and are not affected.

### Out of memory, or very slow

The picker marks presets that are tight on your card or will use system RAM. If a run fails with out of memory, the next run of that preset decodes in tiles automatically. Closing other GPU programs (games, browsers with many tabs, local LLMs) helps. Choose a smaller resolution or batch.

### The phone can't open the address

- Tailscale must be **connected** on both the PC and the phone, signed in to the same account.
- On the PC, `tailscale serve status` should show the address pointing at port 3100.
- The app must be running: http://127.0.0.1:3100/ opens on the PC.
- MagicDNS and HTTPS Certificates must be on in the Tailscale admin console.

### No "Install app" option, or Comfy UI isn't in the Share sheet

Both need the **HTTPS** Tailscale address opened in Chrome, not `http://` or an IP address. The Share entry only appears after the app is installed.

### Deleting from Files fails ("ComfyUI output folder is unknown")

Set `comfyOutputDir` in `config.local.json` (section 6) and restart the app. If a single file can't be deleted because it's open somewhere (for example a 3D model still loading), close it and try again.

### Claude: "No API key", "The API key was refused" or "Monthly limit reached"

- No key: add it in Settings → Claude (section 10).
- Refused: the key was revoked or mistyped. Create a new one in your Workspace and use **Replace…** in Settings.
- Limit reached: the in-app limit is used up for this month. Raise it in Settings, or wait for the reset date shown there. If the app's limit isn't reached but requests still fail, check your credits and the Workspace limit at platform.claude.com.
- *The Claude SDK is not installed*: run `npm install` in the app folder, then restart the app.

### Where to look

- The app's log: `data\server.log` (when started hidden), or the console window of `start.bat`.
- ComfyUI's own log: Comfy Desktop shows it (look for *Logs* in its menu), and errors also show in ComfyUI's page at http://127.0.0.1:8188/.
