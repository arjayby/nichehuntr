// The marketing site lives on the apex domain; the wordmark is a plain
// cross-origin link (mirrors how marketing hardcodes APP_URL).
const APEX_URL = "https://nichehuntr.com";

export default function Wordmark({ className = "" }: { className?: string }) {
	return (
		<a
			href={APEX_URL}
			className={`font-bold font-heading text-lg tracking-tight ${className}`}
		>
			niche<span className="text-primary">huntr</span>
		</a>
	);
}
