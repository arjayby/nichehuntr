import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { authComponent } from "./auth";

/**
 * Server-side admin gate, mirroring `requireActiveSubscription` (polar.ts) but
 * on a separate authorization axis: admin is a role, not a subscription
 * (ADR-0005). It therefore performs NO subscription check — an admin needs no
 * active subscription. The ConvexError codes let the client tell the two
 * failures apart, matching the paywall's UNAUTHENTICATED / SUBSCRIPTION_REQUIRED.
 */
export async function requireAdmin(ctx: QueryCtx) {
	const user = await authComponent.safeGetAuthUser(ctx);
	if (!user) {
		throw new ConvexError("UNAUTHENTICATED");
	}
	const row = await ctx.db
		.query("adminUsers")
		.withIndex("by_userId", (q) => q.eq("userId", user._id))
		.unique();
	if (!row) {
		throw new ConvexError("ADMIN_REQUIRED");
	}
	return user;
}

/**
 * Route-guard backing: whether the current caller is an admin. Never throws — an
 * unauthenticated or non-admin caller simply reads false, so the client can
 * branch without catching (unlike `requireAdmin`, which gates functions).
 */
export const isAdmin = query({
	args: {},
	handler: async (ctx): Promise<boolean> => {
		const user = await authComponent.safeGetAuthUser(ctx);
		if (!user) {
			return false;
		}
		const row = await ctx.db
			.query("adminUsers")
			.withIndex("by_userId", (q) => q.eq("userId", user._id))
			.unique();
		return row !== null;
	},
});

/**
 * Resolve a signed-up better-auth user id from an email. Grants are made by
 * email, but there is no pre-authorizing an address before signup (ADR-0005):
 * an email with no better-auth user is rejected with a clear error.
 */
async function resolveUserIdByEmail(
	ctx: MutationCtx,
	email: string,
): Promise<string> {
	// Exact match on the stored email. better-auth's email/password sign-up
	// stores the address as typed (no case normalization) and the Convex adapter
	// has no case-insensitive query, so the grant must use the exact sign-up
	// casing — acceptable for a rarely-run admin op run against a known account.
	const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: "user",
		where: [{ field: "email", operator: "eq", value: email }],
	});
	if (!user) {
		throw new ConvexError(`No signed-up user for email: ${email}`);
	}
	return user._id as string;
}

/**
 * Insert an `adminUsers` row for a resolved user id if one does not already
 * exist. Idempotent so re-granting an existing admin is a harmless no-op. Shared
 * by the admin-gated `grantAdmin` and the internal `bootstrapFirstAdmin`.
 */
async function grantAdminByEmail(
	ctx: MutationCtx,
	email: string,
): Promise<void> {
	const userId = await resolveUserIdByEmail(ctx, email);
	const existing = await ctx.db
		.query("adminUsers")
		.withIndex("by_userId", (q) => q.eq("userId", userId))
		.unique();
	if (!existing) {
		await ctx.db.insert("adminUsers", { userId });
	}
}

/** Grant admin to a signed-up email. Admin-gated (`requireAdmin`). */
export const grantAdmin = mutation({
	args: { email: v.string() },
	handler: async (ctx, { email }): Promise<null> => {
		await requireAdmin(ctx);
		await grantAdminByEmail(ctx, email);
		return null;
	},
});

/** Revoke admin from an email. Admin-gated; a no-op if the email is not an
 * admin. Resolving the email still requires a signed-up user (ADR-0005). */
export const revokeAdmin = mutation({
	args: { email: v.string() },
	handler: async (ctx, { email }): Promise<null> => {
		await requireAdmin(ctx);
		const userId = await resolveUserIdByEmail(ctx, email);
		const existing = await ctx.db
			.query("adminUsers")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.unique();
		if (existing) {
			await ctx.db.delete("adminUsers", existing._id);
		}
		return null;
	},
});

/**
 * Bootstrap the first admin. Not web-reachable (internal) — run once
 * out-of-band via `convex run admin:bootstrapFirstAdmin '{"email":"..."}'`,
 * the same escape hatch used for sandbox subscription seeding. Ungated by
 * design so an empty `adminUsers` table can be seeded, but it still requires a
 * signed-up email.
 */
export const bootstrapFirstAdmin = internalMutation({
	args: { email: v.string() },
	handler: async (ctx, { email }): Promise<null> => {
		await grantAdminByEmail(ctx, email);
		return null;
	},
});
