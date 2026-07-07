import { convexQuery } from "@convex-dev/react-query";
import { api } from "@nichehuntr/backend/convex/_generated/api";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useEffect } from "react";

import Loader from "@/components/loader";

/**
 * Post-checkout landing. Polar redirects here before the webhook has told
 * Convex about the new subscription, so going straight to /feed would bounce
 * back to /subscribe. Instead we watch the (reactive) access query and forward
 * the moment the webhook lands.
 */
export const Route = createFileRoute("/_auth/subscribe/success")({
	beforeLoad: async ({ context }) => {
		const isAdmin = await context.queryClient.ensureQueryData(
			convexQuery(api.admin.isAdmin, {}),
		);
		if (isAdmin) {
			throw redirect({ to: "/admin" });
		}
	},
	head: () => ({
		meta: [{ title: "Activating subscription · nichehuntr" }],
	}),
	component: SubscribeSuccessPage,
});

function SubscribeSuccessPage() {
	const isAdmin = useQuery(api.admin.isAdmin);
	const access = useQuery(api.polar.subscriptionAccess);
	const navigate = useNavigate();

	useEffect(() => {
		if (isAdmin === true) {
			navigate({ to: "/admin", replace: true });
		}
	}, [isAdmin, navigate]);

	useEffect(() => {
		if (isAdmin === false && access?.hasAccess) {
			navigate({ to: "/feed", replace: true });
		}
	}, [access, isAdmin, navigate]);

	return (
		<div className="container mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
			<h1 className="font-bold text-2xl">Payment received</h1>
			<p className="text-muted-foreground text-sm">
				Activating your subscription… this usually takes a few seconds. You will
				be taken to the feed automatically.
			</p>
			<Loader />
		</div>
	);
}
