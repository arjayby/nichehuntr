import { api } from "@nichehuntr/backend/convex/_generated/api";
import { Button } from "@nichehuntr/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@nichehuntr/ui/components/dropdown-menu";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

export default function UserMenu() {
	const user = useQuery(api.auth.getCurrentUser);
	const subscription = useQuery(api.polar.getCurrentSubscription);
	const generatePortalUrl = useAction(api.polar.generateCustomerPortalUrl);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="outline" />}>
				{user?.name}
			</DropdownMenuTrigger>
			<DropdownMenuContent className="bg-card">
				<DropdownMenuGroup>
					<DropdownMenuLabel>My Account</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuItem>{user?.email}</DropdownMenuItem>
					{subscription ? (
						<DropdownMenuItem
							onClick={async () => {
								try {
									const { url } = await generatePortalUrl({
										returnUrl: window.location.href,
									});
									window.location.href = url;
								} catch {
									toast.error("Could not open the billing portal.");
								}
							}}
						>
							Manage Subscription
						</DropdownMenuItem>
					) : null}
					<DropdownMenuItem
						variant="destructive"
						onClick={() => {
							authClient.signOut({
								fetchOptions: {
									onSuccess: () => {
										location.reload();
									},
								},
							});
						}}
					>
						Sign Out
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
