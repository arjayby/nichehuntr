import { Card, CardContent } from "@nichehuntr/ui/components/card";
import type { ReactNode } from "react";

import Wordmark from "@/components/wordmark";

export default function AuthShell({
	title,
	description,
	children,
	footer,
}: {
	title: string;
	description: string;
	children: ReactNode;
	footer: ReactNode;
}) {
	return (
		<div className="flex min-h-svh flex-col bg-background">
			<header className="border-b">
				<div className="flex h-14 items-center px-6">
					<Wordmark />
				</div>
			</header>
			<main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
				<div className="w-full max-w-sm">
					<div className="text-center">
						<h1 className="font-bold font-heading text-2xl tracking-tight sm:text-3xl">
							{title}
						</h1>
						<p className="mt-2 text-muted-foreground text-sm">{description}</p>
					</div>
					<Card className="mt-8">
						<CardContent>{children}</CardContent>
					</Card>
					<p className="mt-6 text-center text-muted-foreground text-sm">
						{footer}
					</p>
				</div>
			</main>
		</div>
	);
}
