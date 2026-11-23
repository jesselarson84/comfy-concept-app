// chat-context.js - builds the messages sent to Ollama for one Chat turn.
// -----------------------------------------------------------------------------
// The prompt box is the single source of truth. On EVERY turn the system
// message is rebuilt with what is in the box right now (prompt + negative if
// it is on), the active preset, the images the chat knows (img1, img2...) and
// the available workflow actions. The conversation so far follows; for
// assistant turns we replay the reply plus any prompt it proposed, so the
// model remembers what it suggested.
// Images: only the newest user message carries image bytes (base64), which
// is what Ollama's /api/chat expects in messages[].images. Older images are
// referred to by their img id in text, to keep requests small.
// -----------------------------------------------------------------------------
import { actionsForPrompt } from './actions.js';
import { presetLabel } from './legacy-presets.js';

const STYLE = {
  flux2: `The image model is FLUX.2 [klein] 4B. It understands plain natural language, so write prompts as 1-3 clear descriptive sentences: subject first, then key details (shape, colour, material, pose), setting, lighting, camera/framing and style or medium. No tag soup, no weights like (word:1.3), no "masterpiece/best quality", no negative-prompt words inside the prompt. It has NO negative prompt, so describe what you DO want ("an empty, quiet street at dawn") instead of what to avoid ("no people, no cars").`,
  generic: `Write prompts as clear natural-language descriptions: subject first, then details, setting, lighting, framing and style.`,
};

export function styleFor(workflow) {
  // A preset can say how its prompt box is used (manifest "assistant"), e.g.
  // Photo to Texture: the box holds edit notes, not a picture description.
  if (workflow?.ai?.assistant) return workflow.ai.assistant;
  const nodes = Object.values(workflow?.workflow || {});
  const flux2 = nodes.some((n) => /flux-?2|klein/i.test(JSON.stringify(n.inputs || {})) || /Flux2/.test(n.class_type));
  return flux2 ? STYLE.flux2 : STYLE.generic;
}

/**
 * @param o.current   { prompt, negative, negativeOn, hasNegative, preset, workflow }
 * @param o.history   [{ role, content, prompt?, images?: [ref] }]
 * @param o.images    { img1: { prompt, seed, preset, filename } }  known images
 * @param o.actions   valid actions [{ id, manifest }]
 * @param o.userText  the new message
 * @param o.newImages [{ ref, base64 }] images attached to THIS message
 */
export function buildMessages(o) {
  const c = o.current || {};
  const imgLines = Object.entries(o.images || {}).map(([ref, i]) => `- ${ref}: generated with prompt "${i.prompt || '?'}"${i.seed !== undefined && i.seed !== null ? `, seed ${i.seed}` : ''}${i.preset ? `, preset ${presetLabel(i.preset)}` : ''}`);
  const sys = [
    'You are a concept-art prompt assistant inside the "Comfy UI" app. You help the user develop image ideas and write or revise the prompt that goes to ComfyUI.',
    'TONE: plain and factual. In "reply", say only what you changed in the prompt (or which action you propose) and why, in one or two short sentences. No compliments or praise, no opinions on how good the image or the idea is, no exclamation marks, no apologies, no filler like "Great!" or "Got it!". When describing an image, state what it shows, neutrally.',
    styleFor(c.workflow),
    `Active preset: ${c.preset || 'unknown'}.`,
    `CURRENT PROMPT BOX (what will be generated now):\n"""${c.prompt || ''}"""`,
    c.hasNegative ? (c.negativeOn ? `CURRENT NEGATIVE PROMPT:\n"""${c.negative || ''}"""` : 'The negative prompt is switched off.') : 'This preset has no negative prompt.',
    imgLines.length ? `Images in this chat:\n${imgLines.join('\n')}\nWhen the user gives feedback on an image, compare what you SEE with what they wanted, and revise the CURRENT prompt to close that gap. Keep everything they did not complain about.` : '',
    `Workflow actions you may propose (the app asks the user to confirm before running anything):\n${actionsForPrompt(o.actions || [])}\nOnly propose an action when the user asks for that kind of operation (e.g. upscale, make 3D); when they do, fill "action" and set "prompt" to null. Use image_ref to say which image (e.g. "img1"); omit it to use the last discussed image. Nothing has run when you answer: describe a proposed action in the conditional or future ("I would upscale it 2x", "This would make a 3D model"), never as done ("I have upscaled", "The resolution has been increased").`,
    'Answer ONLY with a JSON object: {"reply": one or two plain, factual sentences (no praise), "prompt": the full new prompt text or null if the prompt should not change, "negative": new negative prompt or null, "action": null or {"action": action id, "params": {...}, "image_ref": "img1"}}. "prompt" must be the COMPLETE prompt (not a fragment), ready to paste. Never output node graphs.',
  ].filter(Boolean).join('\n\n');
  const msgs = [{ role: 'system', content: sys }];
  for (const m of o.history || []) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.content + (m.images?.length ? `\n[attached: ${m.images.join(', ')}]` : '') });
    else if (m.role === 'assistant') msgs.push({ role: 'assistant', content: JSON.stringify({ reply: m.content, prompt: m.prompt ?? null, negative: m.negative ?? null, action: m.action ?? null }) });
  }
  const last = { role: 'user', content: o.userText + (o.newImages?.length ? `\n[attached: ${o.newImages.map((i) => i.ref).join(', ')}]` : '') };
  if (o.newImages?.length) last.images = o.newImages.map((i) => i.base64);
  msgs.push(last);
  return msgs;
}
