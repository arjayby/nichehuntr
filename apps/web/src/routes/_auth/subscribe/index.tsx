import { convexQuery } from "@convex-dev/react-query";
import { api } from "@nichehuntr/backend/convex/_generated/api";
import { Button } from "@nichehuntr/ui/components/button";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import Loader from "@/components/loader";

type Interval = "month" | "year";

export const Route = createFileRoute("/_auth/subscribe/")({
	beforeLoad: async ({ context }) => {
		const isAdmin = await context.queryClient.ensureQueryData(
			convexQuery(api.admin.isAdmin, {}),
		);
		if (isAdmin) {
			throw redirect({ to: "/admin" });
		}

		const access = await context.queryClient.ensureQueryData(
			convexQuery(api.polar.subscriptionAccess, {}),
		);
		if (access.hasAccess) {
			throw redirect({ to: "/feed" });
		}
	},
	head: () => ({
		meta: [{ title: "Subscribe · nichehuntr" }],
	}),
	component: SubscribePage,
});

type Product = FunctionReturnType<typeof api.polar.listAllProducts>[number];

function recurringPrice(product: Product) {
	return product.prices.find((price) => typeof price.priceAmount === "number");
}

function productForInterval(
	products: Product[] | undefined,
	interval: Interval,
) {
	return products?.find(
		(product) =>
			product.isRecurring &&
			!product.isArchived &&
			product.recurringInterval === interval,
	);
}

function SubscribePage() {
	const isAdmin = useQuery(api.admin.isAdmin);
	const navigate = useNavigate();
	const products = useQuery(api.polar.listAllProducts);
	const access = useQuery(api.polar.subscriptionAccess);
	const generateCheckoutLink = useAction(api.polar.generateCheckoutLink);
	const [interval, setInterval] = useState<Interval>("month");
	const [redirecting, setRedirecting] = useState(false);

	useEffect(() => {
		if (isAdmin === true) {
			navigate({ to: "/admin" });
		}
	}, [isAdmin, navigate]);

	const monthly = productForInterval(products, "month");
	const yearly = productForInterval(products, "year");
	const selected = interval === "month" ? monthly : yearly;

	const monthlyAmount = monthly
		? recurringPrice(monthly)?.priceAmount
		: undefined;
	const yearlyAmount = yearly ? recurringPrice(yearly)?.priceAmount : undefined;
	const savingsPct =
		monthlyAmount && yearlyAmount
			? Math.round((1 - yearlyAmount / (monthlyAmount * 12)) * 100)
			: null;

	async function startCheckout(productId: string) {
		setRedirecting(true);
		try {
			const { url } = await generateCheckoutLink({
				productIds: [productId],
				origin: window.location.origin,
				successUrl: `${window.location.origin}/subscribe/success`,
			});
			window.location.href = url;
		} catch {
			setRedirecting(false);
			toast.error("Could not start checkout. Please try again.");
		}
	}

	return (
		<div className="container mx-auto flex max-w-md flex-col gap-6 px-4 py-12">
			{access?.hasExpired ? (
				<div className="rounded-lg border border-destructive/50 p-4 text-destructive text-sm">
					Your subscription has expired. Pick a plan to get back to the feed.
				</div>
			) : null}

			<div>
				<h1 className="font-bold text-2xl">Subscribe</h1>
				<p className="text-muted-foreground text-sm">
					One plan. Full access to the feed.
				</p>
			</div>

			{products === undefined ? (
				<Loader />
			) : !monthly && !yearly ? (
				<p className="text-muted-foreground text-sm">
					Plans are unavailable right now. Please try again shortly.
				</p>
			) : (
				<div className="flex flex-col gap-4">
					<div className="inline-flex gap-1 self-start rounded-2xl border border-border p-1">
						<Button
							variant={interval === "month" ? "default" : "ghost"}
							size="sm"
							onClick={() => setInterval("month")}
						>
							Monthly
						</Button>
						<Button
							variant={interval === "year" ? "default" : "ghost"}
							size="sm"
							onClick={() => setInterval("year")}
						>
							{savingsPct ? `Annual · save ${savingsPct}%` : "Annual"}
						</Button>
					</div>

					{selected ? (
						<div className="flex flex-col gap-4 rounded-lg border p-6">
							<div>
								<h2 className="font-medium">{selected.name}</h2>
								{selected.description ? (
									<p className="text-muted-foreground text-sm">
										{selected.description}
									</p>
								) : null}
							</div>
							<div className="flex items-baseline gap-2">
								<span className="font-bold text-4xl tabular-nums">
									<PerMonth product={selected} interval={interval} />
								</span>
								<span className="text-muted-foreground text-sm">per month</span>
							</div>
							<p className="text-muted-foreground text-xs">
								{interval === "month"
									? "Billed monthly. Cancel anytime."
									: yearlyAmount
										? `Billed annually ($${(yearlyAmount / 100).toFixed(0)}/year). Cancel anytime.`
										: "Billed annually. Cancel anytime."}
							</p>
							<Button
								disabled={redirecting}
								onClick={() => startCheckout(selected.id)}
							>
								{redirecting ? "Redirecting to checkout…" : "Subscribe"}
							</Button>
						</div>
					) : (
						<p className="text-muted-foreground text-sm">
							The {interval === "month" ? "monthly" : "annual"} plan is
							unavailable right now.
						</p>
					)}
				</div>
			)}
		</div>
	);
}

function PerMonth({
	product,
	interval,
}: {
	product: Product;
	interval: Interval;
}) {
	const amount = recurringPrice(product)?.priceAmount;
	if (amount === undefined) {
		return null;
	}
	const perMonth = interval === "year" ? amount / 12 : amount;
	return <>${(perMonth / 100).toFixed(0)}</>;
}
