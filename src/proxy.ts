import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { DEFAULT_SIGNED_IN_PATH, sanitizeNextPath } from '@/lib/auth/next-path'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // The inbox moved from `/inbox?c=<id>` to `/inbox/<id>` (P0-BUG-04),
  // so the open conversation is a location rather than component state
  // and the browser's Back button behaves. Old links are still out
  // there — pasted into chats, bookmarked, sitting in an open tab's
  // recent-conversations list — so they keep working.
  //
  // Done here rather than with `redirects()` in next.config because
  // that helper appends any query param it did not consume to the
  // destination, producing `/inbox/<id>?c=<id>`: the right page with a
  // redundant parameter stuck in the address bar. Building the URL by
  // hand drops it, and makes the rule unit-testable.
  if (request.nextUrl.pathname === '/inbox') {
    const legacyId = request.nextUrl.searchParams.get('c')
    if (legacyId) {
      const url = request.nextUrl.clone()
      url.pathname = `/inbox/${encodeURIComponent(legacyId)}`
      url.search = ''
      // 308, not 307: the move is permanent and the method must survive.
      return withRefreshedCookies(NextResponse.redirect(url, 308))
    }
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      // Honour `?next=` before falling back to the dashboard.
      //
      // This branch is the second half of the reported bug. When a
      // transient auth blip sent the shell to /login, the session
      // cookie was often still valid — so this rule fired, wiped the
      // query string, and deposited the user on /dashboard. From the
      // outside that looks exactly like "the app threw me back to the
      // start", with no sign that a sign-out was ever involved.
      //
      // sanitizeNextPath rejects anything that is not a path-absolute
      // in-app destination, so this cannot be turned into an open
      // redirect by anyone who can get a user to click a /login link.
      const next = sanitizeNextPath(request.nextUrl.searchParams.get('next'))
      if (next) {
        const target = new URL(next, request.nextUrl.origin)
        url.pathname = target.pathname
        url.search = target.search
        url.hash = target.hash
      } else {
        url.pathname = DEFAULT_SIGNED_IN_PATH
        url.search = ''
      }
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    // Remember the destination so signing in returns them to it. The
    // previous version only replaced the pathname, which left the
    // original query string dangling on /login (a request for
    // /inbox?c=<id> became /login?c=<id>) — meaningless to the login
    // page, and the conversation was lost either way.
    const next = sanitizeNextPath(
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    )
    url.search = next ? `?next=${encodeURIComponent(next)}` : ''
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
