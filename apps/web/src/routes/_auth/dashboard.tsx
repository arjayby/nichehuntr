import { api } from "@100k/backend/convex/_generated/api";
import { buttonVariants } from "@100k/ui/components/button";
import { CheckoutLink, CustomerPortalLink } from "@convex-dev/polar/react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import UserMenu from "@/components/user-menu";

export const Route = createFileRoute("/_auth/dashboard")({
  component: DashboardContent,
});

function DashboardContent() {
  const privateData = useQuery(api.privateData.get);
  const products = useQuery(api.polar.listAllProducts);
  const subscription = useQuery(api.polar.getCurrentSubscription);

  const product = products?.find((product: { isRecurring?: boolean }) => product.isRecurring);
  const hasActiveSubscription = Boolean(subscription);

  return (
    <div>
      <h1>Dashboard</h1>
      <p>privateData: {privateData?.message}</p>
      <p>Plan: {hasActiveSubscription ? "Active" : "Free"}</p>
      {subscription === undefined ? (
        <p>Loading subscription options...</p>
      ) : hasActiveSubscription ? (
        <CustomerPortalLink polarApi={api.polar} className={buttonVariants({ variant: "outline" })}>
          Manage Subscription
        </CustomerPortalLink>
      ) : products === undefined ? (
        <p>Loading subscription options...</p>
      ) : product ? (
        <CheckoutLink
          polarApi={api.polar}
          productIds={[product.id]}
          embed={false}
          className={buttonVariants({ variant: "default" })}
        >
          Upgrade
        </CheckoutLink>
      ) : (
        <p>No recurring plans available.</p>
      )}
      <UserMenu />
    </div>
  );
}
