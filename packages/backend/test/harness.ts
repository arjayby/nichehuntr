/// <reference types="vite/client" />
/**
 * convex-test harness for functions behind the auth/subscription gate.
 *
 * `requireActiveSubscription` (convex/polar.ts) resolves the Operator through
 * the better-auth component (session → user) and then asks the Polar component
 * for a live subscription. Under convex-test neither component exists unless
 * registered, so every gated function throws "Component ... is not registered".
 * This harness registers both components from their published component builds
 * and seeds the minimal rows a signed-in, subscribed Operator needs.
 */
import { convexTest, type TestConvex } from "convex-test";
import { components } from "../convex/_generated/api";
import schema from "../convex/schema";
import betterAuthSchema from "../node_modules/@convex-dev/better-auth/dist/component/schema.js";
import polarSchema from "../node_modules/@convex-dev/polar/dist/component/schema.js";

const betterAuthModules = import.meta.glob(
	"../node_modules/@convex-dev/better-auth/dist/component/**/*.js",
);
const polarModules = import.meta.glob(
	"../node_modules/@convex-dev/polar/dist/component/**/*.js",
);

const appModules = import.meta.glob("../convex/**/*.ts");

type AppTest = TestConvex<typeof schema>;

/** The identity-scoped accessor `asSubscribedOperator` returns. */
export type Operator = Awaited<ReturnType<typeof asSubscribedOperator>>;

/** The email `seedAuthUser` derives from a name. Grant/revoke-by-email tests
 * resolve a signed-up user by this address. */
export function emailForOperator(name: string): string {
	return `${name}@example.com`;
}

/** Register the auth-gate components. Call once right after `convexTest()`. */
export function registerAuthComponents(t: AppTest): void {
	t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
	t.registerComponent("polar", polarSchema, polarModules);
}

/** An app test instance with the auth-gate components registered but nobody
 * signed in — for exercising the unauthenticated paths of gated functions. */
export function createGatedTest(): AppTest {
	const t = convexTest(schema, appModules);
	registerAuthComponents(t);
	return t;
}

/** The standard setup for testing gated functions: an app instance plus a
 * subscribed Operator whose calls pass `requireActiveSubscription`. */
export async function setup(): Promise<{ t: AppTest; operator: Operator }> {
	const t = createGatedTest();
	const operator = await asSubscribedOperator(t);
	return { t, operator };
}

/** Seed a better-auth user + unexpired session and return the identity that
 * `safeGetAuthUser` resolves: subject = user id, sessionId = session id. */
async function seedAuthUser(t: AppTest, name: string) {
	const now = Date.now();
	const user = await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: "user",
			data: {
				name,
				email: emailForOperator(name),
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		},
	});
	const session = await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: "session",
			data: {
				userId: user._id,
				token: `token_${name}`,
				// A year out so fake-timer tests that advance days stay signed in.
				expiresAt: now + 365 * 24 * 60 * 60 * 1000,
				createdAt: now,
				updatedAt: now,
			},
		},
	});
	return { userId: user._id as string, sessionId: session._id as string };
}

/** Seed a Polar customer + active subscription (and its product) for a user. */
async function seedActiveSubscription(t: AppTest, userId: string) {
	const nowIso = new Date().toISOString();
	const productId = `prod_${userId}`;
	await t.mutation(components.polar.lib.createProduct, {
		product: {
			id: productId,
			createdAt: nowIso,
			modifiedAt: null,
			name: "Hunter",
			description: null,
			recurringInterval: "month",
			isRecurring: true,
			isArchived: false,
			organizationId: "org_test",
			prices: [],
			medias: [],
		},
	});
	await t.mutation(components.polar.lib.insertCustomer, {
		id: `cus_${userId}`,
		userId,
	});
	await t.mutation(components.polar.lib.createSubscription, {
		subscription: {
			id: `sub_${userId}`,
			customerId: `cus_${userId}`,
			createdAt: nowIso,
			modifiedAt: null,
			amount: 2000,
			currency: "usd",
			recurringInterval: "month",
			status: "active",
			currentPeriodStart: nowIso,
			currentPeriodEnd: null,
			cancelAtPeriodEnd: false,
			startedAt: nowIso,
			endedAt: null,
			productId,
			checkoutId: null,
			metadata: {},
		},
	});
}

/** Uniquifies default operator names — better-auth enforces unique emails. */
let operatorSeq = 0;

/**
 * A signed-in Operator with an active subscription: seeds auth + Polar rows
 * and returns a test accessor whose calls pass `requireActiveSubscription`.
 * Each call yields a distinct Operator; pass a `name` for readable fixtures.
 */
export async function asSubscribedOperator(t: AppTest, name?: string) {
	const { userId, sessionId } = await seedAuthUser(
		t,
		name ?? `operator-${++operatorSeq}`,
	);
	await seedActiveSubscription(t, userId);
	return t.withIdentity({ subject: userId, sessionId });
}

/**
 * A signed-in Admin: seeds an auth user plus an `adminUsers` row and returns a
 * test accessor whose calls pass `requireAdmin` (convex/admin.ts). Deliberately
 * seeds NO subscription — admin is a separate axis (ADR-0005), so this identity
 * doubles as proof that admin functions never require an active subscription.
 * Each call yields a distinct Admin; pass a `name` for readable fixtures.
 */
export async function asAdmin(t: AppTest, name?: string) {
	const { userId, sessionId } = await seedAuthUser(
		t,
		name ?? `admin-${++operatorSeq}`,
	);
	await t.run(async (ctx) => {
		await ctx.db.insert("adminUsers", { userId });
	});
	return t.withIdentity({ subject: userId, sessionId });
}
