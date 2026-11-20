# LyricGlyph Generator — Web Edition

Browser version of the LyricGlyph Generator (phone + PC). No install, no server code: it is a static site.

## Run it
- Locally: `python -m http.server 8000` in this folder, open http://localhost:8000
- Online: upload the folder to GitHub Pages / Netlify / Cloudflare Pages (HTTPS is needed on phones).
  Opening index.html by double-click does NOT work (browsers block module workers on file://).

## Flow
1. Choose either the primary **Import Song** workflow (OGG/MP3/WAV/FLAC/M4A) or the always-available **Vocal** + **Instrument** buttons beneath it. The original-song workflow remains unchanged; manual stems are an optional alternative and do not require an original song.
2. In manual mode, LyricGlyph uses the vocal file for Whisper and prepares a local mix of vocals + instrumental for playback and final audio export. Both stems must have matching start points and nearly matching durations.
3. Edit the song title and search Google directly or open the mini browser. Copy the lyrics and paste them into the lyrics field.
4. Transcribe the vocal stem with Whisper (transformers.js). If separation was skipped or failed, Whisper falls back to the original song.
5. Apply lyrics to the recognized words, then adjust each word by dragging its clip on the timeline or editing its timestamp.
6. Download the `.js` file or import your `.mcaddon`; in manual-stem mode, the combined vocal + instrumental OGG is installed with the lyrics in the selected slot.

## Needs internet (first time)
speech engine + model (jsDelivr / Hugging Face, then cached), Google search, OGG encoder (only when the
song is not already Vorbis .ogg). JSZip is bundled.

## Tests
`node tests/test_core.mjs`


## Audio preparation
Vocal separation is available inside the web app and runs locally; your audio is not uploaded to a remote separation service. The separation library performs its audio processing through its own Float32Array/STFT pipeline and ONNX Runtime. ONNX Runtime's WASM model inference is configured to use proxy-worker mode, which moves model execution off the UI thread. The library does not currently expose detailed per-cent progress, so the UI shows elapsed time only. The first run downloads and caches the ~67 MB Kim Vocal 2 model. CPU-only separation can still take several minutes, especially on older processors. When no manual stems are imported, the original song remains the playback and MCAddon export source; only the separated vocal stem is sent to Whisper. Manual mode can be used with or without an original song: the vocal stem is sent to Whisper and the final OGG is rendered by mixing the imported vocal + instrumental stems locally. The mix uses headroom to reduce clipping and is exported automatically with the lyrics.

## Lyrics lookup
Enter or edit the song title, then search Google directly or open the in-app mini search panel. Copy lyrics from the search page and use **Paste copied lyrics**, or paste them manually into the lyrics field. Some browsers prevent Google from loading inside an embedded frame; use **Open Google in new tab** in that case.

## Word timeline
Each detected word appears as a draggable clip on its own timeline lane. Drag clips horizontally to adjust timing, and tap an empty track area to seek the audio.

## Vocal separation troubleshooting
The separation library does not expose detailed stage progress. The UI therefore reports elapsed time while `separator.separate()` is running. ONNX Runtime WASM inference is configured for proxy-worker mode; other processing may still run in the page context. Keep the tab open and allow the first model download to finish. CPU-only WASM may still be slow, but the model inference should not block normal page interaction. If your host applies a strict Content Security Policy that blocks blob workers, allow the ONNX Runtime proxy worker or the app will show an error instead of silently running inference on the UI thread.

## Transcription troubleshooting
Whisper requires 16 kHz mono audio. LyricGlyph resamples the imported song to 16 kHz before starting the local browser worker. The first transcription also downloads Transformers.js and the selected Whisper model, so keep the page open and internet connected until the model is cached.


### If Transcribe stays on Working
The app now shows separate audio-preparation, speech-engine and model-download states. Audio resampling is performed with a lightweight in-memory conversion rather than a full offline audio render. If the worker receives no response for 3 minutes, it reports a connection/worker timeout instead of staying on Working forever. The first run needs access to jsDelivr and Hugging Face to download the speech engine/model.


## Timeline editor updates
- Word clips now share one horizontal track and use the same seconds-based scale.
- Drag a word clip to retime it; its timestamp field and waveform markers update.
- Drag the playhead handle in the waveform or word timeline to scrub continuously.
- Added touch-sized play/pause, ±0.5s and zoom/fit controls.
- Use the zoom controls or horizontal scrolling to navigate long songs.
