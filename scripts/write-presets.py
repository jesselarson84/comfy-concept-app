# One-off generator for the two shipped presets (kept so the graph is easy to read/change).
import json, os
here = os.path.dirname(os.path.abspath(__file__))
wfdir = os.path.join(here, '..', 'workflows')
loaders = {
  "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein-4b.safetensors", "weight_dtype": "default"}, "_meta": {"title": "Load Diffusion Model"}},
  "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "flux2", "device": "default"}, "_meta": {"title": "Load CLIP"}},
  "3": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}, "_meta": {"title": "Load VAE"}},
}
tail = lambda prefix, pos, neg, sigmas, latent: {
  "53": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}, "_meta": {"title": "KSamplerSelect"}},
  "54": {"class_type": "RandomNoise", "inputs": {"noise_seed": 101}, "_meta": {"title": "Seed #seed"}},
  "55": {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": pos, "negative": neg, "cfg": 1.0}, "_meta": {"title": "CFGGuider"}},
  "56": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["54", 0], "guider": ["55", 0], "sampler": ["53", 0], "sigmas": sigmas, "latent_image": latent}, "_meta": {"title": "SamplerCustomAdvanced"}},
  "57": {"class_type": "VAEDecode", "inputs": {"samples": ["56", 0], "vae": ["3", 0]}, "_meta": {"title": "VAE Decode"}},
  "58": {"class_type": "SaveImage", "inputs": {"images": ["57", 0], "filename_prefix": prefix}, "_meta": {"title": "Save Image"}},
}
prompt = {"class_type": "CLIPTextEncode", "inputs": {"text": "concept art of a lighthouse on a cliff at dusk, dramatic sky", "clip": ["2", 0]}, "_meta": {"title": "Prompt #prompt"}}

fast = dict(loaders)
fast.update({
  "40": prompt,
  # klein is distilled for cfg 1: the negative is just a zeroed copy of the positive.
  "44": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["40", 0]}, "_meta": {"title": "Zero negative"}},
  "51": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}, "_meta": {"title": "Empty Flux 2 Latent"}},
  "52": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": 1024, "height": 1024}, "_meta": {"title": "Flux2Scheduler"}},
})
fast.update(tail("concept", ["40", 0], ["44", 0], ["52", 0], ["51", 0]))

ref = dict(loaders)
ref.update({
  "10": {"class_type": "LoadImage", "inputs": {"image": "example.png"}, "_meta": {"title": "Reference #image"}},
  "11": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["10", 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 16}, "_meta": {"title": "Scale to 1MP"}},
  "12": {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["3", 0]}, "_meta": {"title": "VAE Encode"}},
  "40": prompt,
  # Same reference-latent pattern as the klein_ref test workflows: the reference
  # is attached to BOTH the positive and the zeroed negative conditioning.
  "41": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["40", 0], "latent": ["12", 0]}, "_meta": {"title": "ReferenceLatent"}},
  "44": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["40", 0]}, "_meta": {"title": "Zero negative"}},
  "45": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["44", 0], "latent": ["12", 0]}, "_meta": {"title": "ReferenceLatent (neg)"}},
  "50": {"class_type": "GetImageSize", "inputs": {"image": ["11", 0]}, "_meta": {"title": "Get Image Size"}},
  "52": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": ["50", 0], "height": ["50", 1]}, "_meta": {"title": "Flux2Scheduler"}},
  # Strength = how much of the schedule is run on top of the reference latent.
  # 1.0 = full re-generation (still guided by ReferenceLatent); lower = closer to the reference.
  "60": {"class_type": "SplitSigmasDenoise", "inputs": {"sigmas": ["52", 0], "denoise": 0.75}, "_meta": {"title": "Strength #strength"}},
})
ref.update(tail("reference", ["41", 0], ["45", 0], ["60", 1], ["12", 0]))

for name, wf in [("fast-concept.json", fast), ("from-reference-image.json", ref)]:
    with open(os.path.join(wfdir, name), "w", newline="\n") as f:
        json.dump(wf, f, indent=2)
        f.write("\n")
print("written")
