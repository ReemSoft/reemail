const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validatedHost(rawHost: string | undefined): string {
  const host = String(rawHost || "").trim();
  if (!host || host.length > 255 || /[\s/,\\@?#]/.test(host)) {
    throw new Error("INVALID_PUBLIC_BRIDGE_HOST");
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    throw new Error("INVALID_PUBLIC_BRIDGE_HOST");
  }
  if (parsed.host !== host || parsed.username || parsed.password || parsed.pathname !== "/") {
    throw new Error("INVALID_PUBLIC_BRIDGE_HOST");
  }
  return host;
}

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

function validatePublicBase(rawBase: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new Error("INVALID_PUBLIC_BRIDGE_URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("INVALID_PUBLIC_BRIDGE_URL");
  }
  if (parsed.protocol !== "https:" && !isLocalHostname(parsed.hostname)) {
    throw new Error("INSECURE_PUBLIC_BRIDGE_URL");
  }
  return parsed.origin;
}

export interface PublicBridgeRequest {
  protocol: string;
  get(name: string): string | undefined;
}

export function publicBridgeBase(
  req: PublicBridgeRequest,
  configuredBase = process.env.MAIL_BRIDGE_PUBLIC_URL,
): string {
  if (configuredBase?.trim()) return validatePublicBase(configuredBase.trim());
  const forwardedProtocol = req.get("x-forwarded-proto");
  const protocol = forwardedProtocol === undefined ? req.protocol : forwardedProtocol.trim();
  if (protocol !== "http" && protocol !== "https") {
    throw new Error("INVALID_FORWARDED_PROTOCOL");
  }
  const host = validatedHost(req.get("host"));
  return validatePublicBase(`${protocol}://${host}`);
}

export function configuredAppOrigins(value = process.env.MAIL_APP_ORIGINS): Set<string> {
  return new Set(
    (value?.trim() ? value : "https://mailmaestro.online")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function isAllowedAppOrigin(origin: string | undefined, allowed: Set<string>): boolean {
  return (
    !origin || allowed.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}
