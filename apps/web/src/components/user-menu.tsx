import { api } from "@nichehuntr/backend/convex/_generated/api";
import { Avatar, AvatarFallback } from "@nichehuntr/ui/components/avatar";
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
import { Skeleton } from "@nichehuntr/ui/components/skeleton";
import { useAction, useQuery } from "convex/react";
import { ChevronsUpDownIcon, CreditCardIcon, LogOutIcon } from "lucide-react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

function UserInfo({ name, email }: { name?: string; email?: string }) {
	const initials =
		name
			?.split(" ")
			.map((part) => part[0])
			.slice(0, 2)
			.join("")
			.toUpperCase() || "?";
	return (
		<>
			<Avatar className="rounded-lg after:rounded-lg">
				<AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
			</Avatar>
			<div className="grid max-w-32 text-left leading-tight sm:max-w-48">
				<span className="truncate font-medium text-sm">{name}</span>
				<span className="truncate text-muted-foreground text-xs">{email}</span>
			</div>
		</>
	);
}

export default function UserMenu() {
	const user = useQuery(api.auth.getCurrentUser);
	const subscription = useQuery(api.polar.getCurrentSubscription);
	const generatePortalUrl = useAction(api.polar.generateCustomerPortalUrl);

	if (user === undefined) {
		return <Skeleton className="h-11 w-48" />;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button variant="ghost" className="h-auto px-2 py-1.5" />}
			>
				<UserInfo name={user?.name} email={user?.email} />
				<ChevronsUpDownIcon className="ml-1 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-56 bg-card">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="p-0 font-normal">
						<div className="flex items-center gap-2 px-1 py-1.5">
							<UserInfo name={user?.name} email={user?.email} />
						</div>
					</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				{subscription ? (
					<>
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
							<CreditCardIcon />
							Manage Subscription
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
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
					<LogOutIcon />
					Log out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
