"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Video,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

type CallMode = "voice" | "video";
type CallDirection = "outgoing" | "incoming";
type CallPhase =
  | "incoming"
  | "requesting-media"
  | "starting"
  | "connecting"
  | "active"
  | "ending"
  | "failed";

type GatewayStartResponse = {
  success?: boolean;
  sessionId?: string;
  signalingUrl?: string | null;
  iceServers?: RTCIceServer[];
  offer?: RTCSessionDescriptionInit | null;
  mockConnected?: boolean;
  message?: string;
  error?: string;
  reason?: string;
  realTelegramCalls?: boolean;
  telegramSessionReady?: boolean;
  mediaBridgeReady?: boolean;
  outgoingRingingSpikeReady?: boolean;
  incomingDetectionReady?: boolean;
  fullDuplexAudioReady?: boolean;
  videoReady?: boolean;
};

type SignalMessage =
  | { type: "offer"; offer?: RTCSessionDescriptionInit; sdp?: string }
  | { type: "candidate"; candidate?: RTCIceCandidateInit }
  | { type: "state"; state?: string }
  | { type: "ended"; reason?: string }
  | { type: string; [key: string]: unknown };

type Props = {
  workspaceId: string;
  groupId: string;
  accountId: string;
  title: string;
  mode: CallMode;
  direction: CallDirection;
  gatewaySessionId?: string;
  /** Telegram 端通話狀態(由 SSE call:updated 餵入,例如 ringing/connected)。 */
  remoteStateHint?: string;
  onClose: () => void;
};

function phaseLabel(phase: CallPhase) {
  switch (phase) {
    case "incoming":
      return "Telegram 來電";
    case "requesting-media":
      return "正在開啟裝置";
    case "starting":
      return "正在建立通話";
    case "connecting":
      return "正在連線";
    case "active":
      return "通話中";
    case "ending":
      return "正在結束";
    case "failed":
      return "通話失敗";
  }
}

function remoteStateLabel(state: string | undefined) {
  switch (state) {
    case "dialing":
      return "正在撥號";
    case "ringing":
    case "incoming-ringing":
      return "對方響鈴中";
    case "accepted":
      return "對方已接聽";
    case "connected":
      return "Telegram 已接通";
    default:
      return "";
  }
}

function displayLabel(phase: CallPhase, remoteHint: string | undefined) {
  if (phase === "active" && (remoteHint === "dialing" || remoteHint === "ringing")) {
    return "等待對方接聽";
  }
  return phaseLabel(phase);
}

class CallStartupError extends Error {
  code: string;
  status?: number;
  fallbackAvailable: boolean;

  constructor(
    message: string,
    options: { code?: string; status?: number; fallbackAvailable?: boolean } = {},
  ) {
    super(message);
    this.name = "CallStartupError";
    this.code = options.code || "CALL_START_FAILED";
    this.status = options.status;
    this.fallbackAvailable = options.fallbackAvailable === true;
  }
}

function isGatewayUnavailable(status: number, code?: string) {
  return (
    status === 501 ||
    status === 502 ||
    status === 503 ||
    code === "EMBEDDED_CALL_GATEWAY_NOT_CONFIGURED" ||
    code === "VOIP_GATEWAY_UNREACHABLE" ||
    code === "VOIP_GATEWAY_ERROR" ||
    code === "TELEGRAM_SESSION_NOT_READY" ||
    code === "TELEGRAM_PHONE_REQUEST_CALL_FAILED" ||
    code === "TELEGRAM_PHONE_REQUEST_CALL_NOT_SUPPORTED" ||
    code === "TELEGRAM_PEER_RESOLUTION_FAILED" ||
    code === "TELEGRAM_PEER_RESOLVE_FAILED" ||
    code === "REAL_TELEGRAM_CALL_NOT_IMPLEMENTED"
  );
}

function gatewayReadinessMessage(data: GatewayStartResponse) {
  if (
    data.realTelegramCalls === false ||
    data.mediaBridgeReady === false ||
    data.fullDuplexAudioReady === false
  ) {
    return "Gateway 已連線，但真實 Telegram 內嵌通話尚未 ready。可改用 Telegram 原生 App。";
  }
  if (data.telegramSessionReady === false) {
    return "Gateway 尚未載入可用的 Telegram user session。可改用 Telegram 原生 App。";
  }
  return "";
}

function policyAllowsFeature(feature: "microphone" | "camera") {
  const doc = document as Document & {
    permissionsPolicy?: { allowsFeature: (name: string) => boolean };
    featurePolicy?: { allowsFeature: (name: string) => boolean };
  };
  const policy = doc.permissionsPolicy || doc.featurePolicy;
  if (!policy?.allowsFeature) return true;
  try {
    return policy.allowsFeature(feature);
  } catch {
    return true;
  }
}

