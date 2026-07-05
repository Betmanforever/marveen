; whisperflow-local Windows client -- AutoHotkey v2 (NOT v1).
;
; Toggle-to-dictate: press the hotkey once to start recording the microphone
; with ffmpeg (dshow, 16 kHz mono wav in %TEMP%), press it again to stop; the
; wav is POSTed to the WSL-side STT server on http://127.0.0.1:8765 and the
; transcript is pasted into the focused window via the clipboard.
; Install steps and troubleshooting: README.md next to this file.
#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent()

; ------------------------- configuration -------------------------
cfgHotkey   := "F9"                     ; toggle key: "F9", "^!d" = Ctrl+Alt+D, ...
cfgServer   := "http://127.0.0.1:8765"  ; WSL STT server (localhost forwarding)
cfgLanguage := "auto"                   ; "hu", "en" or "auto"
cfgFfmpeg   := "ffmpeg.exe"             ; full path if ffmpeg is not on PATH
cfgMic      := ""                       ; exact dshow device name; "" = auto-detect
cfgMaxSecs  := 300                      ; safety auto-stop for forgotten recordings
; ------------------------------------------------------------------

recording := false     ; ffmpeg currently capturing
busy      := false     ; stop/transcribe/paste in progress; hotkey ignored
ffmpegPid := 0
micName   := cfgMic
wavPath   := A_Temp "\whisperflow_rec.wav"

CheckFfmpeg()
if (micName = "")
    micName := DetectMic(false)   ; detect at startup so the first press is instant
Hotkey(cfgHotkey, ToggleDictation)
A_IconTip := "whisperflow (" cfgHotkey ")"
TrayTip("Press " cfgHotkey " to dictate."
    . (micName != "" ? "`nMic: " micName : "`nNo mic auto-detected yet."),
    "whisperflow ready")

ToggleDictation(*) {
    global recording, busy
    if busy
        return
    if recording
        StopAndTranscribe()
    else
        StartRecording()
}

CheckFfmpeg() {
    global cfgFfmpeg
    try {
        RunWait('"' cfgFfmpeg '" -version', , "Hide")
    } catch {
        msg := "ffmpeg.exe was not found (looked for: " cfgFfmpeg ").`n`n"
        msg .= "Install it in a regular (non-admin) terminal:`n"
        msg .= "    winget install --id Gyan.FFmpeg -e`n`n"
        msg .= "then start this script again. If it is still not found,"
        msg .= " log off/on once or set cfgFfmpeg to the full ffmpeg.exe path."
        MsgBox(msg, "whisperflow", "Iconx")
        ExitApp()
    }
}

; Ask ffmpeg for the dshow capture devices and return the first "(audio)" one.
; Not guaranteed to be the Windows default mic -- override with cfgMic if wrong.
DetectMic(showErrors) {
    global cfgFfmpeg
    listFile := A_Temp "\whisperflow_devices.txt"
    try FileDelete(listFile)
    try {
        RunWait(A_ComSpec ' /c ""' cfgFfmpeg '" -hide_banner -list_devices true'
            . ' -f dshow -i dummy 2>"' listFile '""', , "Hide")
    } catch {
        if showErrors
            ShowError("could not run ffmpeg for mic detection")
        return ""
    }
    out := ""
    try out := FileRead(listFile, "UTF-8")
    try FileDelete(listFile)
    ; ffmpeg lists capture devices as:  "Device name" (audio)
    if RegExMatch(out, '"([^"]+)"\s+\(audio\)', &m)
        return m[1]
    if showErrors
        ShowError("no dshow microphone found - set cfgMic in whisperflow.ahk (see README)")
    return ""
}

