import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for use in Server Components, Server Actions, and
 * Route Handlers. Reads/writes the auth session via Next.js cookies.
 *
 * This client uses the anon key + the user's session cookie — it is
 * still subject to Row Level Security. It is NOT the service-role
 * client and must never be given elevated privileges.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method can be called from a Server Component,
            // where cookies cannot be set. This is safe to ignore if you
            // have middleware refreshing sessions (see middleware.ts).
          }
        },
      },
    }
  );
}
