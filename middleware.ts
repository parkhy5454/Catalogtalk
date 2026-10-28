import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(req: NextRequest) {
  // For MVP, let client handle auth check. 
  // This middleware just passes through - auth is checked in dashboard page.tsx
  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*'],
}
