"""PCM bridging between aiortc (browser) and ntgcalls (Telegram).

Wire format on both sides: PCM16-LE, 48 kHz, stereo (matches aiortc's Opus
codec exactly, so no resampling in the steady state). Telegram frames arrive
in ~10 ms chunks; browser frames are 20 ms.

No audio is ever written to disk or logged.
"""

from __future__ import annotations

import asyncio
import fractions
import logging
import time

import numpy as np
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack
from av import AudioFrame, AudioResampler

logger = logging.getLogger("switchboard.voip.audio")

SAMPLE_RATE = 48000
CHANNELS = 2
SAMPLE_WIDTH = 2  # s16
BYTES_PER_10MS = SAMPLE_RATE // 100 * CHANNELS * SAMPLE_WIDTH  # 1920
PTIME_MS = 20
SAMPLES_PER_BROWSER_FRAME = SAMPLE_RATE * PTIME_MS // 1000  # 960


class PcmFifo:
    """Bounded byte FIFO for live audio. Drops oldest data when overfull."""

    def __init__(self, max_ms: int = 1000) -> None:
        self._buf = bytearray()
        self._max_bytes = SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH * max_ms // 1000
        self.dropped_bytes = 0

    def push(self, data: bytes) -> None:
        self._buf += data
        overflow = len(self._buf) - self._max_bytes
        if overflow > 0:
            del self._buf[:overflow]
            self.dropped_bytes += overflow

    def pull(self, n: int) -> bytes:
        """Return exactly n bytes, zero-padded on underrun (silence)."""
        if len(self._buf) >= n:
            out = bytes(self._buf[:n])
            del self._buf[:n]
            return out
        out = bytes(self._buf) + b"\x00" * (n - len(self._buf))
        self._buf.clear()
        return out

    def __len__(self) -> int:
        return len(self._buf)


class TelegramAudioTrack(MediaStreamTrack):
    """aiortc outbound track that plays PCM pushed from the Telegram call."""

    kind = "audio"

    def __init__(self, fifo: PcmFifo) -> None:
        super().__init__()
        self._fifo = fifo
        self._start: float | None = None
        self._samples = 0

    async def recv(self) -> AudioFrame:
        if self.readyState != "live":
            raise MediaStreamError

        if self._start is None:
            self._start = time.monotonic()
        else:
            due = self._start + self._samples / SAMPLE_RATE
            delay = due - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            elif delay < -1:
                # Fell badly behind (event-loop stall); resync the clock.
                self._start = time.monotonic() - self._samples / SAMPLE_RATE

        data = self._fifo.pull(SAMPLES_PER_BROWSER_FRAME * CHANNELS * SAMPLE_WIDTH)
        array = np.frombuffer(data, dtype=np.int16).reshape(1, -1)
        frame = AudioFrame.from_ndarray(array, format="s16", layout="stereo")
        frame.sample_rate = SAMPLE_RATE
        frame.pts = self._samples
        frame.time_base = fractions.Fraction(1, SAMPLE_RATE)
        self._samples += SAMPLES_PER_BROWSER_FRAME
        return frame


def frame_to_pcm(frame: AudioFrame, resampler: AudioResampler) -> bytes:
    """Normalize an aiortc AudioFrame to PCM16-LE 48k stereo bytes."""
    if (
        frame.format.name == "s16"
        and frame.layout.name == "stereo"
        and frame.sample_rate == SAMPLE_RATE
    ):
        return frame.to_ndarray().tobytes()
    chunks = [f.to_ndarray().tobytes() for f in resampler.resample(frame)]
    return b"".join(chunks)


async def pump_browser_to_telegram(
    track: MediaStreamTrack,
    send_pcm,
    *,
    on_first_frame=None,
) -> None:
    """Read browser audio and push 10 ms PCM chunks into the Telegram call.

    ``send_pcm`` is an async callable(bytes) that must swallow not-in-call
    states itself (frames before the callee answers are dropped).
    """
    resampler = AudioResampler(format="s16", layout="stereo", rate=SAMPLE_RATE)
    pending = bytearray()
    first = True
    while True:
        try:
            frame = await track.recv()
        except MediaStreamError:
            return
        if first:
            first = False
            if on_first_frame is not None:
                on_first_frame()
        pending += frame_to_pcm(frame, resampler)
        while len(pending) >= BYTES_PER_10MS:
            chunk = bytes(pending[:BYTES_PER_10MS])
            del pending[:BYTES_PER_10MS]
            await send_pcm(chunk)
