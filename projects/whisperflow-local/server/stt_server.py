#!/usr/bin/env python3
"""Local speech-to-text server for whisperflow-local.

Loads a faster-whisper model once at startup and serves it over localhost
HTTP so the Windows-side client (windows/whisperflow.ahk) can POST wav bytes
and get the transcript back. Tuned for this CPU-only box (i5-8300H, 8
threads, no GPU): int8 compute, beam_size=1, VAD filter on.

Endpoints:
  GET  /health
       -> {"status": "ok", "model": ..., "loaded": true, ...}
  POST /transcribe[?language=hu|en|auto][&format=json|text]
       body: audio bytes (wav at any sample rate/channels; anything PyAV can
       decode is accepted and resampled to 16 kHz mono in memory)
       -> {"text": ..., "duration_s": ..., "latency_s": ...}   (format=json)
       -> bare transcript as text/plain; charset=utf-8          (format=text,
          used by the AutoHotkey client so it needs no JSON parser)

Config via env or CLI flags (CLI wins):
  WHISPERFLOW_MODEL     model size or CTranslate2 path   (default: small)
  WHISPERFLOW_PORT      TCP port                         (default: 8765)
  WHISPERFLOW_THREADS   cpu_threads for CTranslate2      (default: min(8, cores))
  WHISPERFLOW_LANGUAGE  default when request has no ?language=  (default: auto)

Security: binds 127.0.0.1 ONLY (non-negotiable); the Windows client reaches
it through WSL2 localhost forwarding. No credentials, no telemetry, no
runtime network calls (model files come from the local HF cache; only a
first-ever load of an uncached model size downloads). Transcript content is
deliberately never logged and audio is processed in memory only.
"""

import argparse
import io
import json
import logging
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import numpy as np
from faster_whisper import WhisperModel

# Security requirement: localhost only. Never bind a routable interface.
BIND_HOST = "127.0.0.1"
MAX_BODY_BYTES = 64 * 1024 * 1024  # ~34 min of 16 kHz mono s16 wav

log = logging.getLogger("whisperflow")

# Populated in main() before the server starts accepting connections.
MODEL = None
MODEL_NAME = ""
THREADS = 0
DEFAULT_LANGUAGE = "auto"
LOAD_SECONDS = 0.0
STARTED_AT = time.time()
# One transcription at a time: each run already uses all CPU threads.
MODEL_LOCK = threading.Lock()


def postprocess(text: str, language: str | None) -> str:
    """Post-processing hook. v1 is identity; attach LLM cleanup (punctuation,
    casing, dictation commands) here later without touching the HTTP layer."""
    return text


def valid_language(lang: str) -> bool:
    """'auto' or a short ISO-ish code (hu, en, de, yue, ...)."""
    return lang == "auto" or (lang.isascii() and lang.isalpha() and 2 <= len(lang) <= 3)


