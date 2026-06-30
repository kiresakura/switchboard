import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth/middleware";

// POST /api/push/subscribe — save push subscription
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: "endpoint 與 keys 為必填" }, { status: 400 });
  }

  // Remove any existing subscription for this endpoint from OTHER users
  // to prevent push notification leakage when users share a browser
  await prisma.pushSubscription.deleteMany({
    where: { endpoint, userId: { not: auth.userId } },
  });

  // Upsert: update if endpoint already exists for this user, create otherwise
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: {
      userId: auth.userId,
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
    create: {
      userId: auth.userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
  });

  return NextResponse.json({ subscribed: true });
}

// DELETE /api/push/subscribe — remove push subscription
export async function DELETE(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  let body: { endpoint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "無效的請求內容" }, { status: 400 });
  }

  if (!body.endpoint) {
    return NextResponse.json({ error: "endpoint 為必填" }, { status: 400 });
  }

  await prisma.pushSubscription.deleteMany({
    where: { endpoint: body.endpoint, userId: auth.userId },
  });

  return NextResponse.json({ unsubscribed: true });
}
