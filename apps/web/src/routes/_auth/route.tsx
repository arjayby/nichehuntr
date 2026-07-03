import {
	createFileRoute,
	Navigate,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";

import Loader from "@/components/loader";

export const Route = createFileRoute("/_auth")({
	beforeLoad: ({ context, location }) => {
		if (!context.isAuthenticated) {
			throw redirect({ to: "/login", search: { redirect: location.href } });
		}
	},
	component: AuthLayout,
});

function AuthLayout() {
	return (
		<>
			<Authenticated>
				<Outlet />
			</Authenticated>
			{/* Client-side token expiry after the server check passed. */}
			<Unauthenticated>
				<Navigate to="/login" />
			</Unauthenticated>
			<AuthLoading>
				<Loader />
			</AuthLoading>
		</>
	);
}
