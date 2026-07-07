import { createFileRoute, redirect } from "@tanstack/react-router";
import z from "zod";

import SignUpForm from "@/components/sign-up-form";
import { POST_AUTH_REDIRECT_PATH } from "@/lib/auth-routing";

// Only internal paths are honored, so a crafted link can't bounce users to
// another origin after sign-up.
const searchSchema = z.object({
	redirect: z.string().startsWith("/").optional().catch(undefined),
});

export const Route = createFileRoute("/signup")({
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
		meta: [{ title: "Sign up · nichehuntr" }],
	}),
	component: SignupPage,
});

function SignupPage() {
	const search = Route.useSearch();
	return <SignUpForm redirectTo={search.redirect} />;
}