function describeMediaError(err: unknown, mode: CallMode) {
  const name = err instanceof DOMException ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  const micBlocked = !policyAllowsFeature("microphone");
  const cameraBlocked = mode === "video" && !policyAllowsFeature("camera");

  if (name === "NotAllowedError" && (micBlocked || cameraBlocked)) {
    return new CallStartupError(
      "瀏覽器安全政策目前禁止此頁面使用麥克風或攝影機。請確認 production 的 Permissions-Policy 允許 microphone/camera，或改用 Telegram 原生 App。",
      { code: "MEDIA_POLICY_BLOCKED", fallbackAvailable: true },
    );
  }
  if (name === "NotAllowedError") {
    return new CallStartupError(
      "你尚未允許 Switchboard 使用麥克風或攝影機。可在瀏覽器網址列重新開啟權限，或改用 Telegram 原生 App。",
      { code: "MEDIA_PERMISSION_DENIED", fallbackAvailable: true },
    );
  }
  if (name === "NotFoundError") {
    return new CallStartupError("找不到可用的麥克風或攝影機。", {
      code: "MEDIA_DEVICE_NOT_FOUND",
      fallbackAvailable: true,
    });
  }
  return new CallStartupError(message || "內嵌通話裝置啟動失敗", {
    code: "MEDIA_REQUEST_FAILED",
    fallbackAvailable: true,
  });
}

function isSafeTelegramUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  if (value.startsWith("tg:") || value.startsWith("tel:")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "t.me";
  } catch {
    return false;
  }
}

