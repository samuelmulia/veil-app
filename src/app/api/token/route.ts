import { AccessToken } from 'livekit-server-sdk';
import { NextRequest, NextResponse } from 'next/server';

// ===================================================================
// DANGER: THIS IS FOR TEMPORARY DEBUGGING ONLY.
// We are hardcoding keys to test if Vercel's environment variables
// are the source of the problem.
// ===================================================================

const HARDCODED_API_KEY = "APIv6Egd9VdxPkE";
const HARDCODED_API_SECRET = "Qlfu8AB5XhJSfwwip0Yn6SV0zDRDZcql5w9fL9DtwViB";

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

  // We are using the hardcoded keys instead of process.env
  const apiKey = HARDCODED_API_KEY;
  const apiSecret = HARDCODED_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error("Hardcoded keys are missing!");
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  const at = new AccessToken(apiKey, apiSecret, { identity });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  return NextResponse.json({ token: at.toJwt() });
}
