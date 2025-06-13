import { AccessToken } from 'livekit-server-sdk';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const roomName = searchParams.get('roomName');
  const identity = searchParams.get('identity');

  if (!roomName || !identity) {
    return NextResponse.json(
      { error: 'Missing roomName or identity' },
      { status: 400 }
    );
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  // --- DEBUGGING STEP ---
  // Log the API Key the server is seeing. We will check this in the Vercel logs.
  console.log(`Vercel server is using API Key: ${apiKey}`);
  // --------------------

  if (!apiKey || !apiSecret || !wsUrl) {
    console.error("Server configuration error: One or more environment variables are missing.");
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  const at = new AccessToken(apiKey, apiSecret, { identity });

  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  return NextResponse.json({ token: at.toJwt() });
}
