import { createFileRoute, redirect } from "@tanstack/react-router";

import { POST_AUTH_REDIRECT_PATH } from "@/lib/auth-routing";

// The redirect route decides whether the signed-in user belongs in admin,
// feed, or subscribe. Logged-out users bounce through the _auth guard to login.
export const Route = createFileRoute("/")({
	beforeLoad: () => {
		throw redirect({ to: POST_AUTH_REDIRECT_PATH });
	},
});
