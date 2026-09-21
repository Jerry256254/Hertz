export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let unauthorizedHandler: (() => void) | null = null;
let unauthorizedFired = false;

/**
 * Registers a one-shot-per-page-load callback for 401 responses (expired
 * session). Auth endpoints themselves are excluded so the login flow and
 * the initial "am I logged in" probe never trigger it.
 */
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

/** API paths that legitimately return 401 without meaning "session expired". */
const AUTH_PATHS = ["/auth/", "/setup/"];

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 401 && !unauthorizedFired && !AUTH_PATHS.some((p) => path.startsWith(p))) {
      unauthorizedFired = true;
      try {
        unauthorizedHandler?.();
      } catch {
        /* handler must never break the request path */
      }
    }
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.error ?? message;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
