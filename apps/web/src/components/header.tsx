import { Link } from "@tanstack/react-router";

import UserMenu from "@/components/user-menu";

export default function Header() {
	return (
		<div>
			<div className="flex flex-row items-center justify-between px-2 py-1">
				<Link to="/feed" className="font-bold text-lg tracking-tight">
					niche<span className="text-primary">huntr</span>
				</Link>
				<div className="flex items-center gap-2">
					<UserMenu />
				</div>
			</div>
			<hr />
		</div>
	);
}
