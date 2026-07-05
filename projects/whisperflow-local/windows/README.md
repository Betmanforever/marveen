# whisperflow -- Windows side

Thin client: global hotkey -> ffmpeg mic capture -> POST wav to the WSL STT
server -> paste transcript into the focused window.

## Install (run these yourself, in a regular non-admin terminal)

```powershell
winget install --id AutoHotkey.AutoHotkey -e
winget install --id Gyan.FFmpeg -e
```

- `AutoHotkey.AutoHotkey` installs AutoHotkey **v2** (the script requires v2,
  it will refuse to run under v1).
- `Gyan.FFmpeg` puts `ffmpeg.exe` on the user PATH. If a freshly opened app
  still cannot find it, log off/on once (PATH changes propagate on logon), or
  set `cfgFfmpeg` in the script to the full path.
- Verify: open a new terminal and run `ffmpeg -version` and
  `autohotkey.exe /?` (or just double-click the script).

## Run

1. Make sure the WSL server is running (see the top-level README).
2. Copy `whisperflow.ahk` somewhere convenient on the Windows side (or run it
   straight from `\\wsl.localhost\...\whisperflow-local\windows\`).
3. Double-click `whisperflow.ahk`. A tray tip confirms the hotkey and the
   detected microphone.
4. Focus any input field, press **F9**, speak, press **F9** again. The
   transcript is pasted at the cursor. Your previous clipboard is restored.

Autostart: press `Win+R`, run `shell:startup`, put a shortcut to the script
there.

## Configuration (top of `whisperflow.ahk`)

| Variable       | Default                  | Meaning                                    |
|----------------|--------------------------|--------------------------------------------|
| `cfgHotkey`    | `F9`                     | toggle key; e.g. `^!d` = Ctrl+Alt+D         |
| `cfgServer`    | `http://127.0.0.1:8765`  | WSL STT server                              |
| `cfgLanguage`  | `auto`                   | `hu`, `en`, or `auto` (per-utterance detect)|
| `cfgFfmpeg`    | `ffmpeg.exe`             | full path if not on PATH                    |
| `cfgMic`       | `""` (auto)              | exact dshow device name                     |
| `cfgMaxSecs`   | `300`                    | safety auto-stop                            |

Hungarian-heavy dictation: set `cfgLanguage := "hu"` -- forcing the language
is more reliable than auto-detect on short utterances and ~2 s faster per
utterance (skips language detection).

## Troubleshooting

- **"ffmpeg exited right away"** or **"no recording file"**: the auto-detected
  mic (first dshow audio device) is not the right one. List devices in a
  terminal:
  `ffmpeg -hide_banner -list_devices true -f dshow -i dummy`
  and copy the exact quoted name into `cfgMic`.
- **"server error ... is the WSL server running?"**: start the server in WSL
  (`server/run.sh`), check `http://127.0.0.1:8765/health` in a Windows
  browser. If health fails from Windows but works inside WSL, see the
  localhost-forwarding note in the top-level README.
- **Paste does nothing in a terminal**: some terminals do not accept Ctrl+V
  (classic conhost needs right-click or Ctrl+Shift+V). Windows Terminal is
  fine by default.
- **Wrong language recognized**: set `cfgLanguage` to `hu` or `en` explicitly.

## Privacy notes

- Audio is written temporarily to `%TEMP%\whisperflow_rec.wav` and deleted
  after a successful transcription. After a failed request the last recording
  stays there (bounded to that one file) until the next attempt overwrites it.
- Everything stays on this machine: the only network call is to
  `127.0.0.1:8765` (the WSL server).
