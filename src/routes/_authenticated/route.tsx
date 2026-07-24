import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

// This layout is used ONLY for company admin routes (e.g. /dashboard).
// Client email owners have their own session (see /login and /mail).
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/company" });
    }
    return { user: data.user };
  },
  component: () => <Outlet />,
});
