# whisperflow-local

Private, local Wispr-Flow-style dictation: a global hotkey on Windows records
the microphone, a faster-whisper server inside WSL2 transcribes it, and the
text is pasted into whatever window has focus. No cloud, no telemetry, no
credentials -- everything runs on this machine over 127.0.0.1.

## Architecture

```
Windows 11 (host)                                WSL2 (Ubuntu)
+------------------------------+                 +--------------------------------+
| windows/whisperflow.ahk      |                 | server/stt_server.py           |
|  (AutoHotkey v2)             |   HTTP POST     |  (.venv python, stdlib http)   |
|  F9  -> ffmpeg dshow record  |   wav bytes     |  faster-whisper "small"        |
|  F9  -> stop recording  -----+---------------> |  cpu int8, 8 threads,          |
|  paste transcript (Ctrl+V) <-+---------------- |  beam_size=1, vad_filter=True  |
+------------------------------+   transcript    +--------------------------------+
                     127.0.0.1:8765 (WSL2 localhost forwarding)
```

Why this split: this box is WSL2 and dictation targets **Windows** apps.
WSLg's mic bridge is broken here and WSLg keystroke injection cannot reach
Windows windows, so audio capture + text injection live on the Windows side
(thin AutoHotkey client) while the STT model lives in WSL where the Python
stack already exists. Windows reaches the WSL server on plain
`http://127.0.0.1:8765` thanks to WSL2 localhost forwarding (verified on this
machine).

## Start the server (WSL)

```bash
cd ~/marveen/projects/whisperflow-local
server/run.sh                     # defaults: small model, port 8765
server/run.sh --model base        # faster, weaker (esp. Hungarian)
WHISPERFLOW_MODEL=tiny server/run.sh
```

Startup of the default `small` model takes ~5 s (measured: 4.9 s from the
local cache, warmup included), then the model stays warm. Check:
`curl http://127.0.0.1:8765/health`.

Optional autostart: `server/whisperflow-stt.service` is a ready systemd user
unit (install instructions in the file header). It is intentionally **not**
installed/enabled by default.

### API

- `GET /health` -> `{"status":"ok","model":"small","loaded":true,...}`
- `POST /transcribe?language=hu|en|auto&format=json|text`, body = wav bytes
  (any sample rate/channels; resampled in memory to 16 kHz mono)
  - `format=json` (default): `{"text": "...", "duration_s": 11.0,
    "latency_s": 3.9, "language": "en", "model": "small"}`
  - `format=text`: bare transcript, `text/plain; charset=utf-8` (what the
    AHK client uses; timing available in `X-Latency-S` / `X-Duration-S`
    response headers)

Example:

```bash
curl -s -X POST --data-binary @bench/jfk.wav \
  "http://127.0.0.1:8765/transcribe?language=en"
```

## Set up the Windows side

See `windows/README.md`. Short version: install AutoHotkey v2 + ffmpeg with
winget (two one-liners, run them yourself), double-click
`windows/whisperflow.ahk`, press F9 to talk, F9 to paste.

## Model trade-offs (measured on this box)

i5-8300H, 8 threads, 7 GB RAM, no GPU; int8, `beam_size=1`, 11 s English
sample:

| Model | Transcribe time | Real-time factor | Quality                          |
|-------|-----------------|------------------|----------------------------------|
| tiny  | 0.9 s           | ~0.08            | rough; ok for quick English notes |
| base  | 1.5 s           | ~0.14            | usable English, weak Hungarian    |
| small | 4.2 s           | ~0.38            | best Hungarian of the three (default) |

Rule of thumb with `small`: **latency ~ 0.4 x utterance length** when the
language is fixed (`hu`/`en`); `auto` adds ~2 s per utterance for language
detection. Measured end-to-end on the 11 s sample: 3.2 s server-side with
`language=en`, 3.7 s round-trip from the Windows side. Drop to `base`/`tiny`
via `--model`/`WHISPERFLOW_MODEL` if speed matters more than Hungarian
accuracy. RAM: the small/int8 server process measures ~743 MB resident.

## Known limitations (v1)

- **No streaming**: transcription starts when you stop recording; expect the
  ~0.4x wait. Streaming/partial results would need a different serving model.
- **No LLM cleanup**: raw Whisper output (punctuation is decent, but no
  rephrasing/formatting commands). `postprocess()` in `server/stt_server.py`
  is the designated hook; this machine is too weak to run a local LLM pass
  at acceptable latency.
- **One utterance at a time**: transcriptions are serialized server-side
  (each run already saturates the CPU). Fine for a single dictating user.
- **Hard-stop recording**: stopping kills ffmpeg; the wav's RIFF header is
  never finalized (the server handles this -- verified) and up to ~0.1 s of
  trailing audio can be lost. Speak, breathe, then press stop.
- **Mic auto-detect picks the first dshow device**, which may not be the
  Windows default mic -- override with `cfgMic` (windows/README.md).
- Hungarian quality on `small` is fair but not Wispr-Flow level; proper
  names and domain terms will need the future LLM cleanup pass.

## Security / privacy

- Server binds **127.0.0.1 only** (hardcoded, `BIND_HOST` in
  `server/stt_server.py`). Nothing listens on LAN interfaces.
- No credentials, no telemetry, no runtime network calls. Model weights load
  from the local HuggingFace cache (`~/.cache/huggingface`); only a
  first-ever use of a new model size downloads anything.
- Transcript content is never logged server-side; audio is processed in
  memory and never written to disk in WSL. Windows-side temp wav handling:
  see windows/README.md.

## Troubleshooting

- **`/health` works in WSL but not from Windows**: WSL2 localhost forwarding
  is off. Check `/mnt/c/Users/<you>/.wslconfig` -- ensure it does NOT contain
  `localhostForwarding=false`; either remove that line or use
  `networkingMode=mirrored` ([wsl2] section), then `wsl --shutdown` from
  Windows and restart WSL. Verified working out of the box on this machine.
- **Port already in use**: another instance is running
  (`ss -ltnp | grep 8765` in WSL), or pick `--port` + matching `cfgServer`.
- **Slow first request**: should not happen (the server warms up at startup);
  if the whole machine is under load, transcription competes for the same 8
  threads.

## Repo layout

```
server/    stt_server.py, run.sh, whisperflow-stt.service, requirements.txt
windows/   whisperflow.ahk (AutoHotkey v2 client), README.md
bench/     bench.py + jfk.wav (the numbers in the table above)
.venv/     python env with faster-whisper 1.2.1 (already provisioned)
```
