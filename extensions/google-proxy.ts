import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Route only the Google provider through an HTTP proxy.
 *
 * Why an extension and not a preload: Pi's `configureHttpDispatcher()` replaces
 * `globalThis.fetch` with undici's at startup and on every settings rebind, but it
 * only does so while `globalThis.fetch` is still the function it installed itself
 * (see `dist/core/http-dispatcher.js`). An extension runs after that first install,
 * so the replacement below survives later rebinds without any interception trick.
 *
 * The Google provider (`@google/genai`) issues requests through the bare global
 * `fetch` and refuses any other fetch function, so wrapping `fetch` is the only hook
 * that can scope a proxy to the `google` provider alone.
 */

const DEFAULT_HOSTS = [
	"generativelanguage.googleapis.com",
	"aiplatform.googleapis.com",
	"oauth2.googleapis.com",
	"accounts.google.com",
];

const CELLAR_FALLBACKS = [
	"/opt/homebrew/Cellar/pi-coding-agent",
	"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
	"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
];

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;
type ProxyState = { inner: FetchLike; wrapper: FetchLike; agent?: unknown };

// Kept on globalThis so an extension reload updates the state instead of stacking wrappers.
const STATE_KEY = Symbol.for("pi-google-proxy.state");

function findUndici(start: string | undefined): string {
	if (process.env.PI_UNDICI_PATH && existsSync(process.env.PI_UNDICI_PATH)) {
		return process.env.PI_UNDICI_PATH;
	}

	let dir = start ? dirname(start) : process.cwd();
	for (let i = 0; i < 16; i++) {
		for (const rel of [
			"node_modules/undici/package.json",
			"lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json",
			"node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json",
			"libexec/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json",
		]) {
			const candidate = join(dir, rel);
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	for (const base of CELLAR_FALLBACKS) {
		if (!existsSync(base)) continue;
		const roots = [base];
		try {
			for (const child of readdirSync(base)) roots.push(join(base, child));
		} catch {}
		for (const root of roots) {
			for (const rel of [
				"libexec/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json",
				"lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json",
				"node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json",
				"node_modules/undici/package.json",
			]) {
				const candidate = join(root, rel);
				if (existsSync(candidate)) return candidate;
			}
		}
	}

	throw new Error(
		"google-proxy: cannot locate the undici package. Set PI_UNDICI_PATH to its package.json.",
	);
}

/** Plain entries match one host; entries with a leading `.` match the apex and subdomains. */
function parseHosts(raw: string | undefined): string[] {
	return (raw ?? DEFAULT_HOSTS.join(","))
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

function matchesHost(hosts: string[], host: string): boolean {
	if (!host) return false;
	for (const entry of hosts) {
		if (entry.startsWith(".")) {
			const suffix = entry.slice(1);
			if (host === suffix || host.endsWith(`.${suffix}`)) return true;
		} else if (host === entry) {
			return true;
		}
	}
	return false;
}

function hostOf(input: unknown): string {
	let href = "";
	if (typeof input === "string") href = input;
	else if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string") {
		href = (input as { url: string }).url;
	}
	try {
		return new URL(href, "http://placeholder.invalid").hostname.toLowerCase();
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	const proxy = process.env.PI_GOOGLE_PROXY?.trim();
	if (!proxy) return;

	const hosts = parseHosts(process.env.PI_GOOGLE_PROXY_HOSTS);

	// The CLI bundle inlines its own undici copy, so only the dispatcher classes come
	// from the package copy. undici dispatchers are duck-typed through `.dispatch()`.
	const undici = createRequire(process.argv[1] ?? import.meta.url)(
		dirname(findUndici(process.argv[1])),
	);
	const agent = new undici.ProxyAgent({ uri: proxy, proxyTunnel: true });

	const globals = globalThis as unknown as Record<PropertyKey, unknown>;
	let state = globals[STATE_KEY] as ProxyState | undefined;
	if (!state) {
		const created: ProxyState = { inner: globalThis.fetch as FetchLike, wrapper: undefined as never };
		created.wrapper = (input, init) => {
			if (created.agent && matchesHost(hosts, hostOf(input))) {
				return created.inner(input, { ...((init as object) ?? {}), dispatcher: created.agent });
			}
			return created.inner(input, init);
		};
		state = created;
		globals[STATE_KEY] = created;
	}
	state.agent = agent;
	globalThis.fetch = state.wrapper as typeof fetch;

	const globalProxy = process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim();
	pi.on("session_start", (_event, ctx) => {
		if (!globalProxy) return;
		ctx.ui.notify(
			`google-proxy only adds a proxy for ${hosts.join(", ")}, but HTTPS_PROXY/HTTP_PROXY is also set, so Pi proxies every provider. Unset them (and settings httpProxy) to scope the proxy to Google alone.`,
			"warning",
		);
	});

	pi.registerCommand("google-proxy", {
		description: "Show the Google proxy routing configured by the google-proxy extension",
		handler: async (_args, ctx) => {
			const lines = [
				`proxy: ${proxy}`,
				`hosts: ${hosts.join(", ")}`,
				`wrapper active: ${globalThis.fetch === (state.wrapper as typeof fetch)}`,
			];
			if (globalProxy) lines.push(`warning: HTTPS_PROXY/HTTP_PROXY is also set (${globalProxy})`);
			ctx.ui.notify(lines.join("\n"), globalProxy ? "warning" : "info");
		},
	});
}
