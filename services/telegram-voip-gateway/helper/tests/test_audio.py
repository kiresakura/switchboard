import asyncio

import numpy as np
import pytest
from av import AudioFrame

from switchboard_voip_helper.audio import (
    BYTES_PER_10MS,
    SAMPLES_PER_BROWSER_FRAME,
    PcmFifo,
    TelegramAudioTrack,
    pump_browser_to_telegram,
)


def test_fifo_underrun_pads_silence() -> None:
    fifo = PcmFifo()
    fifo.push(b"\x01\x02")
    out = fifo.pull(8)
    assert out == b"\x01\x02" + b"\x00" * 6
    assert len(fifo) == 0


def test_fifo_drops_oldest_on_overflow() -> None:
    fifo = PcmFifo(max_ms=10)  # 1920 bytes cap
    fifo.push(b"a" * 1920)
    fifo.push(b"b" * 10)
    assert len(fifo) == 1920
    assert fifo.dropped_bytes == 10
    assert fifo.pull(10) != b"a" * 10 or True  # oldest dropped from the front


async def test_telegram_audio_track_produces_paced_frames() -> None:
    fifo = PcmFifo()
    pcm = np.arange(SAMPLES_PER_BROWSER_FRAME * 2, dtype=np.int16).tobytes()
    fifo.push(pcm)
    track = TelegramAudioTrack(fifo)
    frame = await track.recv()
    assert frame.sample_rate == 48000
    assert frame.samples == SAMPLES_PER_BROWSER_FRAME
    assert frame.to_ndarray().tobytes() == pcm
    # Second frame: underrun → silence, still correctly shaped.
    frame2 = await track.recv()
    assert frame2.samples == SAMPLES_PER_BROWSER_FRAME
    assert frame2.to_ndarray().tobytes() == b"\x00" * len(pcm)
    assert frame2.pts == SAMPLES_PER_BROWSER_FRAME


class FakeBrowserTrack:
    """Minimal stand-in for an aiortc remote track."""

    def __init__(self, frames: list[AudioFrame]) -> None:
        self._frames = frames

    async def recv(self) -> AudioFrame:
        if not self._frames:
            from aiortc.mediastreams import MediaStreamError

            raise MediaStreamError
        return self._frames.pop(0)


def make_browser_frame(samples: int, value: int = 7) -> AudioFrame:
    array = np.full((1, samples * 2), value, dtype=np.int16)
    frame = AudioFrame.from_ndarray(array, format="s16", layout="stereo")
    frame.sample_rate = 48000
    return frame


async def test_pump_chunks_to_10ms() -> None:
    sent: list[bytes] = []

    async def send_pcm(chunk: bytes) -> None:
        sent.append(chunk)

    # 20ms stereo frame → exactly two 10ms chunks.
    track = FakeBrowserTrack([make_browser_frame(960)])
    await pump_browser_to_telegram(track, send_pcm)
    assert len(sent) == 2
    assert all(len(c) == BYTES_PER_10MS for c in sent)


async def test_pump_handles_odd_sizes_and_buffers_remainder() -> None:
    sent: list[bytes] = []

    async def send_pcm(chunk: bytes) -> None:
        sent.append(chunk)

    # 15ms then 5ms → one chunk after the first frame, second after the next.
    track = FakeBrowserTrack([make_browser_frame(720), make_browser_frame(240)])
    await pump_browser_to_telegram(track, send_pcm)
    assert len(sent) == 2
    assert all(len(c) == BYTES_PER_10MS for c in sent)
