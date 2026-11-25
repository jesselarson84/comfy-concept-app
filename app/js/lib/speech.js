// speech.js - batch 16: talk to Claude with the phone's own speech recognition
// (not Whisper). Tap the mic, speak, and it sends by itself when you stop.
//   - Android app (a WebView, which has no Web Speech): the native bridge
//     (AndroidBridge.startSpeech / stopSpeech / cancelSpeech, Android's
//     SpeechRecognizer); results come back through window.__comfySpeech(event).
//   - Browsers: the Web Speech API (SpeechRecognition / webkitSpeechRecognition).
//   - Neither: no mic button (keyboard dictation still works in the text box).
import { bridge, has } from '../native.js';

/** 'android' | 'web' | null */
export function speechSupport() {
  try { if (has('speechAvailable') && bridge().speechAvailable()) return 'android'; } catch {}
  if (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) return 'web';
  return null;
}

/**
 * Start listening. hooks: onPartial(text), onFinal(text) (sent when you stop
 * talking or press stop), onError(message), onEnd() (always last).
 * -> { stop() = finish now and send, cancel() = throw it away }
 */
export function listen({ onPartial = () => {}, onFinal = () => {}, onError = () => {}, onEnd = () => {} } = {}) {
  const lang = navigator.language || 'en-US';
  let done = false, cancelled = false, text = '';
  const finish = (err) => {
    if (done) return;
    done = true;
    if (err && !cancelled) onError(err);
    else if (!cancelled && text.trim()) onFinal(text.trim());
    onEnd();
  };
  if (speechSupport() === 'android') {
    window.__comfySpeech = (e) => {
      if (done || !e) return;
      if (e.type === 'partial') { text = e.text || text; onPartial(text); }
      else if (e.type === 'final') { text = e.text || text; finish(); }
      else if (e.type === 'error') finish(e.message || 'Could not hear that');
      else if (e.type === 'end') finish();
    };
    try { bridge().startSpeech(lang); } catch (e) { finish(e.message); }
    return {
      stop() { try { bridge().stopSpeech(); } catch { finish(); } },
      cancel() { cancelled = true; try { bridge().cancelSpeech(); } catch {} finish(); },
    };
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { queueMicrotask(() => finish('Speech recognition is not available here')); return { stop() {}, cancel() {} }; }
  const rec = new SR();
  rec.lang = lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    let all = '';
    for (let i = 0; i < ev.results.length; i++) all += ev.results[i][0].transcript;
    text = all;
    onPartial(text);
  };
  rec.onerror = (ev) => { if (ev.error === 'no-speech' || ev.error === 'aborted') return; finish(ev.error === 'not-allowed' ? 'Microphone access was refused' : `Could not hear that (${ev.error})`); };
  rec.onend = () => finish();
  try { rec.start(); } catch (e) { finish(e.message); }
  return {
    stop() { try { rec.stop(); } catch { finish(); } },
    cancel() { cancelled = true; try { rec.abort(); } catch {} finish(); },
  };
}
