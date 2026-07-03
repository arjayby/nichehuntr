import { useEffect, useRef } from "react";

/**
 * Animated particle-network background for the landing hero.
 *
 * This is the one genuinely interactive/heavy region of the marketing site, so
 * it lives in a React *island* mounted with `client:visible` — the animation JS
 * only ships and runs for this component, while every other page stays zero-JS.
 *
 * Self-contained canvas (no three.js/tsParticles dependency) to keep the island
 * bundle tiny. Honors prefers-reduced-motion by rendering a single static frame.
 */

interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
}

const LIME = "154, 230, 0"; // matches --primary; used with varying alpha

export default function ParticleHero() {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		let width = 0;
		let height = 0;
		let dpr = 1;
		let particles: Particle[] = [];
		let raf = 0;

		const seed = () => {
			// Density scales with area, capped so large screens stay performant.
			const count = Math.min(90, Math.floor((width * height) / 16000));
			particles = Array.from({ length: count }, () => ({
				x: Math.random() * width,
				y: Math.random() * height,
				vx: (Math.random() - 0.5) * 0.35,
				vy: (Math.random() - 0.5) * 0.35,
			}));
		};

		const resize = () => {
			dpr = Math.min(window.devicePixelRatio || 1, 2);
			width = canvas.clientWidth;
			height = canvas.clientHeight;
			canvas.width = width * dpr;
			canvas.height = height * dpr;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			seed();
		};

		const draw = () => {
			ctx.clearRect(0, 0, width, height);

			for (const p of particles) {
				p.x += p.vx;
				p.y += p.vy;
				if (p.x < 0 || p.x > width) p.vx *= -1;
				if (p.y < 0 || p.y > height) p.vy *= -1;
			}

			// Connect nearby particles — the "network" effect.
			for (let i = 0; i < particles.length; i++) {
				const a = particles[i];
				if (!a) continue;
				for (let j = i + 1; j < particles.length; j++) {
					const b = particles[j];
					if (!b) continue;
					const dx = a.x - b.x;
					const dy = a.y - b.y;
					const dist = Math.hypot(dx, dy);
					if (dist < 130) {
						ctx.strokeStyle = `rgba(${LIME}, ${(1 - dist / 130) * 0.25})`;
						ctx.lineWidth = 1;
						ctx.beginPath();
						ctx.moveTo(a.x, a.y);
						ctx.lineTo(b.x, b.y);
						ctx.stroke();
					}
				}
			}

			for (const p of particles) {
				ctx.fillStyle = `rgba(${LIME}, 0.8)`;
				ctx.beginPath();
				ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
				ctx.fill();
			}

			if (!reduceMotion) raf = requestAnimationFrame(draw);
		};

		resize();
		draw(); // one frame if reduced-motion, otherwise starts the loop
		window.addEventListener("resize", resize);

		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", resize);
		};
	}, []);

	return (
		// biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative canvas, non-interactive (pointer-events-none) and not in the tab order; hiding it from assistive tech is correct.
		<canvas
			ref={canvasRef}
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 h-full w-full"
		/>
	);
}
