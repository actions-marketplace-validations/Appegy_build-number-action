import * as core from "@actions/core";

type Operation =
  | "hit"
  | "create"
  | "get"
  | "info"
  | "set"
  | "update"
  | "reset"
  | "delete";

type HttpMethod = "GET" | "POST";

const BASE_URL = "https://abacus.jasoncameron.dev";
const MAX_ATTEMPTS = 5;
const MAX_LOG_BODY_CHARS = 2000;

// Abacus format: ^[A-Za-z0-9_-.]{3,64}$
const NAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function requireNonEmpty(name: string, value: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required input: ${name}`);
  }
}

function validateName(kind: "namespace" | "key", value: string): void {
  if (!NAME_RE.test(value)) {
    throw new Error(
      `Invalid ${kind}: must match ^[A-Za-z0-9_-.]{3,64}$ (got "${value}")`
    );
  }
}

function parseInteger(name: string, raw: string): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`Invalid ${name}: expected integer, got "${raw}"`);
  }
  return v;
}

function isAdminOp(op: Operation): boolean {
  return op === "set" || op === "update" || op === "reset" || op === "delete";
}

function methodFor(op: Operation): HttpMethod {
  return isAdminOp(op) ? "POST" : "GET";
}

function buildUrl(
  op: Operation,
  namespace: string,
  key: string,
  initializer?: number,
  value?: number
): string {
  const base = normalizeBaseUrl(BASE_URL);

  const path = `/${op}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
  const url = new URL(base + path);

  if (op === "create" && initializer !== undefined) {
    url.searchParams.set("initializer", String(initializer));
  }
  if ((op === "set" || op === "update") && value !== undefined) {
    url.searchParams.set("value", String(value));
  }

  return url.toString();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [truncated ${s.length - max} chars]`;
}

function sanitizeForLogs(input: unknown): string {
  const redactKeys = new Set(["admin_key", "authorization", "Authorization"]);

  if (typeof input === "string") {
    return truncate(input, MAX_LOG_BODY_CHARS);
  }

  try {
    const str = JSON.stringify(
      input,
      (k, v) => {
        if (redactKeys.has(k)) return "***";
        return v;
      },
      2
    );
    return truncate(str, MAX_LOG_BODY_CHARS);
  } catch {
    return truncate(String(input), MAX_LOG_BODY_CHARS);
  }
}

function logRateLimit(res: Response): void {
  const limit = res.headers.get("X-RateLimit-Limit");
  const remaining = res.headers.get("X-RateLimit-Remaining");
  const reset = res.headers.get("X-RateLimit-Reset");
  const retryAfter = res.headers.get("Retry-After");

  const parts: string[] = [];
  if (limit) parts.push(`limit=${limit}`);
  if (remaining) parts.push(`remaining=${remaining}`);
  if (reset) parts.push(`reset=${reset}`);
  if (retryAfter) parts.push(`retryAfterMs=${retryAfter}`);

  if (parts.length > 0) {
    core.info(`rate-limit: ${parts.join(" ")}`);
  }
}

async function requestWithRetries(
  url: string,
  method: HttpMethod,
  headers: Record<string, string>
): Promise<Response> {
  let attempt = 0;
  let backoffMs = 500;

  // Do not log headers (can contain secrets).
  core.info(`request: ${method} ${url}`);

  while (true) {
    attempt += 1;
    core.info(`attempt: ${attempt}/${MAX_ATTEMPTS}`);

    try {
      const res = await fetch(url, { method, headers });

      core.info(`response: status=${res.status}`);
      logRateLimit(res);

      // 429: respect Retry-After (ms).
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const ra = res.headers.get("Retry-After");
        const waitMs = ra ? Math.max(0, parseInteger("Retry-After", ra)) : backoffMs;

        let bodyText = "";
        try {
          bodyText = await res.text();
        } catch {
          bodyText = "";
        }
        if (bodyText) {
          core.debug(`response body (429): ${sanitizeForLogs(bodyText)}`);
        }

        core.info(`retry: status=429 waitMs=${waitMs}`);
        await sleep(waitMs);
        backoffMs = Math.min(backoffMs * 2, 8000);
        continue;
      }

      // Retry transient 5xx.
      if (res.status >= 500 && res.status <= 599 && attempt < MAX_ATTEMPTS) {
        let bodyText = "";
        try {
          bodyText = await res.text();
        } catch {
          bodyText = "";
        }
        if (bodyText) {
          core.debug(`response body (5xx): ${sanitizeForLogs(bodyText)}`);
        }

        core.info(`retry: status=${res.status} backoffMs=${backoffMs}`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 8000);
        continue;
      }

      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.info(`network error: ${msg}`);

      if (attempt >= MAX_ATTEMPTS) {
        throw err;
      }

      core.info(`retry: network backoffMs=${backoffMs}`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 8000);
    }
  }
}

async function readJsonSafely(res: Response): Promise<{ rawText: string; json: any }> {
  const rawText = await res.text();
  if (!rawText) return { rawText: "", json: {} };

  try {
    return { rawText, json: JSON.parse(rawText) };
  } catch {
    return { rawText, json: { error: rawText } };
  }
}

function setOutputIfPresent(name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  core.setOutput(name, String(value));
}

function logOutputs(operation: Operation, payload: any): void {
  const out: Record<string, unknown> = {};

  if (payload?.value !== undefined) out.value = payload.value;

  if (operation === "create") {
    if (payload?.namespace !== undefined) out.namespace = payload.namespace;
    if (payload?.key !== undefined) out.key = payload.key;
    if (payload?.admin_key !== undefined) out.admin_key = "***";
  }

  if (operation === "info") {
    for (const k of ["exists", "expires_in", "expires_str", "full_key", "is_genuine"]) {
      if (payload?.[k] !== undefined) out[k] = payload[k];
    }
  }

  if (operation === "delete") {
    if (payload?.status !== undefined) out.status = payload.status;
    if (payload?.message !== undefined) out.message = payload.message;
  }

  core.info(`outputs: ${sanitizeForLogs(out)}`);
}

async function run(): Promise<void> {
  const operationRaw = core.getInput("operation") || "hit";
  const operation = operationRaw as Operation;

  const namespace = core.getInput("namespace");
  const key = core.getInput("key");

  requireNonEmpty("namespace", namespace);
  requireNonEmpty("key", key);
  validateName("namespace", namespace);
  validateName("key", key);

  const initializerRaw = core.getInput("initializer") || "0";
  const valueRaw = core.getInput("value");
  const adminKey = core.getInput("admin_key");

  core.info(`op: ${operation} namespace=${namespace} key=${key}`);

  if (isAdminOp(operation)) {
    requireNonEmpty("admin_key", adminKey);
    core.setSecret(adminKey);
  }

  if ((operation === "set" || operation === "update") && (!valueRaw || valueRaw.trim() === "")) {
    throw new Error(`Missing required input: value (required for operation=${operation})`);
  }

  const initializer = operation === "create" ? parseInteger("initializer", initializerRaw) : undefined;
  const value = (operation === "set" || operation === "update") ? parseInteger("value", valueRaw) : undefined;

  const url = buildUrl(operation, namespace, key, initializer, value);
  const method = methodFor(operation);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (isAdminOp(operation)) {
    headers.Authorization = `Bearer ${adminKey}`;
  }

  const res = await requestWithRetries(url, method, headers);
  const { rawText, json: payload } = await readJsonSafely(res);

  core.debug(`response body: ${sanitizeForLogs(payload ?? rawText)}`);

  if (!res.ok) {
    const errMsg =
      typeof payload?.error === "string"
        ? payload.error
        : `Request failed with status ${res.status}`;
    throw new Error(`${errMsg} (operation=${operation})`);
  }

  // Outputs
  setOutputIfPresent("value", payload.value);

  if (operation === "create") {
    setOutputIfPresent("namespace", payload.namespace);
    setOutputIfPresent("key", payload.key);
    setOutputIfPresent("admin_key", payload.admin_key);
    if (typeof payload?.admin_key === "string") {
      core.setSecret(payload.admin_key);
    }
  }

  if (operation === "info") {
    setOutputIfPresent("exists", payload.exists);
    setOutputIfPresent("expires_in", payload.expires_in);
    setOutputIfPresent("expires_str", payload.expires_str);
    setOutputIfPresent("full_key", payload.full_key);
    setOutputIfPresent("is_genuine", payload.is_genuine);
  }

  if (operation === "delete") {
    setOutputIfPresent("status", payload.status);
    setOutputIfPresent("message", payload.message);
  }

  logOutputs(operation, payload);
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(msg);
});