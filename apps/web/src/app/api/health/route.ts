import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Liveness only. Deliberately does not touch the database or reveal config. */
export function GET() {
  return NextResponse.json({ status: 'ok', phase: 1 });
}
