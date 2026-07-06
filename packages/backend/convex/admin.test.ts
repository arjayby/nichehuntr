import { describe, expect, it } from "vitest";

import {
	asAdmin,
	asSubscribedOperator,
	createGatedTest,
	emailForOperator,
} from "../test/harness";
import { api, internal } from "./_generated/api";

describe("isAdmin", () => {
	it("returns true for an admin caller", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "admin-a");

		expect(await admin.query(api.admin.isAdmin, {})).toBe(true);
	});

	it("returns false for a subscribed non-admin caller", async () => {
		const t = createGatedTest();
		const operator = await asSubscribedOperator(t, "op-a");

		expect(await operator.query(api.admin.isAdmin, {})).toBe(false);
	});

	it("returns false for an unauthenticated caller", async () => {
		const t = createGatedTest();

		expect(await t.query(api.admin.isAdmin, {})).toBe(false);
	});
});

describe("grantAdmin", () => {
	it("lets an admin grant admin to a signed-up email", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "admin-b");
		const operator = await asSubscribedOperator(t, "grantee");

		// Not an admin before the grant.
		expect(await operator.query(api.admin.isAdmin, {})).toBe(false);

		await admin.mutation(api.admin.grantAdmin, {
			email: emailForOperator("grantee"),
		});

		// Now passes the admin gate on the shared dataset.
		expect(await operator.query(api.admin.isAdmin, {})).toBe(true);
	});

	it("rejects a grant for an email that has not signed up", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "admin-c");

		await expect(
			admin.mutation(api.admin.grantAdmin, {
				email: "nobody@example.com",
			}),
		).rejects.toThrow(/no signed-up user/i);
	});

	it("is idempotent — re-granting an existing admin is a no-op", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "admin-d");
		const operator = await asSubscribedOperator(t, "grantee-2");

		await admin.mutation(api.admin.grantAdmin, {
			email: emailForOperator("grantee-2"),
		});
		await admin.mutation(api.admin.grantAdmin, {
			email: emailForOperator("grantee-2"),
		});

		expect(await operator.query(api.admin.isAdmin, {})).toBe(true);
		const rows = await t.run((ctx) => ctx.db.query("adminUsers").collect());
		// One row for the seed admin, one for the single grantee.
		expect(rows).toHaveLength(2);
	});

	it("rejects a non-admin caller", async () => {
		const t = createGatedTest();
		const operator = await asSubscribedOperator(t, "op-b");
		await asSubscribedOperator(t, "victim");

		await expect(
			operator.mutation(api.admin.grantAdmin, {
				email: emailForOperator("victim"),
			}),
		).rejects.toThrow(/ADMIN_REQUIRED/);
	});

	it("rejects an unauthenticated caller", async () => {
		const t = createGatedTest();
		await asSubscribedOperator(t, "victim-2");

		await expect(
			t.mutation(api.admin.grantAdmin, {
				email: emailForOperator("victim-2"),
			}),
		).rejects.toThrow(/UNAUTHENTICATED/);
	});
});

describe("revokeAdmin", () => {
	it("lets an admin revoke another admin", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "admin-e");
		const target = await asAdmin(t, "target");

		expect(await target.query(api.admin.isAdmin, {})).toBe(true);

		await admin.mutation(api.admin.revokeAdmin, {
			email: emailForOperator("target"),
		});

		expect(await target.query(api.admin.isAdmin, {})).toBe(false);
	});

	it("is a no-op when the email is not an admin", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "admin-f");
		await asSubscribedOperator(t, "not-admin");

		await expect(
			admin.mutation(api.admin.revokeAdmin, {
				email: emailForOperator("not-admin"),
			}),
		).resolves.not.toThrow();
	});

	it("rejects a non-admin caller", async () => {
		const t = createGatedTest();
		const operator = await asSubscribedOperator(t, "op-c");
		const target = await asAdmin(t, "target-2");

		await expect(
			operator.mutation(api.admin.revokeAdmin, {
				email: emailForOperator("target-2"),
			}),
		).rejects.toThrow(/ADMIN_REQUIRED/);
		// The target is still an admin.
		expect(await target.query(api.admin.isAdmin, {})).toBe(true);
	});
});

describe("bootstrapFirstAdmin", () => {
	it("creates the first admin from an empty table via the internal mutation", async () => {
		const t = createGatedTest();
		const operator = await asSubscribedOperator(t, "first-admin");

		// No admins yet.
		expect(await operator.query(api.admin.isAdmin, {})).toBe(false);

		await t.mutation(internal.admin.bootstrapFirstAdmin, {
			email: emailForOperator("first-admin"),
		});

		expect(await operator.query(api.admin.isAdmin, {})).toBe(true);
	});

	it("rejects bootstrapping an email that has not signed up", async () => {
		const t = createGatedTest();

		await expect(
			t.mutation(internal.admin.bootstrapFirstAdmin, {
				email: "ghost@example.com",
			}),
		).rejects.toThrow(/no signed-up user/i);
	});
});
