package app.jesse.comfyconcept;

import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;

/**
 * Batch 16: talk to Claude with the phone's own speech recognition.
 *
 * The WebView has no Web Speech API, so the page asks the app through
 * window.AndroidBridge (startSpeech / stopSpeech / cancelSpeech) and gets the
 * words back as events: window.__comfySpeech({type: "partial" | "final" |
 * "error" | "end", text, message}). Android's recognizer ends by itself when
 * you stop talking, so the page sends the final words right away.
 * All calls run on the UI thread (SpeechRecognizer requires it).
 */
final class SpeechInput {
    private final MainActivity activity;
    private final WebView web;
    private SpeechRecognizer recognizer;
    private boolean finished;

    SpeechInput(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    static boolean available(MainActivity activity) {
        return SpeechRecognizer.isRecognitionAvailable(activity);
    }

    /** RECORD_AUDIO must already be granted (MainActivity asks first). */
    void start(String lang) {
        stopQuietly();
        finished = false;
        recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onEvent(int eventType, Bundle params) { }

            @Override
            public void onPartialResults(Bundle partial) {
                String t = best(partial);
                if (t != null) send("partial", t, null);
            }

            @Override
            public void onResults(Bundle results) {
                finished = true;
                send("final", best(results), null);
                stopQuietly();
            }

            @Override
            public void onError(int error) {
                if (finished) return;
                finished = true;
                // no match / speech timeout = nothing was said: just end quietly
                if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) send("end", null, null);
                else send("error", null, message(error));
                stopQuietly();
            }
        });
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        if (lang != null && !lang.isEmpty()) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        recognizer.startListening(i);
    }

    /** Stop and send what was heard so far (onResults follows). */
    void stop() {
        if (recognizer != null) recognizer.stopListening();
    }

    /** Throw it away. */
    void cancel() {
        finished = true;
        if (recognizer != null) recognizer.cancel();
        send("end", null, null);
        stopQuietly();
    }

    void fail(String msg) {
        send("error", null, msg);
    }

    void destroy() {
        stopQuietly();
    }

    private void stopQuietly() {
        if (recognizer == null) return;
        try {
            recognizer.destroy();
        } catch (RuntimeException ignored) {
            // already gone
        }
        recognizer = null;
    }

    private static String best(Bundle b) {
        if (b == null) return null;
        ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return list == null || list.isEmpty() ? null : list.get(0);
    }

    private static String message(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "Microphone access was refused";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "Speech recognition needs the network";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "The speech recognizer is busy, try again";
            case SpeechRecognizer.ERROR_AUDIO: return "Could not record audio";
            default: return "Could not hear that (" + error + ")";
        }
    }

    private void send(String type, String text, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            if (text != null) o.put("text", text);
            if (message != null) o.put("message", message);
            web.evaluateJavascript("window.__comfySpeech && window.__comfySpeech(" + o + ");", null);
        } catch (JSONException ignored) {
            // cannot happen with plain strings
        }
    }
}
