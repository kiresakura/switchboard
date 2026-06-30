from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field


def _read_int(e: Mapping[str, str], name: str, fallback: int) -> int:
    raw = (e.get(name) or "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
        return value if value > 0 else fallback
    except ValueError:
        return fallback


@dataclass(frozen=True)
class HelperConfig:
    host: str
    port: int
    secret: str
    api_id: int | None
    api_hash: str
    session_string: str
    gateway_url: str
    gateway_secret: str
    call_timeout_s: int
    log_level: str
    enable_qa_loopback: bool = False
    sample_rate: int = 48000
    channels: int = 1
    issues: list[str] = field(default_factory=list)

    @property
    def frame_bytes_10ms(self) -> int:
        # s16 PCM
        return self.sample_rate // 100 * self.channels * 2


def load_config(env: Mapping[str, str] | None = None) -> HelperConfig:
    e: Mapping[str, str] = os.environ if env is None else env
    issues: list[str] = []

    secret = (
        e.get("VOIP_HELPER_SECRET")
        or e.get("TELEGRAM_VOIP_GATEWAY_SECRET")
        or e.get("VOIP_GATEWAY_SECRET")
        or ""
    ).strip()
    if not secret:
        issues.append("MISSING_HELPER_SECRET")

    api_id: int | None = None
    api_id_raw = (e.get("TELEGRAM_API_ID") or "").strip()
    if api_id_raw:
        try:
            parsed = int(api_id_raw)
            api_id = parsed if parsed > 0 else None
        except ValueError:
            api_id = None
    if api_id is None:
        issues.append("MISSING_TELEGRAM_API_ID")

    api_hash = (e.get("TELEGRAM_API_HASH") or "").strip()
    if not api_hash:
        issues.append("MISSING_TELEGRAM_API_HASH")

    session_string = (
        e.get("VOIP_HELPER_SESSION_STRING")
        or e.get("TELEGRAM_SESSION_STRING")
        or ""
    ).strip()
    if not session_string:
        issues.append("MISSING_SESSION_STRING")

    gateway_secret = (
        e.get("VOIP_HELPER_GATEWAY_SECRET")
        or e.get("TELEGRAM_VOIP_GATEWAY_SECRET")
        or e.get("VOIP_GATEWAY_SECRET")
        or secret
    ).strip()

    return HelperConfig(
        host=(e.get("VOIP_HELPER_HOST") or "127.0.0.1").strip(),
        port=_read_int(e, "VOIP_HELPER_PORT", 3003),
        secret=secret,
        api_id=api_id,
        api_hash=api_hash,
        session_string=session_string,
        gateway_url=(e.get("VOIP_HELPER_GATEWAY_URL") or "http://127.0.0.1:3002").strip().rstrip("/"),
        gateway_secret=gateway_secret,
        call_timeout_s=_read_int(e, "VOIP_HELPER_CALL_TIMEOUT_S", 75),
        log_level=(e.get("LOG_LEVEL") or "info").strip().lower(),
        enable_qa_loopback=(e.get("VOIP_HELPER_ENABLE_QA_LOOPBACK") or "") == "1",
        issues=issues,
    )
