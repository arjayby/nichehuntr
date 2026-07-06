import { convexQuery } from "@convex-dev/react-query";
import { api } from "@nichehuntr/backend/convex/_generated/api";
import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Admin surface: authenticated but NOT paywalled. It lives directly under
 * `_auth` (outside `_subscribed`) because curating the Feed is an operational
 * action on a separate authorization axis from being a paying Operator — an
 * admin needs no active subscription (ADR-0005).
 */
export const Route = createFileRoute("/_auth/admin")({
	beforeLoad: async ({ context }) => {
		// `isAdmin` never throws: an unauthenticated caller reads false, but they
		// never get here — the parent `_auth` guard has already bounced them to
		// sign-in. So a false here means a signed-in non-admin; send them home.
		const isAdmin = await context.queryClient.ensureQueryData(
			convexQuery(api.admin.isAdmin, {}),
		);
		if (!isAdmin) {
			throw redirect({ to: "/" });
		}
	},
	head: () => ({
		meta: [{ title: "Admin · nichehuntr" }],
	}),
	component: AdminPage,
});

function AdminPage() {
	return (
		<main className="min-w-0 flex-1 overflow-y-auto">
			<div className="container mx-auto max-w-6xl px-4 py-6">
				<div className="mb-6">
					<h1 className="font-bold text-2xl">Admin</h1>
					<p className="text-muted-foreground text-sm">
						Submit channels into the Feed. The paste box and Submissions table
						arrive in the next slice.
					</p>
				</div>
			</div>
		</main>
	);
}