def transcribe_bytes(data: bytes, language: str) -> dict:
    """Run the warm model on in-memory audio bytes."""
    lang = None if language == "auto" else language
    t0 = time.perf_counter()
    with MODEL_LOCK:
        segments, info = MODEL.transcribe(
            io.BytesIO(data),
            language=lang,
            beam_size=1,
            vad_filter=True,
        )
        # faster-whisper transcribes lazily while the generator is consumed,
        # so iteration must stay inside the lock and the timing window.
        text = " ".join(seg.text.strip() for seg in segments).strip()
    latency = time.perf_counter() - t0
    text = postprocess(text, info.language)
    # Privacy: log timings only, never the transcript itself.
    log.info("transcribed %.1fs audio in %.2fs (lang=%s)",
             info.duration, latency, info.language)
    return {
        "text": text,
        "duration_s": round(info.duration, 2),
        "latency_s": round(latency, 2),
        "language": info.language,
        "model": MODEL_NAME,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "whisperflow-stt/1.0"
    protocol_version = "HTTP/1.1"

    def _reply(self, code: int, body: bytes, content_type: str, extra=None):
        if code >= 400:
            # Error paths may not have consumed the request body; do not let
            # a keep-alive client parse leftover bytes as the next request.
            self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._reply(code, body, "application/json; charset=utf-8", extra)

    def do_GET(self):
        if urlsplit(self.path).path == "/health":
            self._json(200, {
                "status": "ok",
                "model": MODEL_NAME,
                "loaded": MODEL is not None,
                "compute_type": "int8",
                "cpu_threads": THREADS,
                "default_language": DEFAULT_LANGUAGE,
                "load_s": round(LOAD_SECONDS, 1),
                "uptime_s": round(time.time() - STARTED_AT, 1),
            })
        else:
            self._json(404, {"error": "not found; use GET /health or POST /transcribe"})

    def do_POST(self):
        parts = urlsplit(self.path)
        if parts.path != "/transcribe":
            self._json(404, {"error": "not found; use POST /transcribe"})
            return
        query = parse_qs(parts.query)
        language = query.get("language", [DEFAULT_LANGUAGE])[0].lower()
        out_format = query.get("format", ["json"])[0].lower()
        if not valid_language(language):
            self._json(400, {"error": f"bad language {language!r}; use hu, en, auto, ..."})
            return
        if out_format not in ("json", "text"):
            self._json(400, {"error": f"bad format {out_format!r}; use json or text"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length <= 0:
            self._json(400, {"error": "empty body; POST the audio bytes"})
            return
        if length > MAX_BODY_BYTES:
            self._json(413, {"error": f"body larger than {MAX_BODY_BYTES} bytes"})
            return
        data = self.rfile.read(length)
        if len(data) < length:
            self._json(400, {"error": "truncated body"})
            return
        try:
            result = transcribe_bytes(data, language)
        except Exception as exc:
            # PyAV raises av.* / ValueError for undecodable input -> client
            # error; anything else is ours.
            decode_error = (isinstance(exc, ValueError)
                            or type(exc).__module__.startswith("av"))
            if decode_error:
                log.warning("undecodable audio: %s", exc)
                self._json(400, {"error": f"could not decode audio: {exc}"})
            else:
                log.exception("transcription failed")
                self._json(500, {"error": "internal transcription error"})
            return
        extra = {
            "X-Duration-S": str(result["duration_s"]),
            "X-Latency-S": str(result["latency_s"]),
            "X-Language": str(result["language"]),
        }
        if out_format == "text":
            self._reply(200, result["text"].encode("utf-8"),
                        "text/plain; charset=utf-8", extra)
        else:
            self._json(200, result, extra)

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)


class SttServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # Keep-alive clients (WinHTTP/PowerShell on the Windows side) often
        # reset the socket instead of closing it cleanly; not worth a stack
        # trace on every dictation. Anything else still gets logged fully.
        exc = sys.exception()
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, TimeoutError)):
            log.debug("client %s dropped the connection", client_address[0])
            return
        super().handle_error(request, client_address)


def parse_args():
    env = os.environ.get
    parser = argparse.ArgumentParser(
        description="whisperflow-local STT server (localhost only)")
    parser.add_argument(
        "--model", default=env("WHISPERFLOW_MODEL", "small"),
        help="faster-whisper model size or path (default: small)")
    parser.add_argument(
        "--port", type=int, default=int(env("WHISPERFLOW_PORT", "8765")),
        help="TCP port on 127.0.0.1 (default: 8765)")
    parser.add_argument(
        "--threads", type=int,
        default=int(env("WHISPERFLOW_THREADS", str(min(8, os.cpu_count() or 4)))),
        help="CPU threads for inference (default: min(8, cores))")
    parser.add_argument(
        "--language", default=env("WHISPERFLOW_LANGUAGE", "auto"),
        help="default language when the request has no ?language= (hu|en|auto)")
    return parser.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()
    language = args.language.lower()
    if not valid_language(language):
        log.error("bad --language %r (use hu, en, auto, ...)", args.language)
        return 2

    global MODEL, MODEL_NAME, THREADS, DEFAULT_LANGUAGE, LOAD_SECONDS
    MODEL_NAME = args.model
    THREADS = args.threads
    DEFAULT_LANGUAGE = language

    log.info("loading model %r (cpu, int8, %d threads)...", args.model, args.threads)
    t0 = time.perf_counter()
    MODEL = WhisperModel(args.model, device="cpu", compute_type="int8",
                         cpu_threads=args.threads)
    # Warm up encoder/decoder and the VAD ONNX session on 1 s of silence so
    # the first real request does not pay one-time init costs.
    for vad in (False, True):
        warm, _ = MODEL.transcribe(np.zeros(16000, dtype=np.float32),
                                   beam_size=1, language="en", vad_filter=vad)
        list(warm)
    LOAD_SECONDS = time.perf_counter() - t0
    log.info("model ready in %.1fs", LOAD_SECONDS)

    httpd = SttServer((BIND_HOST, args.port), Handler)
    log.info("listening on http://%s:%d (localhost only)", BIND_HOST, args.port)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        httpd.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        log.info("shutting down")
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
