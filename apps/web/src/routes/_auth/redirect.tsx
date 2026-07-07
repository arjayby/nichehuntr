import { convexQuery } from "@convex-dev/react-query";
import { api } from "@nichehuntr/backend/convex/_generated/api";
import { createFileRoute, redirect } from "@tanstack/react-router";
import z from "zod";

import Loader from "@/components/loader";
import { postAuthDestination } from "@/lib/auth-routing";

const searchSchema = z.object({
	redirect: z.string().startsWith("/").optional().catch(undefined),
});

export const Route = createFileRoute("/_auth/redirect")({
	validateSearch: searchSchema,
	beforeLoad: async ({ context, search }) => {
		const [isAdmin, access] = await Promise.all([
			context.queryClient.ensureQueryData(convexQuery(api.admin.isAdmin, {})),
			context.queryClient.ensureQueryData(
				convexQuery(api.polar.subscriptionAccess, {}),
			),
		]);

		throw redirect({
			to: postAuthDestination({
				isAdmin,
				hasAccess: access.hasAccess,
				redirectTo: search.redirect,
			}),
		});
	},
	head: () => ({
		meta: [{ title: "Redirecting · nichehuntr" }],
	}),
	component: Loader,
});
