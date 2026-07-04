/**
 * Subscription statuses that grant Feed access — "paid-through + dunning grace":
 *
 * - "active" covers canceled-at-period-end subs too; Polar keeps the status
 *   "active" (with cancelAtPeriodEnd) until the paid period actually ends.
 * - "past_due" keeps access while Polar retries a failed renewal (dunning).
 * - "trialing" is inert today (no trials configured) but makes a future
 *   Polar-side trial work without code changes.
 *
 * Ended subs and expired trials never reach this check: the Polar component's
 * getCurrentSubscription already returns null for them.
 *
 * Pure module (no Convex server imports) so the web app can share it.
 */
const ACCESS_GRANTING_STATUSES: readonly string[] = [
	"active",
	"trialing",
	"past_due",
];

export function hasActiveSubscription(
	subscription: { status: string } | null | undefined,
): boolean {
	return (
		subscription != null &&
		ACCESS_GRANTING_STATUSES.includes(subscription.status)
	);
}
