import { Polar } from "@convex-dev/polar";
import { ConvexError } from "convex/values";

import { api, components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import {
	action,
	internalAction,
	type QueryCtx,
	query,
} from "./_generated/server";
import { authComponent } from "./auth";
import { hasActiveSubscription } from "./model/subscription";

type CurrentSubscription = Awaited<
	ReturnType<Polar<DataModel>["getCurrentSubscription"]>
>;

export const polar: Polar<DataModel> = new Polar<DataModel>(components.polar, {
	getUserInfo: async (ctx) => {
		const user = await ctx.runQuery(api.auth.getCurrentUser);

		if (!user) {
			throw new Error("Not authenticated");
		}

		if (!user.email) {
			throw new Error("Authenticated user is missing an email address");
		}

		return {
			userId: user._id,
			email: user.email,
		};
	},
});

export const {
	changeCurrentSubscription,
	cancelCurrentSubscription,
	getConfiguredProducts,
	listAllProducts,
	listAllSubscriptions,
	generateCheckoutLink,
	generateCustomerPortalUrl,
} = polar.api();

/**
 * Server-side paywall for gated queries: throws unless the caller is signed in
 * AND has an access-granting subscription (see model/subscription.ts). The
 * ConvexError codes let the client tell the two failures apart.
 */
export async function requireActiveSubscription(ctx: QueryCtx) {
	const user = await authComponent.safeGetAuthUser(ctx);
	if (!user) {
		throw new ConvexError("UNAUTHENTICATED");
	}

	const subscription = await polar.getCurrentSubscription(ctx, {
		userId: user._id,
	});
	if (!hasActiveSubscription(subscription)) {
		throw new ConvexError("SUBSCRIPTION_REQUIRED");
	}

	return user;
}

/**
 * Gate state for the router: hasAccess drives the subscription guard, and
 * hasExpired lets /subscribe tell lapsed subscribers apart from new ones
 * (getCurrentSubscription alone can't — ended subs return null).
 */
export const subscriptionAccess = query({
	args: {},
	handler: async (
		ctx,
	): Promise<{ hasAccess: boolean; hasExpired: boolean }> => {
		const user = await authComponent.safeGetAuthUser(ctx);
		if (!user) {
			return { hasAccess: false, hasExpired: false };
		}

		const subscription = await polar.getCurrentSubscription(ctx, {
			userId: user._id,
		});
		if (hasActiveSubscription(subscription)) {
			return { hasAccess: true, hasExpired: false };
		}

		const pastSubscriptions = await polar.listAllUserSubscriptions(ctx, {
			userId: user._id,
		});
		return { hasAccess: false, hasExpired: pastSubscriptions.length > 0 };
	},
});

export const getCurrentSubscription = query({
	args: {},
	handler: async (ctx): Promise<CurrentSubscription | null> => {
		const user = await ctx.runQuery(api.auth.getCurrentUser);

		if (!user) {
			return null;
		}

		return await polar.getCurrentSubscription(ctx, {
			userId: user._id,
		});
	},
});

export const syncProducts = action({
	args: {},
	handler: async (ctx): Promise<void> => {
		const user = await ctx.runQuery(api.auth.getCurrentUser);

		if (!user) {
			throw new Error("Not authenticated");
		}

		await polar.syncProducts(ctx);
	},
});

/** CLI/ops product sync (`npx convex run polar:syncProductsInternal`) — pulls
 * products created in the Polar dashboard before the webhook existed. */
export const syncProductsInternal = internalAction({
	args: {},
	handler: async (ctx): Promise<void> => {
		await polar.syncProducts(ctx);
	},
});
