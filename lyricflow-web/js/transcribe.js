// Main-thread wrapper around the Whisper worker.
export function transcribe(samples16k, { model, device }, onProgress) {
  let worker;
  try {
    worker = new Worker(new URL("./whisper.worker.js", import.meta.url), { type: "module" });
  } catch (err) {
    throw new Error("Could not start the transcription worker. Open LyricGlyph through http://localhost or an HTTPS website, not file://. " + (err.message || ""));
  }
  let settled = false;
  let watchdog;
  const promise = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      worker.terminate();
      fn(value);
    };
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => finish(reject, new Error("The speech engine has not responded for 3 minutes. Check your connection to jsDelivr and Hugging Face, then reload and try again.")), 180000);
    };
    armWatchdog();
    worker.onmessage = (e) => {
      const m = e.data || {};
      armWatchdog();
      if (m.type === "progress") { if (onProgress) onProgress(m.pct, m.msg); }
      else if (m.type === "done") finish(resolve, m.words || []);
      else if (m.type === "error") finish(reject, new Error(m.message || "Unknown speech engine error."));
    };
    worker.onerror = (e) => finish(reject, new Error("The speech worker failed (" + (e.message || "blocked or offline") + "). Check your connection and allow jsDelivr/Hugging Face downloads."));
    worker.onmessageerror = () => finish(reject, new Error("The transcription worker returned an unreadable message. Reload LyricGlyph and try again."));
    try {
      const copy = samples16k.slice();
      worker.postMessage({ type: "run", samples: copy, model, device }, [copy.buffer]);
    } catch (err) { finish(reject, new Error("Could not send audio to the speech worker: " + err.message)); }
  });
  return { promise, cancel: () => { if (!settled) { settled = true; clearTimeout(watchdog); worker.terminate(); } } };
}
