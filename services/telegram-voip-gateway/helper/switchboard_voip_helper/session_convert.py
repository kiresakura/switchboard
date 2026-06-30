"""Convert a GramJS StringSession to Telethon's StringSession format.

Both formats start with version character "1" followed by base64 payload:

- Telethon: urlsafe base64 of struct ``>B{4|16}sH256s``
  (dc_id, packed ip, port, auth_key) — payload is exactly 263 (IPv4) or
  275 (IPv6) bytes.
- GramJS:   standard base64 of
  ``dcId(1) + addrLen(int16BE) + serverAddress(utf8) + port(int16BE) + authKey(256)``
  with a legacy branch where the address is raw 4/16 bytes (Telethon-compat).

The auth key is identical in both formats; only the packing differs.
"""

from __future__ import annotations

import base64
import ipaddress
import struct

_AUTH_KEY_LEN = 256
_TELETHON_IPV4_LEN = 1 + 4 + 2 + _AUTH_KEY_LEN  # 263
_TELETHON_IPV6_LEN = 1 + 16 + 2 + _AUTH_KEY_LEN  # 275


class SessionConvertError(ValueError):
    pass


def _pack_telethon(dc_id: int, ip: ipaddress.IPv4Address | ipaddress.IPv6Address, port: int, key: bytes) -> str:
    if len(key) != _AUTH_KEY_LEN:
        raise SessionConvertError("INVALID_AUTH_KEY_LENGTH")
    packed = struct.pack(f">B{len(ip.packed)}sH{_AUTH_KEY_LEN}s", dc_id, ip.packed, port, key)
    return "1" + base64.urlsafe_b64encode(packed).decode("ascii")


def _try_parse_gramjs_string_address(raw: bytes) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, int, bytes] | None:
    """Parse the GramJS layout where the server address is a UTF-8 string."""
    if len(raw) < 3:
        return None
    addr_len = int.from_bytes(raw[1:3], "big")
    if not (2 < addr_len <= 100):
        return None
    if len(raw) != 3 + addr_len + 2 + _AUTH_KEY_LEN:
        return None
    try:
        address = raw[3 : 3 + addr_len].decode("ascii")
        ip = ipaddress.ip_address(address)
    except (UnicodeDecodeError, ValueError):
        return None
    port = int.from_bytes(raw[3 + addr_len : 3 + addr_len + 2], "big")
    return ip, port, raw[3 + addr_len + 2 :]


def _parse_raw_ip_layout(raw: bytes) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, int, bytes]:
    """Parse the fixed layout shared by Telethon and legacy GramJS (raw ip bytes)."""
    ip_len = 4 if len(raw) == _TELETHON_IPV4_LEN else 16
    dc_id, ip_bytes, port, key = struct.unpack(f">B{ip_len}sH{_AUTH_KEY_LEN}s", raw)
    del dc_id
    return ipaddress.ip_address(ip_bytes), port, key


def to_telethon_string_session(session: str) -> str:
    """Return a Telethon-format string session, converting from GramJS if needed."""
    session = (session or "").strip()
    if not session or session[0] != "1":
        raise SessionConvertError("UNSUPPORTED_SESSION_STRING")
    payload = session[1:]

    decoded: dict[str, bytes] = {}
    try:
        decoded["urlsafe"] = base64.urlsafe_b64decode(payload)
    except Exception:
        pass
    try:
        decoded["standard"] = base64.b64decode(payload)
    except Exception:
        pass
    if not decoded:
        raise SessionConvertError("INVALID_BASE64_PAYLOAD")

    for raw in decoded.values():
        # GramJS string-address layout is unambiguous: explicit length prefix
        # that must exactly account for the payload size and parse as an IP.
        parsed = _try_parse_gramjs_string_address(raw)
        if parsed is not None:
            ip, port, key = parsed
            return _pack_telethon(raw[0], ip, port, key)

    for kind, raw in decoded.items():
        if len(raw) in (_TELETHON_IPV4_LEN, _TELETHON_IPV6_LEN):
            ip, port, key = _parse_raw_ip_layout(raw)
            if kind == "urlsafe" and decoded.get("standard") == raw:
                # Alphabet-neutral payload: identical bytes either way.
                pass
            return _pack_telethon(raw[0], ip, port, key)

    raise SessionConvertError("UNRECOGNIZED_SESSION_LAYOUT")
