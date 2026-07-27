globalThis.__nitro_main__ = import.meta.url;
import { a as FastResponse, n as HTTPError, r as defineLazyEventHandler, t as H3Core } from "./_libs/h3+rou3+srvx.mjs";
import { t as HookableCore } from "./_libs/hookable.mjs";
//#region #nitro-vite-setup
function lazyService(loader) {
	let promise, mod;
	return { fetch(req) {
		if (mod) return mod.fetch(req);
		if (!promise) promise = loader().then((_mod) => mod = _mod.default || _mod);
		return promise.then((mod) => mod.fetch(req));
	} };
}
var services = { ["ssr"]: lazyService(() => import("./_ssr/ssr.mjs")) };
globalThis.__nitro_vite_envs__ = services;
//#endregion
//#region #nitro/virtual/public-assets-data
var public_assets_data_default = {
	"/assets/arrow-left-DPGzfQix.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"99-JRifd1h/YMY3aPY4DOniVchhX0M\"",
		"mtime": "2026-07-27T12:43:26.009Z",
		"size": 153,
		"path": "../client/assets/arrow-left-DPGzfQix.js"
	},
	"/favicon.ico": {
		"type": "image/vnd.microsoft.icon",
		"etag": "\"4f95-3RXc3p2mhEAs1WBwaIvE0Y0uu0Y\"",
		"mtime": "2026-07-27T12:43:28.179Z",
		"size": 20373,
		"path": "../client/favicon.ico"
	},
	"/assets/createServerFn-CvDAYKtH.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"1260-q45ih05fX2uBa44S1qOe52yMxRk\"",
		"mtime": "2026-07-27T12:43:26.009Z",
		"size": 4704,
		"path": "../client/assets/createServerFn-CvDAYKtH.js"
	},
	"/robots.txt": {
		"type": "text/plain; charset=utf-8",
		"etag": "\"4b-xLpfxESO2EJ0XUZQV/BFaUYeXCY\"",
		"mtime": "2026-07-27T12:43:28.179Z",
		"size": 75,
		"path": "../client/robots.txt"
	},
	"/assets/dashboard-DtgFIdM1.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"602d-9hu6c23LUOJALvpRAhBi/3R4HlQ\"",
		"mtime": "2026-07-27T12:43:26.009Z",
		"size": 24621,
		"path": "../client/assets/dashboard-DtgFIdM1.js"
	},
	"/assets/company-DrDvhnkO.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"2143-rKo+VDXG96D8I1fXAXUo28ynbOA\"",
		"mtime": "2026-07-27T12:43:26.009Z",
		"size": 8515,
		"path": "../client/assets/company-DrDvhnkO.js"
	},
	"/assets/loader-circle-Bwo-Ng1-.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"84-9bi87RYl9xtGMKW/wsx/4BM4Di0\"",
		"mtime": "2026-07-27T12:43:26.009Z",
		"size": 132,
		"path": "../client/assets/loader-circle-Bwo-Ng1-.js"
	},
	"/assets/route-B3iIJl9u.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"8a-bCrJSmEsUfNmSuNf4pI1X4SBHpo\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 138,
		"path": "../client/assets/route-B3iIJl9u.js"
	},
	"/assets/use-company-theme-DPLlcE18.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"7a2-iS8DLVBKPpM4NOJoCVSWiIGjS38\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 1954,
		"path": "../client/assets/use-company-theme-DPLlcE18.js"
	},
	"/assets/routes-B_mm9AyG.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"2459-SjLRhISeUYsZocLYtI7Dig540Ok\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 9305,
		"path": "../client/assets/routes-B_mm9AyG.js"
	},
	"/assets/palette-Cl1jJALy.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"1f2-KMNeb7VGSoMTnwOXHP6asoglPd4\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 498,
		"path": "../client/assets/palette-Cl1jJALy.js"
	},
	"/assets/useStore-DAs5vFz2.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"6b50-gJVpJ72ZOwiLeFNrSvHPv8Rvm2k\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 27472,
		"path": "../client/assets/useStore-DAs5vFz2.js"
	},
	"/assets/mail-OICPq-QE.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"543-hnkaa1OuxNfAaFgAVbPO49UChpA\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 1347,
		"path": "../client/assets/mail-OICPq-QE.js"
	},
	"/assets/login-CmLmAzOZ.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"13f6-qqZJFGotyoS/llmNElo2BUQ25g4\"",
		"mtime": "2026-07-27T12:43:26.009Z",
		"size": 5110,
		"path": "../client/assets/login-CmLmAzOZ.js"
	},
	"/assets/styles-CWZz_Qux.css": {
		"type": "text/css; charset=utf-8",
		"etag": "\"17ed9-uk5PQDx2f6CwAW5yHOl6GfHoX2E\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 98009,
		"path": "../client/assets/styles-CWZz_Qux.css"
	},
	"/assets/mail-session-CDi-BdTQ.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"14f-maqxk2MnjChrVpmUI2UFhPvVWO4\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 335,
		"path": "../client/assets/mail-session-CDi-BdTQ.js"
	},
	"/assets/index-DGoKxjXy.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"9aa0d-OAkBPFyYWIC+DpCC+Erz3x7/4uk\"",
		"mtime": "2026-07-27T12:43:26.009Z",
		"size": 633357,
		"path": "../client/assets/index-DGoKxjXy.js"
	},
	"/assets/mail-Dy1REjj0.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"38957-KuaX1dTAaKqDIvW6z4pf5pCD7XA\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 231767,
		"path": "../client/assets/mail-Dy1REjj0.js"
	},
	"/assets/zap-_zwEKiTJ.js": {
		"type": "text/javascript; charset=utf-8",
		"etag": "\"fa-zVh2+6vQiT4+UsAsUYYpSG4MaGI\"",
		"mtime": "2026-07-27T12:43:26.010Z",
		"size": 250,
		"path": "../client/assets/zap-_zwEKiTJ.js"
	}
};
//#endregion
//#region #nitro/virtual/public-assets
var publicAssetBases = {};
function isPublicAssetURL(id = "") {
	if (public_assets_data_default[id]) return true;
	for (const base in publicAssetBases) if (id.startsWith(base)) return true;
	return false;
}
//#endregion
//#region node_modules/nitro/dist/runtime/internal/route-rules.mjs
var headers = ((m) => function headersRouteRule(event) {
	for (const [key, value] of Object.entries(m.options || {})) event.res.headers.set(key, value);
});
//#endregion
//#region #nitro/virtual/routing
var findRouteRules = /* @__PURE__ */ (() => {
	const $0 = [{
		name: "headers",
		route: "/assets/**",
		handler: headers,
		options: { "cache-control": "public, max-age=31536000, immutable" }
	}];
	return (m, p) => {
		let r = [];
		if (p.charCodeAt(p.length - 1) === 47) p = p.slice(0, -1) || "/";
		let s = p.split("/");
		if (s.length > 1) {
			if (s[1] === "assets") r.unshift({
				data: $0,
				params: { "_": s.slice(2).join("/") }
			});
		}
		return r;
	};
})();
var _lazy_j21Qvj = defineLazyEventHandler(() => import("./_chunks/ssr-renderer.mjs"));
var findRoute = /* @__PURE__ */ (() => {
	const data = {
		route: "/**",
		handler: _lazy_j21Qvj
	};
	return ((_m, p) => {
		return {
			data,
			params: { "_": p.slice(1) }
		};
	});
})();
[].filter(Boolean);
//#endregion
//#region node_modules/nitro/dist/runtime/internal/error/prod.mjs
var errorHandler = (error, event) => {
	const res = defaultHandler(error, event);
	return new FastResponse(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2), res);
};
function defaultHandler(error, event) {
	const unhandled = error.unhandled ?? !HTTPError.isError(error);
	const { status = 500, statusText = "" } = unhandled ? {} : error;
	if (status === 404) {
		const url = event.url || new URL(event.req.url);
		const baseURL = "/";
		if (/^\/[^/]/.test(baseURL) && !url.pathname.startsWith(baseURL)) return {
			status: 302,
			headers: new Headers({ location: `${baseURL}${url.pathname.slice(1)}${url.search}` })
		};
	}
	const headers = new Headers(unhandled ? {} : error.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	return {
		status,
		statusText,
		headers,
		body: {
			error: true,
			...unhandled ? {
				status,
				unhandled: true
			} : typeof error.toJSON === "function" ? error.toJSON() : {
				status,
				statusText,
				message: error.message
			}
		}
	};
}
//#endregion
//#region #nitro/virtual/error-handler
var errorHandlers = [errorHandler];
async function error_handler_default(error, event) {
	for (const handler of errorHandlers) try {
		const response = await handler(error, event, { defaultHandler });
		if (response) return response;
	} catch (error) {
		console.error(error);
	}
}
//#endregion
//#region #nitro/virtual/app
function createNitroApp() {
	const captureError = (error, errorCtx) => {
		if (errorCtx?.event) {
			const errors = errorCtx.event.req.context?.nitro?.errors;
			if (errors) errors.push({
				error,
				context: errorCtx
			});
		}
	};
	const h3App = createH3App({ onError(error, event) {
		return error_handler_default(error, event);
	} });
	let appHandler = (req) => {
		req.context ||= {};
		req.context.nitro = req.context.nitro || { errors: [] };
		return h3App.fetch(req);
	};
	return {
		fetch: appHandler,
		h3: h3App,
		hooks: void 0,
		captureError
	};
}
function createH3App(config) {
	const h3App = new H3Core(config);
	h3App["~findRoute"] = (event) => findRoute(event.req.method, event.url.pathname);
	h3App["~getMiddleware"] = (event, route) => {
		const pathname = event.url.pathname;
		const method = event.req.method;
		const middleware = [];
		const routeRules = getRouteRules(method, pathname);
		event.context.routeRules = routeRules?.routeRules;
		if (routeRules?.routeRuleMiddleware.length) middleware.push(...routeRules.routeRuleMiddleware);
		if (route?.data?.middleware?.length) middleware.push(...route.data.middleware);
		return middleware;
	};
	return h3App;
}
//#endregion
//#region node_modules/nitro/dist/runtime/internal/app.mjs
var APP_ID = "default";
function useNitroApp() {
	let instance = useNitroApp._instance;
	if (instance) return instance;
	instance = useNitroApp._instance = createNitroApp();
	globalThis.__nitro__ = globalThis.__nitro__ || {};
	globalThis.__nitro__[APP_ID] = instance;
	return instance;
}
function useNitroHooks() {
	const nitroApp = useNitroApp();
	const hooks = nitroApp.hooks;
	if (hooks) return hooks;
	return nitroApp.hooks = new HookableCore();
}
function getRouteRules(method, pathname) {
	const m = findRouteRules(method, pathname);
	if (!m?.length) return { routeRuleMiddleware: [] };
	const routeRules = {};
	for (const layer of m) for (const rule of layer.data) {
		const currentRule = routeRules[rule.name];
		if (currentRule) {
			if (rule.options === false) {
				delete routeRules[rule.name];
				continue;
			}
			if (typeof currentRule.options === "object" && typeof rule.options === "object") currentRule.options = {
				...currentRule.options,
				...rule.options
			};
			else currentRule.options = rule.options;
			currentRule.route = rule.route;
			currentRule.params = {
				...currentRule.params,
				...layer.params
			};
		} else if (rule.options !== false) routeRules[rule.name] = {
			...rule,
			params: layer.params
		};
	}
	const middleware = [];
	const orderedRules = Object.values(routeRules).sort((a, b) => (a.handler?.order || 0) - (b.handler?.order || 0));
	for (const rule of orderedRules) {
		if (rule.options === false || !rule.handler) continue;
		middleware.push(rule.handler(rule));
	}
	return {
		routeRules,
		routeRuleMiddleware: middleware
	};
}
//#endregion
//#region node_modules/nitro/dist/presets/cloudflare/runtime/_module-handler.mjs
function createHandler(hooks) {
	const nitroApp = useNitroApp();
	const nitroHooks = useNitroHooks();
	return {
		async fetch(request, env, context) {
			globalThis.__env__ = env;
			augmentReq(request, {
				env,
				context
			});
			const ctxExt = {};
			const url = new URL(request.url);
			if (hooks.fetch) {
				const res = await hooks.fetch(request, env, context, url, ctxExt);
				if (res) return res;
			}
			return await nitroApp.fetch(request);
		},
		scheduled(controller, env, context) {
			globalThis.__env__ = env;
			context.waitUntil(nitroHooks.callHook("cloudflare:scheduled", {
				controller,
				env,
				context
			}) || Promise.resolve());
		},
		email(message, env, context) {
			globalThis.__env__ = env;
			context.waitUntil(nitroHooks.callHook("cloudflare:email", {
				message,
				event: message,
				env,
				context
			}) || Promise.resolve());
		},
		queue(batch, env, context) {
			globalThis.__env__ = env;
			context.waitUntil(nitroHooks.callHook("cloudflare:queue", {
				batch,
				event: batch,
				env,
				context
			}) || Promise.resolve());
		},
		tail(traces, env, context) {
			globalThis.__env__ = env;
			context.waitUntil(nitroHooks.callHook("cloudflare:tail", {
				traces,
				env,
				context
			}) || Promise.resolve());
		},
		trace(traces, env, context) {
			globalThis.__env__ = env;
			context.waitUntil(nitroHooks.callHook("cloudflare:trace", {
				traces,
				env,
				context
			}) || Promise.resolve());
		}
	};
}
function augmentReq(cfReq, ctx) {
	const req = cfReq;
	req.ip = cfReq.headers.get("cf-connecting-ip") || void 0;
	req.runtime ??= { name: "cloudflare" };
	req.runtime.cloudflare = {
		...req.runtime.cloudflare,
		...ctx
	};
	req.waitUntil = ctx.context?.waitUntil.bind(ctx.context);
}
//#endregion
//#region node_modules/nitro/dist/presets/cloudflare/runtime/cloudflare-module.mjs
var cloudflare_module_default = createHandler({ fetch(cfRequest, env, context, url) {
	if (env.ASSETS && isPublicAssetURL(url.pathname)) return env.ASSETS.fetch(cfRequest);
} });
//#endregion
export { cloudflare_module_default as default };
