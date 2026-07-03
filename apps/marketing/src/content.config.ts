import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * Blog content collection.
 *
 * Posts are MDX/Markdown files in src/content/blog — versioned in git, authored
 * by devs (the decision from the design review). The schema is validated at
 * build time, so a malformed frontmatter fails the build rather than shipping.
 */
const blog = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		/** Draft posts are excluded from listings, RSS, and the sitemap. */
		draft: z.boolean().default(false),
		tags: z.array(z.string()).default([]),
	}),
});

export const collections = { blog };
