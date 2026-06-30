import base64
import ipaddress
import struct

import pytest

from switchboard_voip_helper.session_convert import (
    SessionConvertError,
    to_telethon_string_session,
)

KEY = bytes(range(256))


def make_telethon(dc_id: int, ip: str, port: int, key: bytes = KEY) -> str:
    packed_ip = ipaddress.ip_address(ip).packed
    payload = struct.pack(f">B{len(packed_ip)}sH256s", dc_id, packed_ip, port, key)
    return "1" + base64.urlsafe_b64encode(payload).decode()


def make_gramjs(dc_id: int, address: str, port: int, key: bytes = KEY) -> str:
    addr = address.encode("ascii")
    payload = (
        bytes([dc_id])
        + len(addr).to_bytes(2, "big")
        + addr
        + port.to_bytes(2, "big")
        + key
    )
    return "1" + base64.b64encode(payload).decode()


def parse_telethon(session: str) -> tuple[int, str, int, bytes]:
    raw = base64.urlsafe_b64decode(session[1:])
    ip_len = 4 if len(raw) == 263 else 16
    dc_id, ip, port, key = struct.unpack(f">B{ip_len}sH256s", raw)
    return dc_id, ipaddress.ip_address(ip).compressed, port, key


def test_gramjs_ipv4_converts() -> None:
    src = make_gramjs(2, "149.154.167.91", 443)
    out = to_telethon_string_session(src)
    assert parse_telethon(out) == (2, "149.154.167.91", 443, KEY)


def test_gramjs_14_char_address_collision_with_telethon_ipv6_length() -> None:
    # A 14-char address makes the payload 275 bytes — same size as Telethon
    # IPv6 — so the converter must prefer the explicit GramJS layout.
    src = make_gramjs(4, "149.154.175.50", 443)
    assert len(base64.b64decode(src[1:])) == 275
    out = to_telethon_string_session(src)
    assert parse_telethon(out) == (4, "149.154.175.50", 443, KEY)


def test_telethon_ipv4_passthrough() -> None:
    src = make_telethon(5, "91.108.56.196", 443)
    out = to_telethon_string_session(src)
    assert parse_telethon(out) == (5, "91.108.56.196", 443, KEY)


def test_telethon_ipv6_passthrough() -> None:
    src = make_telethon(2, "2001:67c:4e8:f002::a", 443)
    out = to_telethon_string_session(src)
    assert parse_telethon(out) == (2, "2001:67c:4e8:f002::a", 443, KEY)


def test_gramjs_ipv6_string_address() -> None:
    src = make_gramjs(2, "2001:67c:4e8:f002::a", 443)
    out = to_telethon_string_session(src)
    assert parse_telethon(out) == (2, "2001:67c:4e8:f002::a", 443, KEY)


def test_rejects_garbage() -> None:
    with pytest.raises(SessionConvertError):
        to_telethon_string_session("")
    with pytest.raises(SessionConvertError):
        to_telethon_string_session("2abcdef")
    with pytest.raises(SessionConvertError):
        to_telethon_string_session("1!!!!")
    with pytest.raises(SessionConvertError):
        to_telethon_string_session("1" + base64.b64encode(b"too-short").decode())
