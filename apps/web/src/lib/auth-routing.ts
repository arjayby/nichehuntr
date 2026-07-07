export const POST_AUTH_REDIRECT_PATH = "/redirect";

function pathnameFor(path: string | undefined) {
	if (!path?.startsWith("/") || path.startsWith("//")) {
		return undefined;
	}

	try {
		return new URL(path, "https://app.local").pathname;
	} catch {
		return undefined;
	}
}

function isSubscribePath(pathname: string | undefined) {
	return pathname === "/subscribe" || pathname === "/subscribe/success";
}

function isAuthFlowPath(pathname: string | undefined) {
	return (
		pathname === undefined ||
		pathname === "/" ||
		pathname === "/login" ||
		pathname === "/signup" ||
		pathname === POST_AUTH_REDIRECT_PATH
	);
}

export function postAuthRedirectUrl(redirectTo?: string) {
	const params = new URLSearchParams();
	if (redirectTo) {
		params.set("redirect", redirectTo);
	}

	const query = params.toString();
	return query
		? `${POST_AUTH_REDIRECT_PATH}?${query}`
		: POST_AUTH_REDIRECT_PATH;
}

export function postAuthDestination({
	hasAccess,
	isAdmin,
	redirectTo,
}: {
	hasAccess: boolean;
	isAdmin: boolean;
	redirectTo?: string;
}) {
	const redirectPathname = pathnameFor(redirectTo);

	if (isAdmin) {
		return "/admin";
	}

	if (!hasAccess) {
		return "/subscribe";
	}

	if (
		!isAuthFlowPath(redirectPathname) &&
		!isSubscribePath(redirectPathname) &&
		redirectPathname !== "/admin"
	) {
		return redirectPathname;
	}

	return "/feed";
}