StartRecording() {
    global recording, ffmpegPid, micName
    global cfgFfmpeg, cfgHotkey, cfgMaxSecs, wavPath
    if (micName = "") {
        micName := DetectMic(true)
        if (micName = "")
            return
    }
    try FileDelete(wavPath)
    ; -audio_buffer_size 50 keeps dshow buffering short so a hard stop loses
    ; at most ~0.1 s of tail audio; -flush_packets 1 pushes data to disk early.
    ; The server tolerates the unfinalized RIFF header of a killed ffmpeg.
    cmd := '"' cfgFfmpeg '" -hide_banner -loglevel error'
    cmd .= ' -f dshow -audio_buffer_size 50 -i audio="' micName '"'
    cmd .= ' -ac 1 -ar 16000 -c:a pcm_s16le -flush_packets 1 -y "' wavPath '"'
    pid := 0
    try {
        Run(cmd, , "Hide", &pid)
    } catch as e {
        ShowError("could not start ffmpeg: " e.Message)
        return
    }
    ffmpegPid := pid
    recording := true
    SetTimer(AutoStop, -cfgMaxSecs * 1000)
    SetTimer(CheckStarted, -700)
    ToolTip("whisperflow ● recording... (" cfgHotkey " to stop)")
}

; One-shot check shortly after start: if ffmpeg died instantly the device is
; wrong/busy -- surface it instead of failing later with "no recording file".
CheckStarted() {
    global recording, ffmpegPid
    if recording && !ProcessExist(ffmpegPid) {
        recording := false
        ffmpegPid := 0
        ShowError("ffmpeg exited right away - microphone device problem?"
            . " See README troubleshooting.")
    }
}

AutoStop() {
    global recording
    if recording
        StopAndTranscribe()
}

StopAndTranscribe() {
    global recording, busy, ffmpegPid, wavPath
    recording := false
    busy := true
    SetTimer(AutoStop, 0)
    try {
        ToolTip("whisperflow ■ transcribing...")
        if ffmpegPid {
            ; Hard stop. pcm_s16le wav stays decodable without the finalized
            ; header (verified against the server with a kill -9 ffmpeg file).
            try ProcessClose(ffmpegPid)
            ProcessWaitClose(ffmpegPid, 2)
            ffmpegPid := 0
        }
        Sleep(150)   ; let the last buffers hit the file
        if !FileExist(wavPath) {
            ShowError("no recording file was written - wrong mic device?"
                . " See README troubleshooting.")
            return
        }
        if (FileGetSize(wavPath) < 1000) {
            ShowError("recording empty / too short")
            return
        }
        text := ""
        try {
            text := Transcribe(wavPath)
        } catch as e {
            ShowError("server error: " e.Message " - is the WSL server running?")
            return
        }
        try FileDelete(wavPath)
        if (text = "") {
            ShowError("(no speech recognized)")
            return
        }
        PasteText(text)
        ToolTip()
    } finally {
        busy := false
    }
}

Transcribe(path) {
    global cfgServer, cfgLanguage
    ado := ComObject("ADODB.Stream")
    ado.Type := 1   ; binary
    ado.Open()
    ado.LoadFromFile(path)
    bytes := ado.Read()
    ado.Close()
    whr := ComObject("WinHttp.WinHttpRequest.5.1")
    ; format=text: the server replies with the bare transcript as utf-8
    ; text/plain, so no JSON parsing is needed on this side.
    whr.Open("POST", cfgServer "/transcribe?language=" cfgLanguage "&format=text", false)
    whr.SetRequestHeader("Content-Type", "audio/wav")
    whr.SetTimeouts(5000, 5000, 30000, 180000)   ; ms; receive covers long dictation
    whr.Send(bytes)
    if (whr.Status != 200)
        throw Error("HTTP " whr.Status " " SubStr(whr.ResponseText, 1, 160))
    return Trim(whr.ResponseText, " `t`r`n")
}

PasteText(text) {
    saved := ClipboardAll()   ; preserve whatever the user had on the clipboard
    A_Clipboard := text
    if !ClipWait(2) {
        A_Clipboard := saved
        ShowError("clipboard timeout - transcript not pasted")
        return
    }
    Send("^v")
    Sleep(300)   ; let the target app read the clipboard before restoring it
    A_Clipboard := saved
}

ShowError(msg) {
    ToolTip("whisperflow: " msg)
    SetTimer(() => ToolTip(), -4000)
}
