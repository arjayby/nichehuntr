import { Button } from "@nichehuntr/ui/components/button";
import { type ComponentProps, useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

function GoogleIcon(props: ComponentProps<"svg">) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
			<path
				fill="#4285F4"
				d="M23.49 12.27c0-.85-.07-1.46-.22-2.1H12v3.98h6.6c-.13 1.1-.85 2.76-2.44 3.87l-.02.15 3.55 2.75.24.02c2.26-2.08 3.56-5.15 3.56-8.67z"
			/>
			<path
				fill="#34A853"
				d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.79-2.93c-1.01.7-2.37 1.2-4.16 1.2-3.17 0-5.86-2.09-6.82-4.98l-.14.01-3.7 2.86-.04.13C3.26 21.3 7.31 24 12 24z"
			/>
			<path
				fill="#FBBC05"
				d="M5.18 14.39A7.4 7.4 0 0 1 4.78 12c0-.83.15-1.63.39-2.39l-.01-.16-3.74-2.9-.12.06A11.97 11.97 0 0 0 0 12c0 1.93.47 3.76 1.3 5.39l3.88-3z"
			/>
			<path
				fill="#EA4335"
				d="M12 4.63c2.25 0 3.77.97 4.63 1.78l3.38-3.3C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.3 6.61l3.87 3C6.14 6.72 8.83 4.63 12 4.63z"
			/>
		</svg>
	);
}

export default function GoogleButton({ redirectTo }: { redirectTo: string }) {
	const [pending, setPending] = useState(false);

	return (
		<Button
			type="button"
			variant="outline"
			className="w-full"
			disabled={pending}
			onClick={async () => {
				setPending(true);
				const { error } = await authClient.signIn.social({
					provider: "google",
					callbackURL: redirectTo,
				});
				// On success the browser navigates away; only reset on failure.
				if (error) {
					toast.error(error.message || "Could not sign in with Google");
					setPending(false);
				}
			}}
		>
			<GoogleIcon data-icon="inline-start" />
			Google
		</Button>
	);
}
