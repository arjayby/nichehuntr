// @ts-check
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
	// Apex domain — marketing owns the root; app lives on app.nichehuntr.com.
	// Drives canonical URLs, sitemap, and RSS absolute links.
	site: "https://nichehuntr.com",
	integrations: [react(), mdx(), sitemap()],
	vite: {
		plugins: [tailwindcss()],
	},
});
