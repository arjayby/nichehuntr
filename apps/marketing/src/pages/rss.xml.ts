import { getCollection } from "astro:content";
import rss from "@astrojs/rss";
import type { APIContext } from "astro";

export async function GET(context: APIContext) {
	const posts = await getCollection("blog", ({ data }) => !data.draft);
	posts.sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime());

	return rss({
		title: "NicheHuntr Blog",
		description:
			"Notes from the hunt: proof, momentum, and saturation for YouTube creators who clone what works.",
		// context.site comes from `site` in astro.config.mjs (https://nichehuntr.com).
		site: context.site ?? "https://nichehuntr.com",
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			link: `/blog/${post.id}/`,
		})),
	});
}
