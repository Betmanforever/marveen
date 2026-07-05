# CPU benchmark for faster-whisper model sizes on this machine (i5-8300H,
# 8 threads, no GPU). Measures cold load + transcription wall time for an
# 11s English sample. Run: .venv/bin/python bench/bench.py [model ...]
import sys
import time

from faster_whisper import WhisperModel

AUDIO = __file__.rsplit("/", 1)[0] + "/jfk.wav"
models = sys.argv[1:] or ["tiny", "base", "small"]

for name in models:
    t0 = time.perf_counter()
    m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=8)
    t_load = time.perf_counter() - t0

    t0 = time.perf_counter()
    segments, info = m.transcribe(AUDIO, beam_size=1, language="en")
    text = " ".join(s.text.strip() for s in segments)
    t_tr = time.perf_counter() - t0

    print(f"{name}: load={t_load:.1f}s transcribe={t_tr:.1f}s "
          f"(audio 11.0s, RTF={t_tr/11.0:.2f})")
    print(f"  text: {text[:120]}")
    del m
