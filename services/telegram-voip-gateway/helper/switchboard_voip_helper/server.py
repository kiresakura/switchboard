"""Localhost HTTP API for the Switchboard Telegram VoIP media helper.

Consumed exclusively by services/telegram-voip-gateway (Node). Bearer-token
authenticated; binds to 127.0.0.1 by default. Event callbacks flow back to the
gateway's /internal/helper-events endpoint.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import signal
from typing import Any

import aiohttp
from aiohttp import web

from .call_manager import CallError, CallManager
from .config import HelperConfig, load_config

logger = logging.getLogger("switchboard.voip.server")

ROUTE_SESSION_ID = "session_id"


def _bearer_ok(request: web.Request, secret: str) -> bool:
    if not secret:
        return False
    header = request.headers.get("Authorization", "")
    return hmac.compare_digest(header, f"Bearer {secret}")


def _json_error(status: int, error: str, reason: str | None = None) -> web.Response:
    body: dict[str, Any] = {"error": error}
    if reason:
        body["reason"] = reason
    return web.json_response(body, status=status)


class GatewayNotifier:
    """POSTs helper events to the gateway; failures are logged, never raised."""

    def __init__(self, config: HelperConfig) -> None:
        self._url = f"{config.gateway_url}/internal/helper-events"
        self._secret = config.gateway_secret
        self._session: aiohttp.ClientSession | None = None

    async def start(self) -> None:
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=5),
            headers={"Authorization": f"Bearer {self._secret}"},
        )

    async def close(self) -> None:
        if self._session:
            await self._session.close()

    async def __call__(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        if not self._session:
            return None
        for attempt in (1, 2):
            try:
                async with self._session.post(self._url, json=payload) as res:
                    if res.status >= 500 and attempt == 1:
                        continue
                    if res.status >= 400:
                        logger.warning(
                            "gateway event rejected status=%s event=%s",
                            res.status,
                            payload.get("event"),
                        )
                        return None
                    return await res.json(content_type=None)
            except Exception as err:  # noqa: BLE001
                if attempt == 2:
                    logger.warning("gateway event delivery failed: %s", type(err).__name__)
        return None


def build_app(config: HelperConfig, manager: CallManager) -> web.Application:
    app = web.Application()

    @web.middleware
    async def auth_middleware(request: web.Request, handler):  # noqa: ANN001, ANN202
        if request.path == "/health":
            return await handler(request)
        if not _bearer_ok(request, config.secret):
            return _json_error(401, "UNAUTHORIZED")
        return await handler(request)

    app.middlewares.append(auth_middleware)

    async def read_json(request: web.Request) -> dict[str, Any]:
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            raise CallError(400, "INVALID_JSON_BODY")
        return data if isinstance(data, dict) else {}

    def ice_servers_of(body: dict[str, Any]) -> list[dict[str, Any]] | None:
        servers = body.get("iceServers")
        return servers if isinstance(servers, list) else None

    async def health(_: web.Request) -> web.Response:
        return web.json_response(manager.health())

    async def create_call(request: web.Request) -> web.Response:
        body = await read_json(request)
        session_id = str(body.get("sessionId") or "").strip()
        platform_user_id = str(body.get("platformUserId") or "").strip()
        mode = body.get("mode", "voice")
        if not session_id or not platform_user_id:
            return _json_error(400, "MISSING_SESSION_OR_PEER")
        if mode != "voice":
            return _json_error(400, "REAL_CALL_MODE_NOT_SUPPORTED", "VOICE_ONLY")
        result = await manager.start_outgoing(session_id, platform_user_id, ice_servers_of(body))
        return web.json_response(result)

    async def answer_call(request: web.Request) -> web.Response:
        body = await read_json(request)
        session_id = request.match_info[ROUTE_SESSION_ID]
        result = await manager.answer(session_id, ice_servers_of(body))
        return web.json_response(result)

    async def signal_call(request: web.Request) -> web.Response:
        body = await read_json(request)
        signal_payload = body.get("signal")
        if not isinstance(signal_payload, dict):
            return _json_error(400, "MISSING_SIGNAL")
        result = await manager.handle_signal(request.match_info[ROUTE_SESSION_ID], signal_payload)
        return web.json_response(result)

    async def get_call(request: web.Request) -> web.Response:
        info = manager.session_info(request.match_info[ROUTE_SESSION_ID])
        if info is None:
            return _json_error(404, "CALL_SESSION_NOT_FOUND")
        return web.json_response(info)

    async def delete_call(request: web.Request) -> web.Response:
        await manager.end_session(request.match_info[ROUTE_SESSION_ID], state="ended")
        return web.json_response({"ok": True})

    @web.middleware
    async def error_middleware(request: web.Request, handler):  # noqa: ANN001, ANN202
        try:
            return await handler(request)
        except CallError as err:
            return _json_error(err.status, err.error, err.reason)
        except web.HTTPException:
            raise
        except Exception as err:  # noqa: BLE001
            logger.exception("unhandled error on %s: %s", request.path, type(err).__name__)
            return _json_error(500, "INTERNAL_HELPER_ERROR")

    app.middlewares.insert(0, error_middleware)

    app.router.add_get("/health", health)
    app.router.add_post("/calls", create_call)
    app.router.add_post("/calls/{session_id}/answer", answer_call)
    app.router.add_post("/calls/{session_id}/signals", signal_call)
    app.router.add_get("/calls/{session_id}", get_call)
    app.router.add_delete("/calls/{session_id}", delete_call)
    return app


async def run() -> None:
    config = load_config()
    logging.basicConfig(
        level=logging.DEBUG if config.log_level == "debug" else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # Never let third-party debug logs leak payloads.
    logging.getLogger("aiortc").setLevel(logging.WARNING)
    logging.getLogger("aioice").setLevel(logging.WARNING)
    logging.getLogger("telethon").setLevel(logging.WARNING)
    logging.getLogger("pytgcalls").setLevel(logging.WARNING)
    logging.getLogger("ntgcalls").setLevel(logging.WARNING)

    notifier = GatewayNotifier(config)
    await notifier.start()
    manager = CallManager(config, notifier)
    await manager.start()

    app = build_app(config, manager)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, config.host, config.port)
    await site.start()
    logger.info(
        "Switchboard VoIP helper listening on http://%s:%d (telegramReady=%s reason=%s)",
        config.host,
        config.port,
        manager.telegram_ready,
        manager.readiness_reason,
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    await stop.wait()

    logger.info("shutting down")
    await manager.shutdown()
    await runner.cleanup()
    await notifier.close()


def main() -> None:
    asyncio.run(run())
