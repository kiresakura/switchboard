"""Telegram call orchestration: py-tgcalls (real TG 1:1 calls) + aiortc (browser).

State machine per call session (gateway-issued session id):

    outgoing: dialing -> ringing -> accepted -> connected -> ended
    incoming: incoming-ringing -> (answer) -> connected -> ended
    terminal: ended | declined | busy | timeout | missed | failed

Security invariants:
- never log session strings, auth keys, phone numbers, SDP or media payloads
- the Telegram session string only exists in config/memory
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from aiortc import (
    RTCConfiguration,
    RTCIceCandidate,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.sdp import candidate_from_sdp
from ntgcalls import MediaSource
from pytgcalls import PyTgCalls
from pytgcalls import filters as fl
from pytgcalls.exceptions import CallBusy, CallDeclined, NotInCallError, TimedOutAnswer
from pytgcalls.types import CallConfig, ChatUpdate, Device, Direction, RecordStream, StreamFrames
from pytgcalls.types.raw import AudioParameters, AudioStream, Stream
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl import types as tl

from .audio import CHANNELS, SAMPLE_RATE, PcmFifo, TelegramAudioTrack, pump_browser_to_telegram
from .config import HelperConfig
from .session_convert import to_telethon_string_session

logger = logging.getLogger("switchboard.voip.calls")

TERMINAL_STATES = {"ended", "declined", "busy", "timeout", "missed", "failed"}

# QA-only pseudo peer: browser audio is echoed back through the full helper
# PCM pipeline without touching Telegram. Gated by VOIP_HELPER_ENABLE_QA_LOOPBACK.
QA_LOOPBACK_PEER = "qa:loopback"

_AUDIO_PARAMS = AudioParameters(bitrate=SAMPLE_RATE, channels=CHANNELS)


def _capture_stream() -> Stream:
    return Stream(
        microphone=AudioStream(MediaSource.EXTERNAL, "", _AUDIO_PARAMS),
    )


def _record_stream() -> RecordStream:
    return RecordStream(audio=True, audio_parameters=_AUDIO_PARAMS)


@dataclass
class CallSession:
    session_id: str
    chat_id: int
    direction: str  # "outgoing" | "incoming"
    mode: str = "voice"
    state: str = "pending"
    detail: str | None = None
    pc: RTCPeerConnection | None = None
    tg_fifo: PcmFifo = field(default_factory=PcmFifo)
    tg_connected: bool = False
    browser_connected: bool = False
    call_task: asyncio.Task | None = None
    pump_tasks: list[asyncio.Task] = field(default_factory=list)
    created_at: float = field(default_factory=time.monotonic)
    answered: bool = False
    loopback: bool = False

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES


class CallError(Exception):
    def __init__(self, status: int, error: str, reason: str | None = None) -> None:
        super().__init__(error)
        self.status = status
        self.error = error
        self.reason = reason


NotifyFn = Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]]


class CallManager:
    """Owns one Telegram user session and all active call sessions."""

    def __init__(self, config: HelperConfig, notify_gateway: NotifyFn) -> None:
        self.config = config
        self.notify_gateway = notify_gateway
        self.client: TelegramClient | None = None
        self.calls: PyTgCalls | None = None
        self.telegram_ready = False
        self.readiness_reason: str | None = "NOT_STARTED"
        self.dialogs_warmed = False
        self.me_id: int | None = None
        self._sessions: dict[str, CallSession] = {}
        self._by_chat: dict[int, CallSession] = {}
        self._sweep_task: asyncio.Task | None = None

    # ------------------------------------------------------------------ setup

    async def start(self) -> None:
        if self.config.issues:
            self.readiness_reason = ",".join(self.config.issues)
            logger.warning("helper starting without Telegram session: %s", self.readiness_reason)
            return

        try:
            telethon_session = to_telethon_string_session(self.config.session_string)
        except Exception as err:
            self.readiness_reason = f"SESSION_CONVERT_FAILED:{type(err).__name__}"
            logger.error("session convert failed: %s", self.readiness_reason)
            return

        client = TelegramClient(
            StringSession(telethon_session),
            self.config.api_id or 0,
            self.config.api_hash,
            device_model="Switchboard VoIP Helper",
            system_version="switchboard-voip-helper",
        )
        try:
            await client.connect()
            if not await client.is_user_authorized():
                self.readiness_reason = "TELEGRAM_SESSION_INVALID"
                await client.disconnect()
                return
            me = await client.get_me()
            self.me_id = me.id if me else None
        except Exception as err:
            self.readiness_reason = f"TELEGRAM_CONNECT_FAILED:{type(err).__name__}"
            return

        self.client = client
        self.calls = PyTgCalls(client)
        self._register_handlers()
        await self.calls.start()
        self.telegram_ready = True
        self.readiness_reason = None
        logger.info("telegram session ready (user id ending %s)", str(self.me_id)[-4:] if self.me_id else "?")

        await self._warm_dialogs()
        self._sweep_task = asyncio.get_running_loop().create_task(self._sweep_loop())

    async def _warm_dialogs(self) -> None:
        """Fill telethon's entity cache so numeric peer ids resolve cold (F2 fix)."""
        if not self.client:
            return
        try:
            count = 0
            async for _ in self.client.iter_dialogs(limit=500):
                count += 1
            self.dialogs_warmed = True
            logger.info("dialog cache warmed (%d dialogs)", count)
        except Exception as err:
            logger.warning("dialog warm-up failed: %s", type(err).__name__)

    def _register_handlers(self) -> None:
        assert self.calls is not None and self.client is not None

        @self.calls.on_update(fl.chat_update(ChatUpdate.Status.INCOMING_CALL))
        async def _on_incoming(_: PyTgCalls, update: ChatUpdate) -> None:
            await self._handle_incoming(update.chat_id)

        @self.calls.on_update(
            fl.chat_update(
                ChatUpdate.Status.DISCARDED_CALL
                | ChatUpdate.Status.LEFT_CALL
                | ChatUpdate.Status.BUSY_CALL
            )
        )
        async def _on_discarded(_: PyTgCalls, update: ChatUpdate) -> None:
            session = self._by_chat.get(update.chat_id)
            if not session or session.terminal:
                return
            if update.status & ChatUpdate.Status.BUSY_CALL:
                state = "busy"
            elif session.direction == "incoming" and not session.answered:
                state = "missed"
            else:
                state = "ended"
            await self.end_session(session.session_id, state=state, discard_tg=False)

        @self.calls.on_update(fl.stream_frame(Direction.INCOMING, Device.MICROPHONE))
        async def _on_frames(_: PyTgCalls, update: StreamFrames) -> None:
            session = self._by_chat.get(update.chat_id)
            if not session or session.terminal:
                return
            for frame in update.frames:
                session.tg_fifo.push(frame.frame)

        self.client.add_event_handler(
            self._on_raw_phone_call,
            events.Raw(types=[tl.UpdatePhoneCall]),
        )

    # ------------------------------------------------------- incoming / states

    async def _handle_incoming(self, chat_id: int) -> None:
        existing = self._by_chat.get(chat_id)
        if existing and not existing.terminal:
            logger.info("ignoring duplicate incoming ring for active chat")
            return
        response = await self.notify_gateway(
            {
                "event": "incoming",
                "platformUserId": str(chat_id),
                "mode": "voice",
            }
        )
        session_id = (response or {}).get("sessionId") if isinstance(response, dict) else None
        if not isinstance(session_id, str) or not session_id:
            session_id = f"helper-{uuid.uuid4()}"
            logger.warning("gateway did not assign incoming session id; using local id")
        session = CallSession(
            session_id=session_id,
            chat_id=chat_id,
            direction="incoming",
            state="incoming-ringing",
        )
        self._sessions[session_id] = session
        self._by_chat[chat_id] = session
        logger.info("incoming call registered session=%s", session_id)

    async def _on_raw_phone_call(self, update: tl.UpdatePhoneCall) -> None:
        call = update.phone_call
        if self.me_id is None or call is None:
            return
        admin_id = getattr(call, "admin_id", None)
        participant_id = getattr(call, "participant_id", None)
        if admin_id is None or participant_id is None:
            return
        other = participant_id if admin_id == self.me_id else admin_id
        session = self._by_chat.get(other)
        if not session or session.terminal:
            return

        if isinstance(call, tl.PhoneCallWaiting) and session.direction == "outgoing":
            new_state = "ringing" if getattr(call, "receive_date", None) else "dialing"
            if session.state in ("pending", "dialing") and session.state != new_state:
                await self._set_state(session, new_state)
        elif isinstance(call, tl.PhoneCallAccepted):
            if not session.tg_connected:
                await self._set_state(session, "accepted")

    async def _set_state(self, session: CallSession, state: str, detail: str | None = None) -> None:
        session.state = state
        session.detail = detail
        logger.info("session=%s state=%s%s", session.session_id, state, f" detail={detail}" if detail else "")
        await self.notify_gateway(
            {
                "event": "state",
                "sessionId": session.session_id,
                "platformUserId": str(session.chat_id),
                "mode": session.mode,
                "state": state,
                "detail": detail,
            }
        )

    # ---------------------------------------------------------------- actions

    def _require_ready(self) -> PyTgCalls:
        if not self.telegram_ready or self.calls is None or self.client is None:
            raise CallError(503, "TELEGRAM_SESSION_NOT_READY", self.readiness_reason)
        return self.calls

    async def _resolve_chat_id(self, platform_user_id: str) -> int:
        assert self.client is not None
        raw = platform_user_id.strip()
        try:
            chat_id = int(raw)
        except ValueError:
            # QA convenience: allow @username targets (numeric ids in production).
            try:
                entity = await self.client.get_input_entity(raw)
            except Exception:
                raise CallError(422, "TELEGRAM_PEER_RESOLVE_FAILED", "USERNAME_RESOLVE_FAILED")
            user_id = getattr(entity, "user_id", None)
            if user_id is None:
                raise CallError(422, "TELEGRAM_PEER_RESOLVE_FAILED", "TARGET_IS_NOT_USER_PEER")
            return int(user_id)
        try:
            await self.client.get_input_entity(chat_id)
        except Exception:
            if not self.dialogs_warmed:
                await self._warm_dialogs()
            try:
                await self.client.get_input_entity(chat_id)
            except Exception:
                raise CallError(422, "TELEGRAM_PEER_RESOLVE_FAILED", "ENTITY_NOT_CACHED")
        return chat_id

    async def start_outgoing(
        self,
        session_id: str,
        platform_user_id: str,
        ice_servers: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        if (
            platform_user_id.strip() == QA_LOOPBACK_PEER
            and self.config.enable_qa_loopback
        ):
            return await self._start_loopback(session_id, ice_servers)
        self._require_ready()
        if session_id in self._sessions:
            raise CallError(409, "CALL_SESSION_ALREADY_EXISTS")
        chat_id = await self._resolve_chat_id(platform_user_id)
        existing = self._by_chat.get(chat_id)
        if existing and not existing.terminal:
            raise CallError(409, "CALL_ALREADY_ACTIVE_FOR_PEER")

        session = CallSession(session_id=session_id, chat_id=chat_id, direction="outgoing", state="dialing")
        self._sessions[session_id] = session
        self._by_chat[chat_id] = session

        try:
            offer = await self._create_peer(session, ice_servers)
        except Exception as err:
            await self.end_session(session_id, state="failed", discard_tg=False)
            raise CallError(500, "MEDIA_BRIDGE_SETUP_FAILED", type(err).__name__)

        session.call_task = asyncio.get_running_loop().create_task(self._run_call(session))
        return {"ok": True, "offer": offer, "state": session.state}

    async def answer(
        self,
        session_id: str,
        ice_servers: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        self._require_ready()
        session = self._sessions.get(session_id)
        if not session:
            raise CallError(404, "CALL_SESSION_NOT_FOUND")
        if session.direction != "incoming":
            raise CallError(400, "NOT_AN_INCOMING_CALL")
        if session.terminal:
            raise CallError(410, "CALL_ALREADY_ENDED", session.state)
        if session.answered:
            raise CallError(409, "CALL_ALREADY_ANSWERED")
        session.answered = True

        try:
            offer = await self._create_peer(session, ice_servers)
        except Exception as err:
            await self.end_session(session_id, state="failed")
            raise CallError(500, "MEDIA_BRIDGE_SETUP_FAILED", type(err).__name__)

        session.call_task = asyncio.get_running_loop().create_task(self._run_call(session))
        return {"ok": True, "offer": offer, "state": session.state}

    async def _create_peer(
        self,
        session: CallSession,
        ice_servers: list[dict[str, Any]] | None,
    ) -> dict[str, str]:
        servers: list[RTCIceServer] = []
        for entry in ice_servers or []:
            urls = entry.get("urls")
            if not urls:
                continue
            servers.append(
                RTCIceServer(
                    urls=urls,
                    username=entry.get("username"),
                    credential=entry.get("credential"),
                )
            )
        pc = RTCPeerConnection(RTCConfiguration(iceServers=servers) if servers else None)
        session.pc = pc
        pc.addTrack(TelegramAudioTrack(session.tg_fifo))

        @pc.on("track")
        def on_track(track) -> None:  # noqa: ANN001
            if track.kind != "audio":
                return
            task = asyncio.get_running_loop().create_task(
                pump_browser_to_telegram(track, self._make_pcm_sender(session))
            )
            session.pump_tasks.append(task)

        @pc.on("connectionstatechange")
        async def on_connection_state() -> None:
            state = pc.connectionState
            if state == "connected":
                session.browser_connected = True
                logger.info("session=%s browser webrtc connected", session.session_id)
            elif state in ("failed", "closed") and not session.terminal:
                await self.end_session(session.session_id, state="failed" if state == "failed" else "ended")

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        local = pc.localDescription
        return {"type": local.type, "sdp": local.sdp}

    async def _start_loopback(
        self,
        session_id: str,
        ice_servers: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        if session_id in self._sessions:
            raise CallError(409, "CALL_SESSION_ALREADY_EXISTS")
        session = CallSession(
            session_id=session_id,
            chat_id=0,
            direction="outgoing",
            state="connected",
            loopback=True,
        )
        session.tg_connected = True
        self._sessions[session_id] = session
        logger.info("session=%s QA loopback call created", session_id)
        try:
            offer = await self._create_peer(session, ice_servers)
        except Exception as err:
            await self.end_session(session_id, state="failed", discard_tg=False)
            raise CallError(500, "MEDIA_BRIDGE_SETUP_FAILED", type(err).__name__)
        return {"ok": True, "offer": offer, "state": session.state, "loopback": True}

    def _make_pcm_sender(self, session: CallSession):
        calls = self.calls

        async def send_pcm(chunk: bytes) -> None:
            if session.terminal:
                return
            if session.loopback:
                session.tg_fifo.push(chunk)
                return
            if calls is None or not session.tg_connected:
                return
            try:
                await calls.send_frame(session.chat_id, Device.MICROPHONE, chunk)
            except NotInCallError:
                return
            except Exception as err:  # noqa: BLE001
                logger.debug("send_frame error: %s", type(err).__name__)

        return send_pcm

    async def _run_call(self, session: CallSession) -> None:
        calls = self.calls
        assert calls is not None
        try:
            await calls.play(
                session.chat_id,
                _capture_stream(),
                config=CallConfig(timeout=self.config.call_timeout_s),
            )
            await calls.record(session.chat_id, _record_stream())
            session.tg_connected = True
            await self._set_state(session, "connected")
        except CallDeclined:
            await self.end_session(session.session_id, state="declined", discard_tg=False)
        except CallBusy:
            await self.end_session(session.session_id, state="busy", discard_tg=False)
        except TimedOutAnswer:
            await self.end_session(session.session_id, state="timeout", discard_tg=False)
        except Exception as err:  # noqa: BLE001
            if not session.terminal:
                logger.warning(
                    "session=%s telegram call failed: %s", session.session_id, type(err).__name__
                )
                await self.end_session(session.session_id, state="failed")

    async def handle_signal(self, session_id: str, signal: dict[str, Any]) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if not session:
            raise CallError(404, "CALL_SESSION_NOT_FOUND")
        kind = signal.get("type")
        pc = session.pc

        if kind in ("hangup", "ended", "bye"):
            await self.end_session(session_id, state="ended")
            return {"ok": True}

        if pc is None:
            raise CallError(409, "MEDIA_BRIDGE_NOT_STARTED")

        if kind == "answer":
            answer = signal.get("answer")
            sdp = answer.get("sdp") if isinstance(answer, dict) else signal.get("sdp")
            if not isinstance(sdp, str) or not sdp:
                raise CallError(400, "INVALID_ANSWER_SDP")
            await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="answer"))
            return {"ok": True}

        if kind == "candidate":
            payload = signal.get("candidate")
            if not isinstance(payload, dict):
                raise CallError(400, "INVALID_CANDIDATE")
            raw = payload.get("candidate")
            if not raw:
                return {"ok": True}  # end-of-candidates marker
            try:
                candidate = candidate_from_sdp(str(raw).removeprefix("candidate:"))
            except Exception:
                raise CallError(400, "INVALID_CANDIDATE")
            candidate.sdpMid = payload.get("sdpMid")
            mline = payload.get("sdpMLineIndex")
            candidate.sdpMLineIndex = int(mline) if isinstance(mline, (int, float)) else None
            await pc.addIceCandidate(candidate)
            return {"ok": True}

        logger.debug("ignoring unknown signal type")
        return {"ok": True, "ignored": True}

    async def end_session(
        self,
        session_id: str,
        state: str = "ended",
        discard_tg: bool = True,
    ) -> None:
        session = self._sessions.get(session_id)
        if not session:
            return
        already_terminal = session.terminal
        if not already_terminal:
            session.state = state

        for task in session.pump_tasks:
            task.cancel()
        session.pump_tasks.clear()
        if session.call_task and session.call_task is not asyncio.current_task():
            session.call_task.cancel()

        if session.pc is not None:
            pc, session.pc = session.pc, None
            try:
                await pc.close()
            except Exception:  # noqa: BLE001
                pass

        if discard_tg and self.calls is not None and not session.loopback:
            try:
                await self.calls.leave_call(session.chat_id)
            except NotInCallError:
                # Pending (unanswered) call: discard at the MTProto level.
                try:
                    await self.calls.mtproto_client.discard_call(session.chat_id, False)
                except Exception:  # noqa: BLE001
                    pass
            except Exception:  # noqa: BLE001
                pass

        if self._by_chat.get(session.chat_id) is session and session.tg_connected:
            session.tg_connected = False

        if not already_terminal:
            await self._set_state(session, state, session.detail)

        # Keep terminal sessions for a short while so late signals 404 cleanly.
        loop = asyncio.get_running_loop()
        loop.call_later(60, self._drop_session, session_id)

    def _drop_session(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session and self._by_chat.get(session.chat_id) is session:
            self._by_chat.pop(session.chat_id, None)

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            now = time.monotonic()
            for session in list(self._sessions.values()):
                stale_pending = (
                    session.state in ("incoming-ringing", "pending")
                    and now - session.created_at > 180
                )
                stale_any = now - session.created_at > 3600
                if stale_pending or stale_any:
                    await self.end_session(session.session_id, state="missed" if stale_pending else "ended")

    # ----------------------------------------------------------------- status

    def health(self) -> dict[str, Any]:
        active = [s for s in self._sessions.values() if not s.terminal]
        return {
            "status": "ok",
            "mode": "media-helper",
            "telegramSessionReady": self.telegram_ready,
            "mediaBridgeReady": self.telegram_ready,
            "fullDuplexAudioReady": self.telegram_ready,
            "videoReady": False,
            "dialogsWarmed": self.dialogs_warmed,
            "activeCalls": len(active),
            "reason": self.readiness_reason,
        }

    def session_info(self, session_id: str) -> dict[str, Any] | None:
        session = self._sessions.get(session_id)
        if not session:
            return None
        return {
            "sessionId": session.session_id,
            "direction": session.direction,
            "mode": session.mode,
            "state": session.state,
            "detail": session.detail,
            "browserConnected": session.browser_connected,
            "telegramConnected": session.tg_connected,
        }

    async def shutdown(self) -> None:
        if self._sweep_task:
            self._sweep_task.cancel()
        for session_id in list(self._sessions):
            await self.end_session(session_id, state="ended")
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:  # noqa: BLE001
                pass
