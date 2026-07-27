import { n as __toESM } from "../_runtime.mjs";
import { A as redirect, _ as useRouter, c as HeadContent, d as Outlet, f as lazyRouteComponent, h as Link, m as createRootRouteWithContext, p as createFileRoute, s as Scripts, u as createRouter } from "../_libs/@tanstack/react-router+[...].mjs";
import { T as require_jsx_runtime } from "../_libs/@radix-ui/react-alert-dialog+[...].mjs";
import { u as require_react } from "../_libs/@floating-ui/react-dom+[...].mjs";
import { t as supabase } from "./client-C8x6RfeV.mjs";
import { t as Toaster } from "../_libs/sonner.mjs";
import { t as ConfirmProvider } from "./confirm-provider-DMbkJnjU.mjs";
import { t as QueryClient } from "../_libs/tanstack__query-core.mjs";
import { t as QueryClientProvider } from "../_libs/tanstack__react-query.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/router-C3oSEjGG.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var Toaster$1 = ({ ...props }) => {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toaster, {
		className: "toaster group",
		position: "bottom-left",
		dir: "rtl",
		richColors: true,
		duration: 4e3,
		visibleToasts: 5,
		closeButton: false,
		gap: 10,
		offset: "1.25rem",
		toastOptions: { classNames: {
			toast: "group toast w-full sm:w-[min(22rem,calc(100vw-2rem))] p-4 rounded-xl border border-border bg-background/95 text-foreground shadow-float backdrop-blur-sm transition-all duration-300 ease-out",
			description: "group-[.toast]:text-muted-foreground text-sm leading-relaxed",
			actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:hover:bg-primary/90",
			cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground group-[.toast]:hover:bg-muted/80",
			title: "group-[.toast]:text-sm font-medium leading-snug"
		} },
		...props
	});
};
var styles_default = "/assets/styles-CWZz_Qux.css";
function reportLovableError(error, context = {}) {
	if (typeof window === "undefined") return;
	window.__lovableEvents?.captureException?.(error, {
		source: "react_error_boundary",
		route: window.location.pathname,
		...context
	}, {
		mechanism: "react_error_boundary",
		handled: false,
		severity: "error"
	});
	const message = error instanceof Response ? `Response ${error.status}${error.url ? ` at ${error.url}` : ""}` : error instanceof Error ? error.message : String(error);
	window.__lovableReportRuntimeError?.({
		message,
		stack: error instanceof Error ? error.stack : void 0,
		filename: window.location.pathname
	});
}
function NotFoundComponent() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex min-h-screen items-center justify-center bg-background px-4",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "max-w-md text-center",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
					className: "text-7xl font-bold text-foreground",
					children: "404"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "mt-4 text-xl font-semibold text-foreground",
					children: "Page not found"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 text-sm text-muted-foreground",
					children: "The page you're looking for doesn't exist or has been moved."
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-6",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
						to: "/",
						className: "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90",
						children: "Go home"
					})
				})
			]
		})
	});
}
function ErrorComponent({ error, reset }) {
	console.error(error);
	const router = useRouter();
	(0, import_react.useEffect)(() => {
		reportLovableError(error, { boundary: "tanstack_root_error_component" });
	}, [error]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "flex min-h-screen items-center justify-center bg-background px-4",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "max-w-md text-center",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
					className: "text-xl font-semibold tracking-tight text-foreground",
					children: "This page didn't load"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 text-sm text-muted-foreground",
					children: "Something went wrong on our end. You can try refreshing or head back home."
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-6 flex flex-wrap justify-center gap-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						onClick: () => {
							router.invalidate();
							reset();
						},
						className: "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90",
						children: "Try again"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
						href: "/",
						className: "inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent",
						children: "Go home"
					})]
				})
			]
		})
	});
}
var Route$9 = createRootRouteWithContext()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1"
			},
			{ title: "MailMaestro — منصة SaaS للبريد المؤسسي متعدد الشركات" },
			{
				name: "description",
				content: "افتح أي بريد إلكتروني بأداء عالٍ وسرعة البرق. منصة SaaS للشركات مع تخصيص كامل بالشعار والألوان لكل عميل."
			},
			{
				name: "author",
				content: "MailMaestro"
			},
			{
				property: "og:title",
				content: "MailMaestro — منصة SaaS للبريد المؤسسي متعدد الشركات"
			},
			{
				property: "og:description",
				content: "افتح أي بريد إلكتروني بأداء عالٍ وسرعة البرق. منصة SaaS للشركات مع تخصيص كامل بالشعار والألوان لكل عميل."
			},
			{
				property: "og:type",
				content: "website"
			},
			{
				name: "twitter:card",
				content: "summary_large_image"
			},
			{
				name: "twitter:title",
				content: "MailMaestro — منصة SaaS للبريد المؤسسي متعدد الشركات"
			},
			{
				name: "twitter:description",
				content: "افتح أي بريد إلكتروني بأداء عالٍ وسرعة البرق. منصة SaaS للشركات مع تخصيص كامل بالشعار والألوان لكل عميل."
			},
			{
				property: "og:image",
				content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/55b3c81e-cddc-4ed5-bef1-c1b02f3f74ad/id-preview-60e9961f--da2f05fb-8851-4f2f-9914-d1405b6cdf1d.lovable.app-1784894941024.png"
			},
			{
				name: "twitter:image",
				content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/55b3c81e-cddc-4ed5-bef1-c1b02f3f74ad/id-preview-60e9961f--da2f05fb-8851-4f2f-9914-d1405b6cdf1d.lovable.app-1784894941024.png"
			}
		],
		links: [
			{
				rel: "stylesheet",
				href: styles_default
			},
			{
				rel: "icon",
				href: "/favicon.ico",
				type: "image/x-icon"
			},
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com"
			},
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: ""
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&display=swap"
			}
		]
	}),
	shellComponent: RootShell,
	component: RootComponent,
	notFoundComponent: NotFoundComponent,
	errorComponent: ErrorComponent
});
function RootShell({ children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("html", {
		lang: "ar",
		dir: "rtl",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("head", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HeadContent, {}) }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("body", { children: [children, /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Scripts, {})] })]
	});
}
function RootComponent() {
	const { queryClient } = Route$9.useRouteContext();
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(QueryClientProvider, {
		client: queryClient,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(ConfirmProvider, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toaster$1, {})] })
	});
}
var BASE_URL = "";
var Route$8 = createFileRoute("/sitemap.xml")({ server: { handlers: { GET: async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
		{
			path: "/",
			changefreq: "weekly",
			priority: "1.0"
		},
		{
			path: "/login",
			changefreq: "monthly",
			priority: "0.6"
		},
		{
			path: "/company",
			changefreq: "monthly",
			priority: "0.6"
		}
	].map((e) => `  <url>\n    <loc>${BASE_URL}${e.path}</loc>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`).join("\n")}\n</urlset>`;
	return new Response(xml, { headers: {
		"Content-Type": "application/xml",
		"Cache-Control": "public, max-age=3600"
	} });
} } } });
var $$splitComponentImporter$5 = () => import("./mail-Da1BT2cd.mjs");
var Route$7 = createFileRoute("/mail")({
	ssr: false,
	head: () => ({ meta: [{ title: "صندوق الوارد — MailMaestro" }] }),
	component: lazyRouteComponent($$splitComponentImporter$5, "component")
});
var $$splitComponentImporter$4 = () => import("./login-S1eRkQSd.mjs");
var Route$6 = createFileRoute("/login")({
	head: () => ({ meta: [
		{ title: "دخول العملاء — MailMaestro" },
		{
			name: "description",
			content: "بوابة دخول العملاء إلى بريدهم الإلكتروني عبر منصة MailMaestro."
		},
		{
			property: "og:title",
			content: "دخول العملاء — MailMaestro"
		},
		{
			property: "og:description",
			content: "افتح بريدك الإلكتروني بسرعة البرق."
		}
	] }),
	component: lazyRouteComponent($$splitComponentImporter$4, "component")
});
var $$splitComponentImporter$3 = () => import("./company-5zH5-Uta.mjs");
var Route$5 = createFileRoute("/company")({
	head: () => ({ meta: [
		{ title: "بوابة الشركات — MailMaestro" },
		{
			name: "description",
			content: "سجّل شركتك على منصة MailMaestro أو ادخل إلى لوحة تحكم شركتك لإدارة إيميلات عملائك."
		},
		{
			property: "og:title",
			content: "بوابة الشركات — MailMaestro"
		},
		{
			property: "og:description",
			content: "منصة SaaS لإدارة إيميلات الشركات وعملائها بسرعة البرق."
		}
	] }),
	component: lazyRouteComponent($$splitComponentImporter$3, "component")
});
var $$splitComponentImporter$2 = () => import("./route-Di7iQBCH.mjs");
var Route$4 = createFileRoute("/_authenticated")({
	ssr: false,
	beforeLoad: async () => {
		const { data, error } = await supabase.auth.getUser();
		if (error || !data.user) throw redirect({ to: "/company" });
		return { user: data.user };
	},
	component: lazyRouteComponent($$splitComponentImporter$2, "component")
});
var $$splitComponentImporter$1 = () => import("./routes--qfgSg7V.mjs");
var Route$3 = createFileRoute("/")({
	head: () => ({ meta: [
		{ title: "MailMaestro — منصة SaaS للبريد المؤسسي متعدد الشركات" },
		{
			name: "description",
			content: "افتح أي بريد إلكتروني بأداء عالٍ وسرعة البرق. منصة SaaS للشركات مع تخصيص كامل بالشعار والألوان لكل عميل."
		},
		{
			property: "og:title",
			content: "MailMaestro — منصة SaaS للبريد المؤسسي متعدد الشركات"
		},
		{
			property: "og:description",
			content: "افتح أي بريد إلكتروني بأداء عالٍ وسرعة البرق. منصة SaaS للشركات مع تخصيص كامل بالشعار والألوان لكل عميل."
		}
	] }),
	component: lazyRouteComponent($$splitComponentImporter$1, "component")
});
/**
* Compose+send endpoint. Accepts multipart/form-data from the browser with a
* JSON `payload` field (containing `mailSessionToken` + `password` + message
* fields) and any number of `attachments` files.
*
* Security model (closes bridge_passthrough_open):
*   * We verify the signed Mail Session JWT server-side.
*   * The IMAP/SMTP account is loaded from the DB by verified accountId —
*     the browser cannot supply host/port/security or an arbitrary account.
*   * We rebuild a new multipart body with the server-derived `account`
*     before forwarding to the private Bridge.
*/
var Route$2 = createFileRoute("/api/mail-send")({ server: { handlers: { POST: async ({ request }) => {
	if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("multipart/form-data")) return json$1({
		ok: false,
		error: "Expected multipart/form-data"
	}, 400);
	let form;
	try {
		form = await request.formData();
	} catch {
		return json$1({
			ok: false,
			error: "Invalid multipart body"
		}, 400);
	}
	const payloadRaw = form.get("payload");
	if (typeof payloadRaw !== "string") return json$1({
		ok: false,
		error: "Missing payload"
	}, 400);
	let payload;
	try {
		payload = JSON.parse(payloadRaw);
	} catch {
		return json$1({
			ok: false,
			error: "Invalid payload JSON"
		}, 400);
	}
	const token = typeof payload?.mailSessionToken === "string" ? payload.mailSessionToken : "";
	const password = typeof payload?.password === "string" ? payload.password : "";
	if (!token || !password) return json$1({
		ok: false,
		error: "جلسة البريد مطلوبة."
	}, 401);
	const { resolveBridgeAuth } = await import("./mail-bridge-auth.server-buSlOQzn.mjs");
	const auth = await resolveBridgeAuth(token);
	if (!auth.ok) return json$1({
		ok: false,
		error: auth.error
	}, auth.status);
	const safePayload = {
		account: auth.bridgeAccount,
		password,
		to: Array.isArray(payload?.to) ? payload.to : [],
		cc: Array.isArray(payload?.cc) ? payload.cc : [],
		bcc: Array.isArray(payload?.bcc) ? payload.bcc : [],
		subject: typeof payload?.subject === "string" ? payload.subject : "",
		bodyHtml: typeof payload?.bodyHtml === "string" ? payload.bodyHtml : void 0,
		bodyText: typeof payload?.bodyText === "string" ? payload.bodyText : void 0
	};
	const outForm = new FormData();
	outForm.append("payload", JSON.stringify(safePayload));
	for (const [k, v] of form.entries()) {
		if (k === "payload") continue;
		if (k === "attachments" && v instanceof File) outForm.append("attachments", v, v.name);
	}
	const upstream = await fetch(`${auth.bridgeUrl}/api/send-multipart`, {
		method: "POST",
		headers: { "X-Bridge-Key": auth.bridgeKey },
		body: outForm
	});
	const text = await upstream.text();
	return new Response(text, {
		status: upstream.status,
		headers: {
			"Content-Type": upstream.headers.get("Content-Type") || "application/json",
			"Cache-Control": "private, no-store"
		}
	});
} } } });
function json$1(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" }
	});
}
/**
* Streams an email attachment from the private Bridge to the browser.
*
* Security model (closes bridge_passthrough_open):
*   * Requires a signed Mail Session JWT — accountId/companyId come from
*     verified claims, not the request body.
*   * IMAP host/port/security are loaded from the database; the browser
*     cannot influence which host is contacted.
*/
var Route$1 = createFileRoute("/api/mail-attachment")({ server: { handlers: { POST: async ({ request }) => {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}
	if (!body || typeof body !== "object" || typeof body.mailSessionToken !== "string" || typeof body.password !== "string" || typeof body.folder !== "string" || typeof body.uid !== "number" || typeof body.part !== "string") return json({ error: "Invalid payload" }, 400);
	const { resolveBridgeAuth } = await import("./mail-bridge-auth.server-buSlOQzn.mjs");
	const auth = await resolveBridgeAuth(body.mailSessionToken);
	if (!auth.ok) return json({ error: auth.error }, auth.status);
	const upstream = await fetch(`${auth.bridgeUrl}/api/attachment`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Bridge-Key": auth.bridgeKey
		},
		body: JSON.stringify({
			account: auth.bridgeAccount,
			password: body.password,
			folder: body.folder,
			uid: body.uid,
			part: body.part
		})
	});
	const outHeaders = new Headers();
	const ct = upstream.headers.get("Content-Type");
	const cd = upstream.headers.get("Content-Disposition");
	const cl = upstream.headers.get("Content-Length");
	if (ct) outHeaders.set("Content-Type", ct);
	if (cd) outHeaders.set("Content-Disposition", cd);
	if (cl) outHeaders.set("Content-Length", cl);
	outHeaders.set("X-Content-Type-Options", "nosniff");
	outHeaders.set("Cache-Control", "private, no-store");
	return new Response(upstream.body, {
		status: upstream.status,
		headers: outHeaders
	});
} } } });
function json(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" }
	});
}
var $$splitComponentImporter = () => import("./dashboard-DPfP7jFY.mjs");
var Route = createFileRoute("/_authenticated/dashboard")({
	head: () => ({ meta: [{ title: "لوحة تحكم الشركة — MailMaestro" }] }),
	component: lazyRouteComponent($$splitComponentImporter, "component")
});
var SitemapDotxmlRoute = Route$8.update({
	id: "/sitemap.xml",
	path: "/sitemap.xml",
	getParentRoute: () => Route$9
});
var MailRoute = Route$7.update({
	id: "/mail",
	path: "/mail",
	getParentRoute: () => Route$9
});
var LoginRoute = Route$6.update({
	id: "/login",
	path: "/login",
	getParentRoute: () => Route$9
});
var CompanyRoute = Route$5.update({
	id: "/company",
	path: "/company",
	getParentRoute: () => Route$9
});
var AuthenticatedRouteRoute = Route$4.update({
	id: "/_authenticated",
	getParentRoute: () => Route$9
});
var IndexRoute = Route$3.update({
	id: "/",
	path: "/",
	getParentRoute: () => Route$9
});
var ApiMailSendRoute = Route$2.update({
	id: "/api/mail-send",
	path: "/api/mail-send",
	getParentRoute: () => Route$9
});
var ApiMailAttachmentRoute = Route$1.update({
	id: "/api/mail-attachment",
	path: "/api/mail-attachment",
	getParentRoute: () => Route$9
});
var AuthenticatedRouteRouteChildren = { AuthenticatedDashboardRoute: Route.update({
	id: "/dashboard",
	path: "/dashboard",
	getParentRoute: () => AuthenticatedRouteRoute
}) };
var rootRouteChildren = {
	IndexRoute,
	AuthenticatedRouteRoute: AuthenticatedRouteRoute._addFileChildren(AuthenticatedRouteRouteChildren),
	CompanyRoute,
	LoginRoute,
	MailRoute,
	SitemapDotxmlRoute,
	ApiMailAttachmentRoute,
	ApiMailSendRoute
};
var routeTree = Route$9._addFileChildren(rootRouteChildren)._addFileTypes();
var getRouter = () => {
	return createRouter({
		routeTree,
		context: { queryClient: new QueryClient() },
		scrollRestoration: true,
		defaultPreloadStaleTime: 0
	});
};
//#endregion
export { getRouter };
