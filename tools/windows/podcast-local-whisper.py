#!/usr/bin/env python3
"""Quiet River local-only podcast transcription.

Accepts one ECS-validated public audio URL and emits normalized JSON. It never
uses a cloud ASR provider and always deletes the temporary audio file.
"""
from __future__ import annotations
import hashlib
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

MAX_SECONDS = 4 * 60 * 60
MAX_TEXT_BYTES = 1024 * 1024
MODEL = "base"


def fail(message: str, code: int = 2) -> None:
    print(message[:240], file=sys.stderr)
    raise SystemExit(code)


def validate_public_url(value: str) -> str:
    try:
        parsed = urlparse(value)
    except Exception:
        fail("invalid audio URL")
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        fail("invalid audio URL")
    try:
        records = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except OSError:
        fail("audio host DNS lookup failed")
    addresses = {item[4][0] for item in records}
    if not addresses:
        fail("audio host has no addresses")
    for raw in addresses:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            fail("invalid resolved audio address")
        if not ip.is_global:
            fail("audio host resolved to non-public address")
    return value


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def resolve_public_url(value: str) -> str:
    validate_public_url(value)
    opener = urllib.request.build_opener(SafeRedirect())
    request = urllib.request.Request(value, method="HEAD", headers={"User-Agent": "QuietRiver/0.1 local-transcriber"})
    try:
        with opener.open(request, timeout=15) as response:
            final = response.geturl()
    except Exception as exc:
        fail("audio URL preflight failed: " + str(exc))
    return validate_public_url(final)


def timestamp(seconds: float) -> str:
    total = max(0, int(seconds))
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: podcast-local-whisper.py AUDIO_URL ENTRY_ID")
    audio_url = resolve_public_url(sys.argv[1])
    try:
        entry_id = int(sys.argv[2])
        if entry_id < 1:
            raise ValueError
    except ValueError:
        fail("invalid entry id")

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        fail("ffmpeg is not installed", 69)

    tool_root = Path(os.environ.get("QR_LOCAL_ASR_HOME", r"D:\QuietRiverTools\faster-whisper"))
    models = tool_root / "models"
    models.mkdir(parents=True, exist_ok=True)

    try:
        from faster_whisper import WhisperModel
    except Exception:
        fail("faster-whisper is not installed in the local ASR runtime", 69)

    with tempfile.TemporaryDirectory(prefix="quiet-river-podcast-") as tmp:
        wav = Path(tmp) / "audio.wav"
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error",
            "-i", audio_url, "-vn", "-ac", "1", "-ar", "16000",
            "-t", str(MAX_SECONDS), "-c:a", "pcm_s16le", "-y", str(wav),
        ]
        try:
            completed = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=3600, shell=False)
        except subprocess.TimeoutExpired:
            fail("podcast audio download/transcode timed out", 70)
        if completed.returncode != 0 or not wav.exists() or wav.stat().st_size < 1024:
            fail("podcast audio download/transcode failed", 70)

        model = WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=str(models))
        segments, info = model.transcribe(str(wav), beam_size=5, vad_filter=True)
        lines = []
        count = 0
        for segment in segments:
            text = str(segment.text or "").strip()
            if not text:
                continue
            count += 1
            if count > 10000:
                fail("podcast transcript has too many segments")
            lines.append(f"[{timestamp(segment.start)}] {text}")
        content = "\n".join(lines).strip()
        if not content or len(content.encode("utf-8")) > MAX_TEXT_BYTES:
            fail("podcast transcript is empty or too large")
        language = str(getattr(info, "language", "") or "").lower()
        if not language.isalpha() or not (2 <= len(language) <= 3):
            fail("podcast transcript language is invalid")

    result = {
        "entryId": entry_id,
        "backendId": "faster-whisper-local",
        "mediaSha256": hashlib.sha256(sys.argv[1].encode("utf-8")).hexdigest(),
        "model": MODEL,
        "language": language,
        "segmentCount": count,
        "content": content,
    }
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
