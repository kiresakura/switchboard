"""Switchboard Telegram VoIP media helper.

Owns the Telegram user session for real 1:1 calls (via py-tgcalls/ntgcalls)
and terminates browser WebRTC audio (via aiortc), bridging PCM both ways.

Control plane stays in services/telegram-voip-gateway (Node). This process
must only listen on localhost and must never log session strings, auth keys,
phone numbers, or media payloads.
"""

__version__ = "0.1.0"
