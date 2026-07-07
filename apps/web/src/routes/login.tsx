import { createFileRoute, redirect } from "@tanstack/react-router";
import z from "zod";

import SignInForm from "@/components/sign-in-form";
import { POST_AUTH_REDIRECT_PATH } from "@/lib/auth-routing";

// Only internal paths are honored, so a crafted link can't bounce users to
// another origin after login.
const searchSchema = z.object({
	redirect: z.string().startsWith("/").optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
	validateSearch: searchSchema,
	beforeLoad: ({ context, search }) => {
		if (context.isAuthenticated) {
			throw redirect({
				to: POST_AUTH_REDIRECT_PATH,
				search: search.redirect ? { redirect: search.redirect } : {},
			});
		}
	},
	head: () => ({
		meta: [{ title: "Log in · nichehuntr" }],
	}),
	component: LoginPage,
});

function LoginPage() {
	const search = Route.useSearch();
	return <SignInForm redirectTo={search.redirect} />;
}
