import { convexQuery } from "@convex-dev/react-query";
import { api } from "@nichehuntr/backend/convex/_generated/api";
import {
	createFileRoute,
	Outlet,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useEffect } from "react";

/**
 * Subscription gate: everything under this layout requires an active
 * subscription on top of the sign-in required by `_auth`. New app routes
 * belong here so they are paywalled by default; only /subscribe and its
 * success page live outside, directly under `_auth`.
 */
export const Route = createFileRoute("/_auth/_subscribed")({
	beforeLoad: async ({ context }) => {
		const access = await context.queryClient.ensureQueryData(
			convexQuery(api.polar.subscriptionAccess, {}),
		);
		if (!access.hasAccess) {
			throw redirect({ to: "/subscribe" });
		}
	},
	component: SubscribedLayout,
});

function SubscribedLayout() {
	// Live gate: Convex pushes subscription changes, so a mid-session lapse
	// (Polar webhook ending the sub) bounces to /subscribe, which explains
	// the expiry. The server-side query gate cuts the data off regardless.
	const access = useQuery(api.polar.subscriptionAccess);
	const navigate = useNavigate();

	useEffect(() => {
		if (access !== undefined && !access.hasAccess) {
			navigate({ to: "/subscribe" });
		}
	}, [access, navigate]);

	return <Outlet />;
}
