import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function sendUnauthorized(res: ServerResponse) {
  sendJson(res, 401, { error: "UNAUTHORIZED" });
}

export function isAuthorized(req: IncomingMessage, secret: string) {
  if (!secret) return false;
  const auth = req.headers.authorization || "";
  const expected = `Bearer ${secret}`;
  if (auth.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
}
