import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { eventBus } from "@/lib/realtime/event-bus";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId");

  if (!workspaceId) {
    return new Response("workspaceId required", { status: 400 });
  }

  // Verify workspace membership
  const membership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId: session.user.id,
        workspaceId,
      },
    },
  });

  if (!membership && !session.user.isSystemAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  // Log admin accessing other workspace's SSE
  if (!membership && session.user.isSystemAdmin) {
    prisma.auditLog.create({
      data: {
        workspaceId,
        userId: session.user.id,
        action: "admin.sse_subscribe",
        entityType: "Workspace",
        entityId: workspaceId,
      },
    }).catch(() => {});
  }

  // Support event replay via Last-Event-ID header or query param. The query
  // param is used by the HTTP poll fallback because fetch cannot set the
  // browser-managed EventSource Last-Event-ID header.
  const lastEventId =
    request.headers.get("Last-Event-ID") ||
    url.searchParams.get("lastEventId") ||
    undefined;

  if (url.searchParams.get("mode") === "poll") {
    const since = Number(url.searchParams.get("since") || "");
    const events = eventBus
      .getReplayEvents(workspaceId, lastEventId)
      .filter((event) =>
        lastEventId || !Number.isFinite(since) ? true : event.timestamp > since,
      )
      .map((event) => ({
        id: event.id,
        type: event.type,
        data: event.data,
        timestamp: event.timestamp,
      }));
    return Response.json({ events });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Replay missed events (if reconnecting)
      if (lastEventId) {
        const missed = eventBus.getReplayEvents(workspaceId, lastEventId);
        for (const event of missed) {
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${event.id}\ndata: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`
              )
            );
          } catch {
            break;
          }
        }
      }

      // Some reverse proxies/tunnels buffer very small SSE chunks. Send an
      // initial padding comment before the first data event so Cloudflare
      // tunnel flushes the stream promptly instead of holding realtime events.
      controller.enqueue(encoder.encode(`: ${" ".repeat(2048)}\n\n`));

      // Send initial connection event
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "connected", userId: session.user.id })}\n\n`
        )
      );

      // Listen for new events — include event ID for client-side tracking
      const userId = session.user.id;
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.workspaceId === workspaceId) {
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${event.id}\ndata: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`
              )
            );
          } catch {
            unsubscribe();
          }
        }
      });

      // Heartbeat every 30s + re-verify membership.
      // AbortController lets request cancellation interrupt the timer
      // immediately rather than waiting up to 30s for the next tick.
      const heartbeatAbort = new AbortController();
      let heartbeatCount = 0;

      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          if (heartbeatAbort.signal.aborted) return resolve();
          const timer = setTimeout(resolve, ms);
          heartbeatAbort.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });

      const heartbeatLoop = async () => {
        while (!heartbeatAbort.signal.aborted) {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            heartbeatCount++;
            // Re-check membership every 5 heartbeats (~2.5 min)
            if (heartbeatCount % 5 === 0) {
              const [stillMember, userStill] = await Promise.all([
                prisma.workspaceMembership.findUnique({
                  where: { userId_workspaceId: { userId, workspaceId: workspaceId! } },
                  select: { isActive: true },
                }),
                prisma.user.findUnique({
                  where: { id: userId },
                  select: { isActive: true, isSystemAdmin: true },
                }),
              ]);
              const memberOk = stillMember?.isActive || userStill?.isSystemAdmin;
              if (!memberOk || !userStill?.isActive) {
                heartbeatAbort.abort();
                break;
              }
            }
          } catch {
            heartbeatAbort.abort();
            break;
          }
          await sleep(30000);
        }
        unsubscribe();
        try { controller.close(); } catch {}
      };
      heartbeatLoop(); // fire-and-forget, cleanup via AbortController

      // Clean up on close
      request.signal.addEventListener("abort", () => {
        heartbeatAbort.abort();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
