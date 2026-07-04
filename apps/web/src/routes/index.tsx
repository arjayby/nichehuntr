import { createFileRoute, redirect } from "@tanstack/react-router";

// The feed is the app; marketing is the public front door. Logged-out users
// bounce on through the _auth guard to /login, unsubscribed to /subscribe.
export const Route = createFileRoute("/")({
	beforeLoad: () => {
		throw redirect({ to: "/feed" });
	},
});