export function EmbeddedTelegramCallModal({
  workspaceId,
  groupId,
  accountId,
  title,
  mode,
  direction,
  gatewaySessionId,
  remoteStateHint,
  onClose,
}: Props) {
  const [phase, setPhase] = useState<CallPhase>(
    direction === "incoming" ? "incoming" : "requesting-media",
  );
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(mode === "video");
  const [remoteState, setRemoteState] = useState("");
  const [fallbackAvailable, setFallbackAvailable] = useState(false);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [fallbackError, setFallbackError] = useState("");

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const startedRef = useRef(false);
  const sessionIdRef = useRef("");

  const apiUrl = `/api/workspaces/${workspaceId}/groups/${groupId}/embedded-call`;
  const callIntentUrl = `/api/workspaces/${workspaceId}/groups/${groupId}/call-intent`;

  const cleanupMedia = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const endGatewaySession = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    await fetch(apiUrl, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, sessionId: activeSessionId }),
    }).catch(() => null);
    sessionIdRef.current = "";
  }, [accountId, apiUrl]);

  const close = useCallback(async () => {
    setPhase("ending");
    cleanupMedia();
    await endGatewaySession();
    onClose();
  }, [cleanupMedia, endGatewaySession, onClose]);

  const sendSignal = useCallback(
    async (payload: Record<string, unknown>) => {
      const activeSessionId = sessionIdRef.current;
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify(payload));
        return;
      }
      if (!activeSessionId) return;
      await fetch(apiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          sessionId: activeSessionId,
          signal: payload,
        }),
      }).catch(() => null);
    },
    [accountId, apiUrl],
  );

  const handleOffer = useCallback(
    async (peer: RTCPeerConnection, offer: RTCSessionDescriptionInit) => {
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await sendSignal({ type: "answer", answer });
      setPhase("connecting");
    },
    [sendSignal],
  );

  const handleSignalMessage = useCallback(
    async (message: SignalMessage, peer: RTCPeerConnection) => {
      if (message.type === "offer") {
        const offer: RTCSessionDescriptionInit =
          message.offer && typeof message.offer === "object"
            ? (message.offer as RTCSessionDescriptionInit)
            : {
                type: "offer",
                sdp: typeof message.sdp === "string" ? message.sdp : "",
              };
        if (offer.sdp) await handleOffer(peer, offer);
        return;
      }
      if (message.type === "candidate" && message.candidate) {
        await peer.addIceCandidate(message.candidate).catch(() => null);
        return;
      }
      if (message.type === "state") {
        setRemoteState(typeof message.state === "string" ? message.state : "");
        return;
      }
      if (message.type === "ended") {
        void close();
      }
    },
    [close, handleOffer],
  );

  const setupPeer = useCallback(
    async (data: GatewayStartResponse, stream: MediaStream) => {
      if (data.mockConnected && !data.signalingUrl && !data.offer) {
        setRemoteState("Mock gateway connected");
        setPhase("active");
        return;
      }

      const peer = new RTCPeerConnection({
        iceServers: Array.isArray(data.iceServers) ? data.iceServers : [],
      });
      peerRef.current = peer;

      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;

      peer.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => {
          if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
            remoteStream.addTrack(track);
          }
        });
        setPhase("active");
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") setPhase("active");
        if (peer.connectionState === "failed") {
          startedRef.current = false;
          setFallbackAvailable(true);
          setError("WebRTC 連線失敗");
          setPhase("failed");
        }
      };
      peer.onicecandidate = (event) => {
        if (event.candidate) {
          void sendSignal({ type: "candidate", candidate: event.candidate.toJSON() });
        }
      };

      if (data.signalingUrl) {
        const socket = new WebSocket(data.signalingUrl);
        socketRef.current = socket;
        socket.onopen = () => {
          socket.send(JSON.stringify({
            type: "client-ready",
            sessionId: data.sessionId,
            mode,
          }));
        };
        socket.onmessage = (event) => {
          try {
            void handleSignalMessage(JSON.parse(event.data) as SignalMessage, peer);
          } catch {
            // Ignore malformed gateway messages.
          }
        };
        socket.onerror = () => {
          startedRef.current = false;
          setFallbackAvailable(true);
          setError("VoIP signaling 連線失敗");
          setPhase("failed");
        };
      }

      if (data.offer) {
        await handleOffer(peer, data.offer);
      } else if (!data.signalingUrl) {
        throw new CallStartupError("VoIP gateway 未回傳 signaling channel", {
          code: "VOIP_SIGNALING_UNAVAILABLE",
          fallbackAvailable: true,
        });
      }
    },
    [handleOffer, handleSignalMessage, mode, sendSignal],
  );

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setError("");
    setFallbackError("");
    setFallbackAvailable(false);
    setPhase("requesting-media");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new CallStartupError("此瀏覽器不支援通話裝置", {
          code: "MEDIA_DEVICES_UNSUPPORTED",
          fallbackAvailable: true,
        });
      }
      const stream = await navigator.mediaDevices
        .getUserMedia({
          audio: true,
          video: mode === "video",
        })
        .catch((err) => {
          throw describeMediaError(err, mode);
        });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      setPhase("starting");
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          direction,
          accountId,
          gatewaySessionId,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as GatewayStartResponse;
      if (!res.ok || !data.sessionId) {
        const code = typeof data.error === "string" ? data.error : "EMBEDDED_CALL_FAILED";
        throw new CallStartupError(
          gatewayReadinessMessage(data) || data.message || code || "無法建立內嵌通話 session",
          {
          code,
          status: res.status,
          fallbackAvailable: isGatewayUnavailable(res.status, code),
          },
        );
      }
      setSessionId(data.sessionId);
      sessionIdRef.current = data.sessionId;
      setPhase("connecting");
      await setupPeer(data, stream);
    } catch (err) {
      startedRef.current = false;
      cleanupMedia();
      if (err instanceof CallStartupError) {
        setFallbackAvailable(err.fallbackAvailable);
        setError(err.message);
      } else {
        setFallbackAvailable(true);
        setError(err instanceof Error ? err.message : "內嵌通話啟動失敗");
      }
      setPhase("failed");
    }
  }, [accountId, apiUrl, cleanupMedia, direction, gatewaySessionId, mode, setupPeer]);

  useEffect(() => {
    if (direction === "outgoing") void start();
  }, [direction, start]);

  useEffect(() => {
    const label = remoteStateLabel(remoteStateHint);
    if (label) setRemoteState(label);
  }, [remoteStateHint]);

  useEffect(() => {
    return () => {
      cleanupMedia();
      void endGatewaySession();
    };
  }, [cleanupMedia, endGatewaySession]);

  const openNativeTelegram = useCallback(async () => {
    setFallbackBusy(true);
    setFallbackError("");
    try {
      const res = await fetch(callIntentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, accountId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        launchUrl?: unknown;
        webUrl?: unknown;
        phoneUrl?: unknown;
        message?: unknown;
        error?: unknown;
      };
      if (!res.ok) {
        throw new Error(
          typeof data.message === "string"
            ? data.message
            : typeof data.error === "string"
              ? data.error
              : "無法建立 Telegram 原生 App 入口",
        );
      }

      const target = [data.launchUrl, data.webUrl, data.phoneUrl].find(isSafeTelegramUrl);
      if (!target) {
        throw new Error("後端未回傳安全的 Telegram 開啟連結");
      }
      window.open(target, "_blank", "noopener,noreferrer");
    } catch (err) {
      setFallbackError(err instanceof Error ? err.message : "Telegram 原生 App 入口啟動失敗");
    } finally {
      setFallbackBusy(false);
    }
  }, [accountId, callIntentUrl, mode]);

  const toggleMic = () => {
    const next = !micEnabled;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    setMicEnabled(next);
  };

  const toggleCamera = () => {
    const next = !cameraEnabled;
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = next;
    });
    setCameraEnabled(next);
  };

  const isIncomingIdle = phase === "incoming";
  const isBusy = phase === "requesting-media" || phase === "starting" || phase === "connecting";
  const Icon = mode === "video" ? Video : PhoneCall;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--overlay-scrim-strong)] p-4">
      <div className="w-full max-w-3xl overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-full bg-[var(--accent-bg)] text-[var(--accent)]">
              <Icon className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--foreground)]">
                <bdi>{title}</bdi>
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">
                {displayLabel(phase, remoteStateHint)}
                {remoteState ? ` · ${remoteState}` : ""}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void close()}
            className="rounded-full p-2 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--foreground)]"
            aria-label="關閉通話"
            title="關閉通話"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-[1fr_180px]">
          {/* 語音模式沒有 <video>,遠端音訊靠這個常駐元素播放。 */}
          <audio ref={remoteAudioRef} autoPlay className="hidden" />
          <div className="relative flex min-h-[260px] items-center justify-center overflow-hidden rounded-lg bg-[var(--call-stage-bg)] text-white">
            {mode === "video" ? (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="h-full min-h-[260px] w-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="flex size-20 items-center justify-center rounded-full bg-white/10">
                  <PhoneCall className="size-8" />
                </div>
                <div className="text-sm text-white/80">{displayLabel(phase, remoteStateHint)}</div>
              </div>
            )}
            {isBusy && (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--overlay-scrim)]">
                <Loader2 className="size-6 animate-spin text-white" />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="relative overflow-hidden rounded-lg bg-[var(--media-surface)]">
              {mode === "video" ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className={cn(
                    "aspect-[4/3] w-full object-cover",
                    !cameraEnabled && "opacity-20",
                  )}
                />
              ) : (
                <div className="flex aspect-[4/3] items-center justify-center text-white">
                  <Mic className="size-8" />
                </div>
              )}
              <div className="absolute bottom-2 left-2 rounded bg-[var(--inverse-chip-bg)] px-1.5 py-0.5 text-[10px] text-white">
                本機
              </div>
            </div>

            {error && (
              <div className="space-y-2 rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
                <div>{error}</div>
                {fallbackAvailable && (
                  <button
                    type="button"
                    onClick={() => void openNativeTelegram()}
                    disabled={fallbackBusy}
                    className="inline-flex items-center justify-center rounded-md bg-[var(--foreground)] px-2.5 py-1.5 text-xs font-medium text-[var(--background)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {fallbackBusy ? "正在開啟..." : "改用 Telegram 原生 App"}
                  </button>
                )}
                {fallbackError && (
                  <div className="text-[11px] text-[var(--destructive)]">{fallbackError}</div>
                )}
              </div>
            )}
            {sessionId && (
              <div className="truncate text-[10px] text-[var(--muted-foreground)]" title={sessionId}>
                session {sessionId}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 border-t border-[var(--border)] px-4 py-3">
          {isIncomingIdle ? (
            <>
              <button
                type="button"
                onClick={() => void close()}
                className="inline-flex size-11 items-center justify-center rounded-full bg-[var(--destructive)] text-white transition-colors hover:opacity-90"
                aria-label="拒接"
                title="拒接"
              >
                <PhoneOff className="size-5" />
              </button>
              <button
                type="button"
                onClick={() => void start()}
                className="inline-flex size-11 items-center justify-center rounded-full bg-[var(--success)] text-white transition-colors hover:opacity-90"
                aria-label="接聽"
                title="接聽"
              >
                <PhoneCall className="size-5" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={toggleMic}
                className={cn(
                  "inline-flex size-10 items-center justify-center rounded-full border border-[var(--border)] transition-colors hover:bg-[var(--bg-secondary)]",
                  !micEnabled && "bg-[var(--destructive)]/10 text-[var(--destructive)]",
                )}
                aria-label={micEnabled ? "關閉麥克風" : "開啟麥克風"}
                title={micEnabled ? "關閉麥克風" : "開啟麥克風"}
              >
                {micEnabled ? <Mic className="size-4" /> : <MicOff className="size-4" />}
              </button>
              {mode === "video" && (
                <button
                  type="button"
                  onClick={toggleCamera}
                  className={cn(
                    "inline-flex size-10 items-center justify-center rounded-full border border-[var(--border)] transition-colors hover:bg-[var(--bg-secondary)]",
                    !cameraEnabled && "bg-[var(--destructive)]/10 text-[var(--destructive)]",
                  )}
                  aria-label={cameraEnabled ? "關閉攝影機" : "開啟攝影機"}
                  title={cameraEnabled ? "關閉攝影機" : "開啟攝影機"}
                >
                  {cameraEnabled ? <Camera className="size-4" /> : <CameraOff className="size-4" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => void close()}
                className="inline-flex size-11 items-center justify-center rounded-full bg-[var(--destructive)] text-white transition-colors hover:opacity-90"
                aria-label="結束通話"
                title="結束通話"
              >
                <PhoneOff className="size-5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
