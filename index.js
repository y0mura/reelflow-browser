import puppeteer from "@cloudflare/puppeteer";

/**
 * Cloudflare Browser Run Proxy Worker (index.js)
 *
 * Purpose:
 *   Loads target URLs in a real headless Chromium instance (env.MYBROWSER),
 *   waits through anti-bot interstitials (e.g., BunnyShield, Cloudflare challenges),
 *   detects and dismisses late-rendering SPA age-verification gates (with a fast-path
 *   profile for Site A's <app-age-verification> component and a generic readiness
 *   flow for text-variant age splashes), captures and replays earned origin session
 *   state (cookies + localStorage + sessionStorage) via headers, and returns the
 *   resulting HTML with full CORS support and human-readable diagnostics.
 *
 * Fixed environment contract:
 *   - Dependency: @cloudflare/puppeteer
 *   - Binding:    env.MYBROWSER
 *   - Endpoint:   GET /?url=<url-encoded http/https target>
 */

export const CONFIG = {
  // Browser lifetime management:
  // Default lifecycle is hit-and-run (immediate browser.close() after each request).
  // When &burst=1 (or &warm=1) is passed without &close=1, the Worker disconnects
  // and schedules a ctx.waitUntil() idle reaper that closes the browser after
  // BURST_IDLE_TTL_MS (30 seconds) if no follow-up request attaches.
  KEEP_ALIVE_MS: 60_000,
  BURST_IDLE_TTL_MS: 30_000,

  // Generic navigation & state-machine budgets (preserved for unknown hosts / Site C):
  GOTO_TIMEOUT_MS: 15_000,          // Soft timeout on initial navigation (slow pages continue)
  MAX_TOTAL_WAIT_MS: 22_000,        // Hard ceiling for the generic shield + gate + settle loop
  POLL_INTERVAL_MS: 450,            // DOM inspection cadence
  MIN_GATE_WATCH_MS: 1_800,         // Minimum post-load watch window for late SPA gates
  POST_GATE_SETTLE_MS: 1_200,       // Minimum wait after clicking a gate before capture
  REQUIRED_STABLE_TICKS: 3,         // Consecutive stable ticks required to declare READY (generic)
  GATE_RETRY_COOLDOWN_MS: 900,      // Minimum delay between repeated click attempts on a gate
  MAX_GATE_CLICK_ATTEMPTS: 4,       // Max click escalations in generic loop before declaring stuck

  // Site A (<app-age-verification>) fast-path profile budgets:
  SITE_A_PROFILE_BUDGET_MS: 10_000, // Total gate-phase budget for Site A profile (~10s)
  SITE_A_MOUNT_WATCH_MS: 1_800,     // Bounded mount window to watch for <app-age-verification>
  SITE_A_MAX_CLICK_ATTEMPTS: 2,     // At most 2 click attempts on div.action.ok / inner <p>
  SITE_A_CLICK_COOLDOWN_MS: 900,    // Minimum ~900ms spacing between the 2 click attempts
  SITE_A_POST_CLICK_MIN_MS: 1_200,  // Minimum ~1.2s elapsed after click before success exit
  SITE_A_ABSENT_CHECKS_REQ: 2,      // Component absent on 2 consecutive checks -> done
  SITE_A_EARLY_BAIL_MS: 3_000,      // Early bail ~3s after 2nd click if component still present
  SITE_A_UNRECOGNIZED_MAX_TICKS: 3, // Fallback to generic if component has no known control

  // State capture & replay limits:
  STATE_SCHEMA_VERSION: 1,
  MAX_STATE_HEADER_CHARS: 6_000,    // Omit X-Proxy-State if base64url string exceeds 6,000 chars

  // Viewport & User-Agent:
  VIEWPORT: { width: 1280, height: 800, deviceScaleFactor: 1 },
  FALLBACK_USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers":
    "X-Proxy-Outcome, X-Proxy-Stop-Reason, X-Proxy-Final-Url, X-Proxy-Shield-Status, X-Proxy-Gate-Status, X-Proxy-Age-Component-Present, X-Proxy-Body-Bytes, X-Proxy-Elapsed-Ms, X-Proxy-Browser-Session, X-Proxy-Profile, X-Proxy-State, X-Proxy-State-Status, X-Proxy-State-Cookies, X-Proxy-State-Replay, x-browser-mode, x-browser-reused, x-gate-clicked, x-challenge, x-nav-error",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Allow only GET and HEAD
    if (request.method !== "GET" && request.method !== "HEAD") {
      return buildDiagnosticErrorResponse({
        status: 405,
        title: "Method Not Allowed",
        summary: `This Worker only accepts GET requests (received ${request.method}).`,
        hint: "Call this endpoint as: GET /?url=<url-encoded http or https address>",
        targetUrl: "",
        startTime,
      });
    }

    // 3. Parse request URL and extract ?url= parameter
    let requestUrl;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return buildDiagnosticErrorResponse({
        status: 400,
        title: "Malformed Worker Request URL",
        summary: "The incoming request URL could not be parsed.",
        hint: "Check the Worker endpoint address in your app configuration.",
        targetUrl: "",
        startTime,
      });
    }

    const rawTarget = extractTargetUrlParam(requestUrl);

    // 4. Health check response when no ?url= parameter is provided
    if (!rawTarget) {
      return new Response(
        [
          "ReelFlow browser proxy is running.",
          "",
          "Usage:",
          "  GET /?url=<url-encoded http/https target URL>",
          "",
          "Optional query parameters:",
          "  &close=1         Close the browser immediately after this request (0s idle tail)",
          "  &burst=1         Burst mode: disconnect instead of closing, with a 30s idle reaper (alias: &warm=1)",
          "  &debug=1         Show a visible diagnostic header strip at the top of rendered HTML",
          "  &state=<b64url>  Replay captured origin state (cookies + web storage) for the target host",
        ].join("\n"),
        {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    const burstMode =
      (requestUrl.searchParams.get("burst") === "1" ||
        requestUrl.searchParams.get("warm") === "1") &&
      requestUrl.searchParams.get("close") !== "1";
    const forceImmediateClose = !burstMode;
    const forceVisibleDebugBanner = requestUrl.searchParams.get("debug") === "1";
    const rawStateParam = extractStateParam(requestUrl);

    // 5. Validate target URL (must be valid http: or https:, non-recursive, non-private)
    const validation = validateTargetUrl(rawTarget, requestUrl.hostname);
    if (!validation.ok) {
      return buildDiagnosticErrorResponse({
        status: 400,
        title: "Invalid Target URL",
        summary: validation.reason,
        hint: validation.hint,
        targetUrl: rawTarget,
        startTime,
      });
    }

    const targetUrl = validation.parsed.toString();
    const targetHostname = validation.parsed.hostname.toLowerCase();
    const targetOrigin = validation.parsed.origin;

    // 6. Parse and validate optional &state= parameter defensively before launching browser
    const parsedStateResult = parseAndValidateReplayState(
      rawStateParam,
      targetHostname
    );
    let stateReplayHeader = parsedStateResult.replayStatus; // "none" | "invalid" | "host-mismatch" | "applied"

    // 7. Verify Browser Run binding is configured
    if (!env || !env.MYBROWSER) {
      return buildDiagnosticErrorResponse({
        status: 500,
        title: "Missing Browser Run Binding (env.MYBROWSER)",
        summary:
          "The Worker environment does not have the MYBROWSER Browser Run binding attached.",
        hint: "Verify wrangler.jsonc defines the browser binding with binding name 'MYBROWSER'.",
        targetUrl,
        startTime,
        stateReplayHeader,
      });
    }

    let browser = null;
    let page = null;
    let sessionMode = "none";
    let sessionId = null;

    try {
      // 8. Acquire Browser Session (reuse an idle warm session if available, else launch)
      const acquired = await acquireBrowserSession(env.MYBROWSER);
      browser = acquired.browser;
      sessionMode = acquired.mode;
      sessionId = acquired.sessionId;

      // 9. Open and configure a fresh tab
      page = await browser.newPage();
      await configureStealthPage(page, browser);

      // 10. Apply replayed state (cookies + pre-script storage seeding) if valid & matching
      let stateReplayApplied = false;
      if (parsedStateResult.ok && parsedStateResult.state) {
        const appliedOk = await applyReplayStateToPage(
          page,
          parsedStateResult.state,
          targetUrl,
          targetOrigin
        );
        if (appliedOk) {
          stateReplayApplied = true;
          stateReplayHeader = "applied";
        } else {
          stateReplayHeader = "invalid";
        }
      }

      // 11. Navigate with a soft domcontentloaded timeout
      //     Some pages never finish background network streams; a timeout on goto()
      //     must not abort extraction if the DOM is already usable or progressing.
      let gotoTimedOut = false;
      let initialHttpStatus = 0;
      try {
        const response = await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: CONFIG.GOTO_TIMEOUT_MS,
        });
        if (response) {
          initialHttpStatus = response.status();
        }
      } catch (navErr) {
        const msg = String(navErr && navErr.message ? navErr.message : navErr);
        if (/timeout|timed out/i.test(msg)) {
          gotoTimedOut = true;
        } else {
          throw navErr;
        }
      }

      // 12. Run the Readiness Engine (Shield Phase -> Site A Fast-Path Profile or Generic Loop)
      const progression = await drivePageToReadiness(page, {
        gotoTimedOut,
        initialHttpStatus,
        stateReplayApplied,
      });

      // 13. Capture final HTML and URL
      const rawHtml = await safeGetPageContent(page);
      const finalUrl = safeGetPageUrl(page, targetUrl);
      const finalAudit = await inspectPageState(page);

      // Update state-replay status if a gate still appeared despite applied state
      if (
        stateReplayApplied &&
        (progression.gateEverSeen ||
          finalAudit.isGatePresent ||
          finalAudit.hasAppAgeVerification)
      ) {
        stateReplayHeader = "applied-gate-returned";
      }

      // 14. Classify final outcome for tester verification
      const classification = classifyFinalOutcome({
        rawHtml,
        finalAudit,
        progression,
        targetUrl,
        finalUrl,
        startTime,
        sessionMode,
        stateReplayApplied,
        stateReplayHeader,
      });

      // 15. Capture earned session state (Change 2) if readiness succeeded AND
      //     a gate/shield was cleared or state was replayed on this request.
      //     SECURITY NOTE: The captured state is an opaque session credential
      //     that the caller stores on-device only. Never log it or embed it in
      //     the HTML body, diagnostic comment, diagnostic banner, or error pages.
      const shouldCaptureState =
        classification.outcome === "SUCCESS_CONTENT" &&
        (progression.gateEverSeen ||
          progression.shieldEverSeen ||
          stateReplayApplied);

      let stateCaptureResult = {
        status: "none",
        encodedState: null,
        cookieCount: 0,
      };
      if (shouldCaptureState) {
        stateCaptureResult = await captureOriginState(page, targetHostname);
      }

      // 16. Format final HTML output:
      //     - Always embed a non-rendering HTML comment block right after <!DOCTYPE html>
      //       so View Source / inspector immediately reveals what happened.
      //     - If a shield or gate remained stuck (or ?debug=1 was passed), inject a
      //       human-readable visual diagnostic banner at the top of <body> so a
      //       tester looking at a screenshot in the app can immediately tell why.
      const decoratedHtml = decorateReturnedHtml(rawHtml, classification, {
        showBanner:
          forceVisibleDebugBanner || classification.outcome !== "SUCCESS_CONTENT",
      });

      const bodyBytes = new TextEncoder().encode(decoratedHtml).byteLength;
      const elapsedMs = Date.now() - startTime;

      const responseHeaders = {
        ...CORS_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Proxy-Outcome": classification.outcome,
        "X-Proxy-Stop-Reason": classification.stopReason,
        "X-Proxy-Final-Url": finalUrl,
        "X-Proxy-Profile": classification.profileUsed,
        "X-Proxy-Shield-Status": classification.shieldSummary,
        "X-Proxy-Gate-Status": classification.gateSummary,
        "X-Proxy-Age-Component-Present": String(
          Boolean(finalAudit.hasAppAgeVerification)
        ),
        "X-Proxy-Body-Bytes": String(bodyBytes),
        "X-Proxy-Elapsed-Ms": String(elapsedMs),
        "X-Proxy-Browser-Session": sessionMode,
        "X-Proxy-State-Status": stateCaptureResult.status,
        "X-Proxy-State-Cookies": String(stateCaptureResult.cookieCount),
        "X-Proxy-State-Replay": stateReplayHeader,
        "x-browser-mode": burstMode ? "burst" : "hit-and-run",
        "x-browser-reused": String(sessionMode === "reused"),
        "x-gate-clicked": String(progression.gateClickCount > 0),
        "x-challenge": String(classification.outcome === "BLOCKED_BY_SHIELD"),
        ...(progression.gotoTimedOut
          ? { "x-nav-error": "navigation timeout (soft; partial DOM used)" }
          : {}),
        ...(stateCaptureResult.status === "captured" &&
        stateCaptureResult.encodedState
          ? { "X-Proxy-State": stateCaptureResult.encodedState }
          : {}),
      };

      return new Response(request.method === "HEAD" ? null : decoratedHtml, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err) {
      const errorMsg = err && err.message ? err.message : String(err);
      const isQuotaOrRateLimit =
        /429|rate limit|quota|too many|browser time|concurrent/i.test(errorMsg);

      return buildDiagnosticErrorResponse({
        status: isQuotaOrRateLimit ? 429 : 502,
        title: isQuotaOrRateLimit
          ? "Browser Run Quota or Concurrency Limit Reached"
          : "Browser Navigation or Rendering Failed",
        summary: errorMsg,
        hint: isQuotaOrRateLimit
          ? "Cloudflare Free Tier limits concurrent browsers and allows 10 minutes of browser time per day. Wait 15-30 seconds and retry."
          : "Check that the target domain is reachable and uses valid DNS/TLS.",
        targetUrl,
        startTime,
        sessionMode,
        stateReplayHeader,
      });
    } finally {
      // 17. Clean up tab and manage browser session lifetime
      if (page) {
        try {
          await page.close();
        } catch {
          // Ignore if page/browser already closed
        }
      }

      if (browser) {
        if (forceImmediateClose) {
          try {
            await browser.close();
          } catch {
            // Ignore close errors
          }
        } else {
          try {
            browser.disconnect();
            if (ctx && typeof ctx.waitUntil === "function" && sessionId) {
              ctx.waitUntil(
                scheduleIdleBrowserReaper(
                  env.MYBROWSER,
                  sessionId,
                  CONFIG.BURST_IDLE_TTL_MS
                )
              );
            }
          } catch {
            try {
              await browser.close();
            } catch {
              // Ignore
            }
          }
        }
      }
    }
  },
};

/**
 * Extracts the target URL from ?url=..., handling both properly URL-encoded
 * values and unencoded query parameters accidentally appended to the target URL.
 * Ensures Worker-own control flags (&close=1, &burst=1, &warm=1, &debug=1, &state=...)
 * are never swallowed into the target URL.
 */
export function extractTargetUrlParam(requestUrl) {
  const direct = requestUrl.searchParams.get("url");
  if (!direct) return "";

  const rawSearch = requestUrl.search || "";
  const urlMatch = rawSearch.match(/[?&]url=([^]*)/i);
  if (!urlMatch) return direct.trim();

  let tail = urlMatch[1];
  // Strip known Worker-own control flags and &state= if appended to the query string
  tail = tail.replace(
    /&(?:(?:close|debug|burst|warm)=[01]|state=[^&]*)(?=&|$)/gi,
    ""
  );

  // If the caller did NOT percent-encode the target URL and it contained raw '&',
  // reconstruct it cleanly; otherwise use the standard decoded searchParam value.
  if (
    !/%26|%3F|%2F/i.test(tail) &&
    tail.includes("&") &&
    /^https?:\/\//i.test(tail)
  ) {
    try {
      return decodeURIComponent(tail).trim();
    } catch {
      return tail.trim();
    }
  }

  return direct.trim();
}

/**
 * Extracts the optional &state= parameter from the request URL without allowing
 * trailing control flags (&close=1, &burst=1, &warm=1, &debug=1) to be swallowed.
 * Returns null if the parameter was not supplied at all.
 */
export function extractStateParam(requestUrl) {
  if (!requestUrl || !requestUrl.searchParams) return null;
  if (!requestUrl.searchParams.has("state")) return null;
  const raw = requestUrl.searchParams.get("state");
  if (raw === null) return null;
  return raw.trim();
}

/**
 * Validates that the target URL is a syntactically valid http/https address
 * and prevents self-referential loops or local/private network probing.
 */
export function validateTargetUrl(rawTarget, workerHostname) {
  let parsed;
  try {
    parsed = new URL(rawTarget);
  } catch {
    return {
      ok: false,
      reason: `Could not parse "${rawTarget}" as a valid absolute URL.`,
      hint: "Include the full scheme, e.g., https://example.com/page (and URL-encode it when passing as ?url=...).",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Unsupported URL protocol "${parsed.protocol}". Only http: and https: are allowed.`,
      hint: "Change the target URL to start with https:// or http://.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (workerHostname && host === workerHostname.toLowerCase()) {
    return {
      ok: false,
      reason: "Target URL points back to this Worker's own hostname (recursive loop).",
      hint: "Pass the external target website's URL, not the proxy Worker's URL.",
    };
  }

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  ) {
    return {
      ok: false,
      reason: `Target hostname "${host}" resolves to a private or loopback address.`,
      hint: "Only public internet http/https pages can be rendered.",
    };
  }

  return { ok: true, parsed };
}

/**
 * Encodes a JavaScript object into a base64url JSON string.
 *
 * SECURITY NOTE: The encoded state represents a session credential (cookies and
 * web storage) that the caller stores on-device only.
 */
export function encodeStatePayload(stateObj) {
  const json = JSON.stringify(stateObj);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Decodes a base64url string into a parsed JSON object.
 * Returns null if decoding or JSON parsing fails.
 */
export function decodeStatePayload(b64urlString) {
  if (typeof b64urlString !== "string" || b64urlString.length === 0) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(b64urlString)) {
    return null;
  }
  try {
    let base64 = b64urlString.replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4;
    if (pad === 2) base64 += "==";
    else if (pad === 3) base64 += "=";
    else if (pad === 1) return null;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const jsonStr = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Defensively parses and validates the incoming &state= parameter against the
 * v1 schema and checks that its `host` matches the target URL's hostname.
 */
export function parseAndValidateReplayState(rawStateParam, targetHostname) {
  if (rawStateParam === null || rawStateParam === undefined) {
    return { ok: false, replayStatus: "none", state: null };
  }
  if (typeof rawStateParam !== "string" || rawStateParam.length === 0) {
    return { ok: false, replayStatus: "invalid", state: null };
  }

  const decoded = decodeStatePayload(rawStateParam);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { ok: false, replayStatus: "invalid", state: null };
  }

  if (decoded.v !== CONFIG.STATE_SCHEMA_VERSION) {
    return { ok: false, replayStatus: "invalid", state: null };
  }

  if (typeof decoded.host !== "string" || decoded.host.trim().length === 0) {
    return { ok: false, replayStatus: "invalid", state: null };
  }

  if (decoded.cookies !== undefined && !Array.isArray(decoded.cookies)) {
    return { ok: false, replayStatus: "invalid", state: null };
  }

  if (
    decoded.localStorage !== undefined &&
    (typeof decoded.localStorage !== "object" ||
      decoded.localStorage === null ||
      Array.isArray(decoded.localStorage))
  ) {
    return { ok: false, replayStatus: "invalid", state: null };
  }

  if (
    decoded.sessionStorage !== undefined &&
    (typeof decoded.sessionStorage !== "object" ||
      decoded.sessionStorage === null ||
      Array.isArray(decoded.sessionStorage))
  ) {
    return { ok: false, replayStatus: "invalid", state: null };
  }

  if (decoded.host.trim().toLowerCase() !== targetHostname.toLowerCase()) {
    return { ok: false, replayStatus: "host-mismatch", state: null };
  }

  return {
    ok: true,
    replayStatus: "applied",
    state: {
      v: decoded.v,
      host: decoded.host.trim().toLowerCase(),
      capturedAt:
        typeof decoded.capturedAt === "number" ? decoded.capturedAt : 0,
      cookies: Array.isArray(decoded.cookies) ? decoded.cookies : [],
      localStorage: decoded.localStorage || {},
      sessionStorage: decoded.sessionStorage || {},
    },
  };
}

/**
 * Applies validated replay state to the page before navigation:
 *   1. Drops expired cookies and sets remaining cookies via page.setCookie(...).
 *   2. Registers an evaluateOnNewDocument hook that seeds localStorage and
 *      sessionStorage only when window.location.origin matches targetOrigin,
 *      and only once per page load sequence so subsequent in-page navigations
 *      do not overwrite mutations made by the page.
 */
async function applyReplayStateToPage(page, state, targetUrl, targetOrigin) {
  try {
    const nowSec = Date.now() / 1000;
    const nowMs = Date.now();

    const validCookies = [];
    for (const c of state.cookies) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.name !== "string" || !c.name) continue;
      if (typeof c.value !== "string") continue;

      // Drop expired cookies (handle both seconds and milliseconds timestamps;
      // <= 0 or undefined/null denotes a session cookie)
      if (typeof c.expires === "number" && c.expires > 0) {
        const isExpired =
          c.expires >= 1e11 ? c.expires <= nowMs : c.expires <= nowSec;
        if (isExpired) continue;
      }

      const cookieParam = {
        name: c.name,
        value: c.value,
      };
      if (typeof c.domain === "string" && c.domain) {
        cookieParam.domain = c.domain;
      } else {
        cookieParam.url = targetUrl;
      }
      if (typeof c.path === "string" && c.path) cookieParam.path = c.path;
      if (typeof c.expires === "number" && c.expires > 0) {
        cookieParam.expires =
          c.expires >= 1e11 ? Math.floor(c.expires / 1000) : c.expires;
      }
      if (typeof c.httpOnly === "boolean") cookieParam.httpOnly = c.httpOnly;
      if (typeof c.secure === "boolean") cookieParam.secure = c.secure;
      if (
        typeof c.sameSite === "string" &&
        ["Strict", "Lax", "None"].includes(c.sameSite)
      ) {
        cookieParam.sameSite = c.sameSite;
      }
      validCookies.push(cookieParam);
    }

    if (validCookies.length > 0) {
      await page.setCookie(...validCookies);
    }

    const lsEntries = Object.entries(state.localStorage || {}).filter(
      ([k, v]) => typeof k === "string" && typeof v === "string"
    );
    const ssEntries = Object.entries(state.sessionStorage || {}).filter(
      ([k, v]) => typeof k === "string" && typeof v === "string"
    );

    if (lsEntries.length > 0 || ssEntries.length > 0) {
      await page.evaluateOnNewDocument(
        (originToMatch, lsList, ssList) => {
          try {
            if (window.location.origin !== originToMatch) return;
            // Guard against re-applying on subsequent in-page navigations within
            // the same document load sequence using a non-leaking window.name token
            // and an in-memory symbol.
            if (window.__reelflowStorageSeeded) return;
            window.__reelflowStorageSeeded = true;

            const marker = "__rf_seeded_origin__:" + originToMatch;
            if (typeof window.name === "string" && window.name.includes(marker)) {
              return;
            }
            try {
              window.name = window.name
                ? window.name + "|" + marker
                : marker;
            } catch {
              // Ignore window.name restrictions
            }

            for (const [k, v] of lsList) {
              try {
                window.localStorage.setItem(k, v);
              } catch {
                // Ignore quota/security exceptions
              }
            }
            for (const [k, v] of ssList) {
              try {
                window.sessionStorage.setItem(k, v);
              } catch {
                // Ignore quota/security exceptions
              }
            }
          } catch {
            // Ignore pre-navigation storage errors
          }
        },
        targetOrigin,
        lsEntries,
        ssEntries
      );
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Captures the browser's earned session state for the target origin after a
 * gate or shield clearance (or after a state replay to refresh expiration).
 *
 * SECURITY NOTE: This state is an opaque session credential that the caller
 * stores on-device only. It must NEVER be logged or placed in HTML bodies,
 * comments, banners, or error responses.
 */
async function captureOriginState(page, targetHostname) {
  try {
    const rawCookies = await page.cookies();
    const cookies = Array.isArray(rawCookies)
      ? rawCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        }))
      : [];

    const storage = await page.evaluate(() => {
      const local = {};
      const session = {};
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key !== null) {
            local[key] = window.localStorage.getItem(key);
          }
        }
      } catch {
        // Ignore cross-origin or disabled storage errors
      }
      try {
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          if (key !== null) {
            session[key] = window.sessionStorage.getItem(key);
          }
        }
      } catch {
        // Ignore cross-origin or disabled storage errors
      }
      return { localStorage: local, sessionStorage: session };
    });

    const payload = {
      v: CONFIG.STATE_SCHEMA_VERSION,
      host: targetHostname.toLowerCase(),
      capturedAt: Date.now(),
      cookies,
      localStorage: (storage && storage.localStorage) || {},
      sessionStorage: (storage && storage.sessionStorage) || {},
    };

    const encodedState = encodeStatePayload(payload);
    if (encodedState.length > CONFIG.MAX_STATE_HEADER_CHARS) {
      return {
        status: "omitted-too-large",
        encodedState: null,
        cookieCount: cookies.length,
      };
    }

    return {
      status: "captured",
      encodedState,
      cookieCount: cookies.length,
    };
  } catch {
    return {
      status: "error",
      encodedState: null,
      cookieCount: 0,
    };
  }
}

/**
 * Acquires a browser instance from Cloudflare Browser Run:
 *   1. Inspects active sessions via puppeteer.sessions(binding).
 *   2. Attempts to connect to an existing idle session (no active connectionId)
 *      so quick multi-page bursts skip cold-start latency, avoid rate limits,
 *      and preserve cookies/localStorage across consecutive clicks.
 *   3. Falls back to launching a fresh browser with keep_alive: 60_000ms.
 */
async function acquireBrowserSession(browserBinding) {
  try {
    if (typeof puppeteer.sessions === "function") {
      const sessions = await puppeteer.sessions(browserBinding);
      const freeSessions = Array.isArray(sessions)
        ? sessions.filter((s) => s && s.sessionId && !s.connectionId)
        : [];

      for (const candidate of freeSessions) {
        try {
          const connected = await puppeteer.connect(
            browserBinding,
            candidate.sessionId
          );
          return {
            browser: connected,
            mode: "reused",
            sessionId: candidate.sessionId,
          };
        } catch {
          // Session may have just closed or been claimed; try next or launch fresh
        }
      }
    }
  } catch {
    // If listing sessions fails, proceed to fresh launch
  }

  const launched = await launchBrowserWithRetry(browserBinding);
  const launchedSessionId =
    typeof launched.sessionId === "function"
      ? launched.sessionId()
      : launched._sessionId || null;

  return {
    browser: launched,
    mode: "launched",
    sessionId: launchedSessionId,
  };
}

/**
 * Launches a new Cloudflare Browser Run session with a brief retry in case a
 * previous session is in the middle of closing against the concurrency cap.
 */
async function launchBrowserWithRetry(browserBinding) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await puppeteer.launch(browserBinding, {
        keep_alive: CONFIG.KEEP_ALIVE_MS,
      });
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await sleep(1_200);
      }
    }
  }
  throw lastError;
}

/**
 * Reaps an idle browser session after `delayMs` (30s) inside ctx.waitUntil()
 * when burst mode (&burst=1 / &warm=1) is used.
 */
async function scheduleIdleBrowserReaper(browserBinding, sessionId, delayMs) {
  await sleep(delayMs);
  try {
    if (typeof puppeteer.sessions === "function") {
      const sessions = await puppeteer.sessions(browserBinding);
      const match = Array.isArray(sessions)
        ? sessions.find((s) => s && s.sessionId === sessionId)
        : null;

      // If already closed or currently in use by a newer request, leave it alone
      if (!match || match.connectionId) {
        return;
      }
    }

    const idleBrowser = await puppeteer.connect(browserBinding, sessionId);
    const openPages = await idleBrowser.pages();
    // Only close if no active content tabs are open (ignoring default about:blank)
    const activeTabs = openPages.filter(
      (p) => p.url() && p.url() !== "about:blank"
    );
    if (activeTabs.length === 0) {
      await idleBrowser.close();
    } else {
      idleBrowser.disconnect();
    }
  } catch {
    // Session already closed or taken over by another Worker invocation
  }
}

/**
 * Configures realistic browser properties and stealth overrides before navigation
 * so passive JS fingerprinting inside anti-bot shields sees standard desktop
 * Chrome traits rather than raw HeadlessChrome defaults.
 */
async function configureStealthPage(page, browser) {
  await page.setViewport(CONFIG.VIEWPORT);

  let ua = CONFIG.FALLBACK_USER_AGENT;
  try {
    const rawUa = await browser.userAgent();
    if (rawUa && typeof rawUa === "string") {
      ua = rawUa.replace(/HeadlessChrome\//gi, "Chrome/");
    }
  } catch {
    // Use fallback UA
  }

  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
  });

  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
        configurable: true,
      });
      if (!window.chrome) {
        window.chrome = {
          runtime: {},
          loadTimes: () => ({}),
          csi: () => ({}),
          app: {},
        };
      }
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
        configurable: true,
      });
      Object.defineProperty(navigator, "plugins", {
        get: () => [
          { name: "PDF Viewer", filename: "internal-pdf-viewer" },
          { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer" },
          { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer" },
        ],
        configurable: true,
      });
    } catch {
      // Ignore property redefinition errors
    }
  });
}

/**
 * Pure helper that determines whether an inspected DOM state matches the
 * Site A profile fingerprint (<app-age-verification> with its known control).
 */
export function isSiteAProfileState(state) {
  if (!state || !state.hasAppAgeVerification) return false;
  return (
    state.gateStrategy === "site_a_action_ok" ||
    state.gateStrategy === "site_a_inner_text"
  );
}

/**
 * Evaluates whether the inspected DOM has substantial rendered content
 * (including the preserved small-page readiness rule).
 */
export function hasSubstantialDomContent(state) {
  if (!state) return false;
  return (
    (state.htmlLength > 2_200 &&
      (state.textLength > 80 || state.elementCount > 25)) ||
    (state.readyState === "complete" &&
      state.htmlLength > 500 &&
      state.elementCount > 10)
  );
}

/**
 * Site A Fast-Path Profile Gate Phase (Change 1):
 *   Triggered by page fingerprint whenever <app-age-verification> is present
 *   (or during a state-replayed Angular load watching for the component).
 *   - Bounded total budget: ~10s (SITE_A_PROFILE_BUDGET_MS).
 *   - Watch window: if the component never appears within SITE_A_MOUNT_WATCH_MS
 *     and the page has substantial content, treat as already cleared and exit
 *     immediately after a brief settle.
 *   - Clicks div.action.ok (or inner <p>) using trusted coordinate click first,
 *     at most 2 attempts >= 900ms apart.
 *   - Exits as soon as the component is absent on 2 consecutive checks and
 *     >= 1,200ms have elapsed since the click (no whole-DOM stability ticks).
 *   - Early bails ~3s after the 2nd click if the component remains present.
 *   - Returns `fallbackToGeneric: true` if an unexpected error or unrecognized
 *     component state is encountered.
 */
async function runSiteAProfileGatePhase(page, initialState, { loopStart }) {
  const profileStart = Date.now();
  let gateEverSeen = Boolean(
    initialState && initialState.hasAppAgeVerification
  );
  let gateClickCount = 0;
  let firstGateClickAt = 0;
  let lastGateClickAt = 0;
  let lastGateLabelClicked = null;
  let gateClearedAt = null;
  let absentConsecutiveChecks = 0;
  let unrecognizedTicks = 0;
  let noGateSubstantialTicks = 0;

  try {
    let currentState = initialState;

    while (
      Date.now() - profileStart < CONFIG.SITE_A_PROFILE_BUDGET_MS &&
      Date.now() - loopStart < CONFIG.MAX_TOTAL_WAIT_MS
    ) {
      if (!currentState) {
        currentState = await inspectPageState(page);
      }
      const state = currentState;
      currentState = null;

      if (state.contextDestroyed) {
        absentConsecutiveChecks = 0;
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      // If an anti-bot shield unexpectedly appears mid-profile, fall back to generic
      if (state.isShield) {
        return { fallbackToGeneric: true };
      }

      // Case A: <app-age-verification> is currently present in the live DOM
      if (state.hasAppAgeVerification) {
        gateEverSeen = true;
        gateClearedAt = null;
        absentConsecutiveChecks = 0;

        const recognizedControl =
          (state.gateStrategy === "site_a_action_ok" ||
            state.gateStrategy === "site_a_inner_text") &&
          state.gateCoords &&
          state.gateCoords.x > 0 &&
          state.gateCoords.y > 0;

        if (!recognizedControl) {
          unrecognizedTicks += 1;
          // If the component stays in a state the profile does not recognize,
          // fall back to the generic loop (Change 1 item 6).
          if (unrecognizedTicks >= CONFIG.SITE_A_UNRECOGNIZED_MAX_TICKS) {
            return { fallbackToGeneric: true };
          }
          await sleep(CONFIG.POLL_INTERVAL_MS);
          continue;
        }

        unrecognizedTicks = 0;
        const now = Date.now();

        // Click at most 2 times, at least ~900ms apart (Change 1 item 3)
        if (
          gateClickCount < CONFIG.SITE_A_MAX_CLICK_ATTEMPTS &&
          now - lastGateClickAt >= CONFIG.SITE_A_CLICK_COOLDOWN_MS
        ) {
          gateClickCount += 1;
          if (!firstGateClickAt) firstGateClickAt = now;
          lastGateClickAt = now;
          lastGateLabelClicked =
            state.gateLabel || "I am 18 or older - Enter";

          await performGateDismissalClick(page, state, gateClickCount);
          await sleep(CONFIG.POLL_INTERVAL_MS);
          continue;
        }

        // Early bail: both click attempts used and component still present ~3s after last click (Change 1 item 5)
        if (
          gateClickCount >= CONFIG.SITE_A_MAX_CLICK_ATTEMPTS &&
          now - lastGateClickAt >= CONFIG.SITE_A_EARLY_BAIL_MS
        ) {
          return {
            fallbackToGeneric: false,
            profileUsed: "site-a",
            gateEverSeen,
            gateClickCount,
            lastGateLabelClicked,
            gateClearedAt: null,
            stopReason: "age_gate_remained_after_clicks",
          };
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      // If a different (non-Site A) gate appeared, hand off to generic flow
      if (state.isGatePresent) {
        return { fallbackToGeneric: true };
      }

      // Case B: <app-age-verification> is NOT present in the live DOM
      if (gateEverSeen) {
        // Component was clicked and is now absent: count consecutive absent checks (Change 1 item 4)
        absentConsecutiveChecks += 1;
        if (!gateClearedAt) {
          gateClearedAt = Date.now();
        }
        const elapsedSinceClick =
          lastGateClickAt > 0 ? Date.now() - lastGateClickAt : Infinity;

        if (
          absentConsecutiveChecks >= CONFIG.SITE_A_ABSENT_CHECKS_REQ &&
          elapsedSinceClick >= CONFIG.SITE_A_POST_CLICK_MIN_MS
        ) {
          return {
            fallbackToGeneric: false,
            profileUsed: "site-a",
            gateEverSeen: true,
            gateClickCount,
            lastGateLabelClicked,
            gateClearedAt,
            stopReason: "site_a_profile_gate_cleared",
          };
        }
      } else {
        // Component has not appeared yet during bounded mount watch (Change 1 item 2: state-replay case)
        const elapsedMountWatch = Date.now() - profileStart;
        if (
          hasSubstantialDomContent(state) &&
          state.readyState !== "loading"
        ) {
          noGateSubstantialTicks += 1;
        } else {
          noGateSubstantialTicks = 0;
        }

        if (
          elapsedMountWatch >= CONFIG.SITE_A_MOUNT_WATCH_MS &&
          noGateSubstantialTicks >= 2
        ) {
          return {
            fallbackToGeneric: false,
            profileUsed: "site-a",
            gateEverSeen: false,
            gateClickCount: 0,
            lastGateLabelClicked: null,
            gateClearedAt: null,
            stopReason: "site_a_state_replay_cleared",
          };
        }
      }

      await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    return {
      fallbackToGeneric: false,
      profileUsed: "site-a",
      gateEverSeen,
      gateClickCount,
      lastGateLabelClicked,
      gateClearedAt,
      stopReason: gateEverSeen
        ? "age_gate_remained_after_clicks"
        : "timeout_budget_reached",
    };
  } catch {
    // Any unexpected exception in the profile path falls back to generic loop (Change 1 item 6)
    return { fallbackToGeneric: true };
  }
}

/**
 * Core Readiness Coordinator:
 *   - Preserves the generic shield/challenge wait phase and generic gate/stability
 *     loop for unknown hosts (Site C).
 *   - Routes to the Site A fast-path profile (`runSiteAProfileGatePhase`) whenever
 *     the live page contains `<app-age-verification>` (or when state replay is active
 *     on an Angular `<app-root>` page).
 *   - Also exits promptly after the bounded mount watch + brief settle when state
 *     replay has already cleared a page's gate.
 */
async function drivePageToReadiness(
  page,
  { gotoTimedOut, initialHttpStatus, stateReplayApplied = false }
) {
  const loopStart = Date.now();
  let shieldEverSeen = false;
  let shieldClearedAt = null;
  let lastShieldKind = null;

  let gateEverSeen = false;
  let gateClickCount = 0;
  let lastGateClickAt = 0;
  let lastGateLabelClicked = null;
  let gateClearedAt = null;

  let stableTicks = 0;
  let prevHtmlLen = 0;
  let prevTextLen = 0;
  let contentStartTimestamp = Date.now();
  let stopReason = "timeout_budget_reached";
  let profileUsed = "generic";
  let siteAProfileFallbackTriggered = false;

  while (Date.now() - loopStart < CONFIG.MAX_TOTAL_WAIT_MS) {
    const state = await inspectPageState(page);

    // Handle mid-navigation context destruction (common when shields submit & reload)
    if (state.contextDestroyed) {
      stableTicks = 0;
      await sleep(CONFIG.POLL_INTERVAL_MS);
      continue;
    }

    // --- STATE 1: Anti-Bot Shield / Interstitial Active ---
    if (state.isShield) {
      shieldEverSeen = true;
      lastShieldKind = state.shieldKind;
      stableTicks = 0;
      // Reset content timer so post-shield page gets full SPA/gate watch window
      contentStartTimestamp = Date.now();
      await sleep(CONFIG.POLL_INTERVAL_MS);
      continue;
    }

    if (shieldEverSeen && !shieldClearedAt) {
      shieldClearedAt = Date.now();
      contentStartTimestamp = Date.now();
      stableTicks = 0;
    }

    // --- PROFILE FAST-PATH CHECK: Site A (<app-age-verification>) ---
    // Triggers by page fingerprint whenever <app-age-verification> is present
    // (or when state replay is applied on an Angular <app-root> document).
    const shouldEnterSiteAProfile =
      !siteAProfileFallbackTriggered &&
      (state.hasAppAgeVerification ||
        (stateReplayApplied && state.hasAngularRoot));

    if (shouldEnterSiteAProfile) {
      const profileOutcome = await runSiteAProfileGatePhase(page, state, {
        loopStart,
      });
      if (!profileOutcome.fallbackToGeneric) {
        return {
          gotoTimedOut,
          initialHttpStatus,
          profileUsed: profileOutcome.profileUsed || "site-a",
          shieldEverSeen,
          shieldClearedAt,
          lastShieldKind,
          gateEverSeen: profileOutcome.gateEverSeen,
          gateClickCount: profileOutcome.gateClickCount,
          lastGateLabelClicked: profileOutcome.lastGateLabelClicked,
          gateClearedAt: profileOutcome.gateClearedAt,
          stopReason: profileOutcome.stopReason,
          loopElapsedMs: Date.now() - loopStart,
        };
      }
      // Unexpected state or error in profile -> fall back to generic loop seamlessly
      siteAProfileFallbackTriggered = true;
      profileUsed = "generic";
    }

    // --- STATE 2 (Generic): Age-Verification Gate Present ---
    if (state.isGatePresent) {
      gateEverSeen = true;
      gateClearedAt = null;
      stableTicks = 0;

      const now = Date.now();
      const canClickAgain =
        gateClickCount < CONFIG.MAX_GATE_CLICK_ATTEMPTS &&
        now - lastGateClickAt >= CONFIG.GATE_RETRY_COOLDOWN_MS;

      if (canClickAgain) {
        gateClickCount += 1;
        lastGateClickAt = now;
        lastGateLabelClicked =
          state.gateLabel ||
          (state.hasAppAgeVerification ? "<app-age-verification>" : "age-gate");

        await performGateDismissalClick(page, state, gateClickCount);
      }

      await sleep(CONFIG.POLL_INTERVAL_MS);
      continue;
    }

    if (gateEverSeen && !gateClearedAt) {
      gateClearedAt = Date.now();
      stableTicks = 0;
    }

    // --- STATE 3 (Generic): No Shield and No Gate Visible -> Check Hydration & Stability ---
    const timeOnContentMs = Date.now() - contentStartTimestamp;
    const timeSinceGateClickMs =
      lastGateClickAt > 0 ? Date.now() - lastGateClickAt : Infinity;

    const htmlDeltaRatio =
      prevHtmlLen > 0
        ? Math.abs(state.htmlLength - prevHtmlLen) / prevHtmlLen
        : 1;
    const textDelta = Math.abs(state.textLength - prevTextLen);

    prevHtmlLen = state.htmlLength;
    prevTextLen = state.textLength;

    const hasSubstantialDom = hasSubstantialDomContent(state);
    const isDomQuiet = htmlDeltaRatio < 0.02 && textDelta < 25;

    // Wait at least MIN_GATE_WATCH_MS (1,800ms) on the content document so late-mounting
    // SPA gates have time to render before we declare the page ready.
    const passedGateWatchWindow = timeOnContentMs >= CONFIG.MIN_GATE_WATCH_MS;
    const passedPostGateSettle =
      !gateEverSeen || timeSinceGateClickMs >= CONFIG.POST_GATE_SETTLE_MS;

    // If state replay was applied and no gate appeared during the mount window on a
    // substantial page, exit after a brief settle (Change 1.2 / Change 3.4).
    if (
      stateReplayApplied &&
      !gateEverSeen &&
      hasSubstantialDom &&
      passedGateWatchWindow &&
      state.readyState !== "loading"
    ) {
      stopReason = "state_replay_cleared";
      break;
    }

    if (
      hasSubstantialDom &&
      isDomQuiet &&
      passedGateWatchWindow &&
      passedPostGateSettle &&
      state.readyState !== "loading"
    ) {
      stableTicks += 1;
      if (stableTicks >= CONFIG.REQUIRED_STABLE_TICKS) {
        stopReason = gateEverSeen
          ? "gate_cleared_and_dom_settled"
          : shieldEverSeen
            ? "shield_cleared_and_dom_settled"
            : "dom_settled_clean";
        break;
      }
    } else {
      stableTicks = 0;
    }

    await sleep(CONFIG.POLL_INTERVAL_MS);
  }

  return {
    gotoTimedOut,
    initialHttpStatus,
    profileUsed,
    shieldEverSeen,
    shieldClearedAt,
    lastShieldKind,
    gateEverSeen,
    gateClickCount,
    lastGateLabelClicked,
    gateClearedAt,
    stopReason,
    loopElapsedMs: Date.now() - loopStart,
  };
}

/**
 * Self-contained DOM inspection function executed inside the page context via
 * `page.evaluate(inspectDomInPageContext)`. Exported so fixture tests can
 * verify profile detection directly against DOM documents.
 */
export function inspectDomInPageContext() {
  const normalize = (str) =>
    (str || "")
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'")
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const stripPunct = (str) =>
    normalize(str)
      .replace(/[()[\]{}:;,.!?-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const isVisible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity) === 0
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };

  const getCenter = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", inline: "center" });
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  };

  // Search light DOM and any open shadow roots for a selector
  const findElementDeep = (selector, root = document) => {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        const found = findElementDeep(selector, all[i].shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };

  const docEl = document.documentElement;
  const bodyEl = document.body;
  const rawHtml = docEl ? docEl.outerHTML : "";
  const htmlLength = rawHtml.length;
  const visibleText = bodyEl ? bodyEl.innerText || "" : "";
  const textLength = visibleText.trim().length;
  const normText = normalize(visibleText);
  const normTitle = normalize(document.title || "");
  const elementCount = document.querySelectorAll("*").length;
  const hasAngularRoot = Boolean(
    document.querySelector("app-root, [ng-version]")
  );

  // 1. Detect Anti-Bot Shields (BunnyShield & Bot Challenges)
  const isBunnyShield =
    (normText.includes("hold tight") &&
      normText.includes("establishing a secure connection")) ||
    (normText.includes("establishing a secure connection") &&
      normText.includes("request id")) ||
    (normText.includes("submitting") &&
      normText.includes("request id") &&
      htmlLength < 10000) ||
    /bunny-shield|bunnyshield/i.test(rawHtml);

  const isCloudflareOrBotChallenge =
    /^(just a moment|attention required|security check|ddos-guard|checking your browser)/i.test(
      normTitle
    ) ||
    Boolean(
      document.querySelector(
        "#challenge-running, #challenge-stage, #cf-challenge-running, form#challenge-form"
      )
    );

  const isShield = isBunnyShield || isCloudflareOrBotChallenge;
  const shieldKind = isBunnyShield
    ? "BunnyShield"
    : isCloudflareOrBotChallenge
      ? `BotChallenge(${document.title || "interstitial"})`
      : null;

  // 2. Detect Site A: <app-age-verification> custom web component (light DOM + shadow roots)
  const ageComp = findElementDeep("app-age-verification");
  const hasAppAgeVerification =
    Boolean(ageComp) || /<app-age-verification\b/i.test(rawHtml);

  let gateCoords = null;
  let gateLabel = null;
  let gateStrategy = null;

  if (ageComp) {
    const searchRoot = ageComp.shadowRoot || ageComp;
    const actionOk =
      searchRoot.querySelector("div.action.ok") ||
      searchRoot.querySelector(".action.ok") ||
      ageComp.querySelector("div.action.ok") ||
      ageComp.querySelector(".action.ok");

    if (actionOk && isVisible(actionOk)) {
      gateCoords = getCenter(actionOk);
      gateLabel = (actionOk.innerText || "I am 18 or older - Enter")
        .replace(/\s+/g, " ")
        .trim();
      gateStrategy = "site_a_action_ok";
    } else {
      // Search inside <app-age-verification> for the confirm <p> or any matching node
      const innerNodes = Array.from(
        searchRoot.querySelectorAll("p, div, button, span, a")
      );
      const matchNode = innerNodes.find((n) => {
        const nt = normalize(n.innerText || n.textContent);
        return (
          nt === "i am 18 or older - enter" ||
          stripPunct(nt) === "i am 18 or older enter"
        );
      });
      if (matchNode && isVisible(matchNode)) {
        const clickable =
          matchNode.closest(".action.ok, .action, button, a, div") || matchNode;
        gateCoords = getCenter(clickable);
        gateLabel = (matchNode.innerText || matchNode.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        gateStrategy = "site_a_inner_text";
      }
    }
  }

  // 3. Detect All Known Age-Confirmation Control Phrasings Across the DOM
  //    Exact known texts:
  //      - "I am 18 or older - Enter"
  //      - "I'm 18 or older"
  //      - "Enter (I am 18 or older)"
  const EXACT_NORMS = new Set([
    "i am 18 or older - enter",
    "i'm 18 or older",
    "enter (i am 18 or older)",
  ]);
  const PUNCT_STRIPPED_NORMS = new Set([
    "i am 18 or older enter",
    "i'm 18 or older",
    "im 18 or older",
    "enter i am 18 or older",
    "enter i'm 18 or older",
  ]);

  if (!gateCoords) {
    const candidates = Array.from(
      document.querySelectorAll(
        "div.action.ok, .action.ok, button, a, p, div, span, input[type='button'], input[type='submit'], [role='button']"
      )
    );

    // Prefer deepest (most specific) visible matching element
    let bestNode = null;
    let bestDepth = -1;

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const rawLabel =
        el.tagName === "INPUT"
          ? el.value || ""
          : el.innerText || el.textContent || "";
      if (!rawLabel || rawLabel.length > 80) continue;

      const norm = normalize(rawLabel);
      const stripped = stripPunct(rawLabel);

      if (EXACT_NORMS.has(norm) || PUNCT_STRIPPED_NORMS.has(stripped)) {
        let depth = 0;
        let cur = el;
        while (cur) {
          depth += 1;
          cur = cur.parentElement;
        }
        if (depth > bestDepth) {
          bestDepth = depth;
          bestNode = el;
        }
      }
    }

    if (bestNode) {
      const actionWrapper = bestNode.closest(
        "div.action.ok, .action.ok, button, a, [role='button']"
      );
      const targetEl = actionWrapper || bestNode;
      gateCoords = getCenter(targetEl);
      gateLabel = (
        bestNode.innerText ||
        bestNode.textContent ||
        bestNode.value ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      gateStrategy = "normalized_text_match";
    }
  }

  const isGatePresent = Boolean(hasAppAgeVerification || gateCoords);

  return {
    contextDestroyed: false,
    readyState: document.readyState,
    title: document.title || "",
    htmlLength,
    textLength,
    elementCount,
    hasAngularRoot,
    isShield,
    shieldKind,
    hasAppAgeVerification,
    isGatePresent,
    gateCoords,
    gateLabel,
    gateStrategy,
  };
}

/**
 * Inspects the current live DOM inside the browser using `inspectDomInPageContext`.
 */
async function inspectPageState(page) {
  try {
    return await page.evaluate(inspectDomInPageContext);
  } catch {
    // Execution context destroyed during navigation/redirect
    return {
      contextDestroyed: true,
      readyState: "loading",
      title: "",
      htmlLength: 0,
      textLength: 0,
      elementCount: 0,
      hasAngularRoot: false,
      isShield: false,
      shieldKind: null,
      hasAppAgeVerification: false,
      isGatePresent: false,
      gateCoords: null,
      gateLabel: null,
      gateStrategy: null,
    };
  }
}

/**
 * Executes a multi-layered click on the detected age-verification gate:
 *   - Attempt 1: Trusted CDP mouse click (page.mouse.click) at the element's center
 *     coordinates, which fires authentic pointerdown -> mousedown -> pointerup ->
 *     mouseup -> click events that bubble through <p> -> <div class="action ok"> ->
 *     <app-age-verification>.
 *   - Attempt 2+: Pairs coordinate click with in-page synthetic MouseEvent/PointerEvent
 *     dispatch and direct .click() calls on both the wrapper (<div class="action ok">)
 *     and inner <p>/confirm node so Angular zone listeners trigger reliably.
 */
async function performGateDismissalClick(page, state, attemptNumber) {
  try {
    if (state.gateCoords && state.gateCoords.x > 0 && state.gateCoords.y > 0) {
      await page.mouse.move(state.gateCoords.x, state.gateCoords.y);
      await sleep(60);
      await page.mouse.click(state.gateCoords.x, state.gateCoords.y, {
        delay: 45,
      });
    }

    if (attemptNumber >= 2 || !state.gateCoords) {
      await page.evaluate(() => {
        const normalize = (str) =>
          (str || "")
            .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'")
            .replace(/[\u2010-\u2015\u2212]/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const stripPunct = (str) =>
          normalize(str)
            .replace(/[()[\]{}:;,.!?-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const fireFullClickSequence = (el) => {
          if (!el) return;
          const opts = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
          };
          el.dispatchEvent(new PointerEvent("pointerdown", opts));
          el.dispatchEvent(new MouseEvent("mousedown", opts));
          el.dispatchEvent(new PointerEvent("pointerup", opts));
          el.dispatchEvent(new MouseEvent("mouseup", opts));
          el.dispatchEvent(new MouseEvent("click", opts));
          if (typeof el.click === "function") {
            el.click();
          }
        };

        const findElementDeep = (selector, root = document) => {
          const direct = root.querySelector(selector);
          if (direct) return direct;
          const all = root.querySelectorAll("*");
          for (let i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) {
              const found = findElementDeep(selector, all[i].shadowRoot);
              if (found) return found;
            }
          }
          return null;
        };

        // 1. Target Site A's <app-age-verification> explicitly if present
        const ageComp = findElementDeep("app-age-verification");
        if (ageComp) {
          const root = ageComp.shadowRoot || ageComp;
          const actionOk =
            root.querySelector("div.action.ok") ||
            root.querySelector(".action.ok") ||
            ageComp.querySelector("div.action.ok") ||
            ageComp.querySelector(".action.ok");
          if (actionOk) {
            const innerP = actionOk.querySelector("p");
            if (innerP) fireFullClickSequence(innerP);
            fireFullClickSequence(actionOk);
            return;
          }
        }

        // 2. Target any matching age-confirmation text control
        const TARGETS = new Set([
          "i am 18 or older enter",
          "i'm 18 or older",
          "im 18 or older",
          "enter i am 18 or older",
        ]);

        const all = Array.from(
          document.querySelectorAll(
            "div.action.ok, .action.ok, p, button, a, div, span, [role='button']"
          )
        );
        for (const el of all) {
          const text = el.innerText || el.textContent || "";
          if (!text || text.length > 80) continue;
          if (TARGETS.has(stripPunct(text))) {
            fireFullClickSequence(el);
            const wrapper = el.closest("div.action.ok, .action.ok, button, a");
            if (wrapper && wrapper !== el) {
              fireFullClickSequence(wrapper);
            }
            break;
          }
        }
      });
    }
  } catch {
    // Ignore errors if the click immediately triggered a page navigation
  }
}

async function safeGetPageContent(page) {
  for (let i = 0; i < 3; i++) {
    try {
      return await page.content();
    } catch {
      await sleep(300);
    }
  }
  return "<!DOCTYPE html><html><body></body></html>";
}

function safeGetPageUrl(page, fallbackUrl) {
  try {
    return page.url() || fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

/**
 * Evaluates the final captured HTML against the exact success criteria defined
 * for Site A, shields, state replay, and generic gated pages.
 */
function classifyFinalOutcome({
  rawHtml,
  finalAudit,
  progression,
  targetUrl,
  finalUrl,
  startTime,
  sessionMode,
  stateReplayApplied,
  stateReplayHeader,
}) {
  const htmlBytes = new TextEncoder().encode(rawHtml || "").byteLength;
  const hasAgeCompInMarkup =
    Boolean(finalAudit.hasAppAgeVerification) ||
    /<app-age-verification\b/i.test(rawHtml || "");

  const hasBunnyShieldMarkers =
    /Hold tight[\s\S]{0,120}establishing a secure connection/i.test(rawHtml) ||
    (/establishing a secure connection/i.test(rawHtml) &&
      /Request ID/i.test(rawHtml));

  const shieldSummary = finalAudit.isShield
    ? `BLOCKED (${finalAudit.shieldKind || "Shield still active"})`
    : progression.shieldEverSeen
      ? `CLEARED (${progression.lastShieldKind || "Shield"} passed in ${
          (progression.shieldClearedAt || Date.now()) - startTime
        }ms)`
      : "none";

  let gateSummary;
  if (finalAudit.isGatePresent || hasAgeCompInMarkup) {
    gateSummary = `STUCK (${
      hasAgeCompInMarkup
        ? "<app-age-verification> still in HTML"
        : `Gate "${finalAudit.gateLabel || "age-gate"}" still visible`
    } after ${progression.gateClickCount} click attempt(s))`;
  } else if (progression.gateEverSeen) {
    gateSummary = `CLEARED (Clicked "${progression.lastGateLabelClicked}" x${progression.gateClickCount}; gate absent from final HTML)`;
  } else if (stateReplayApplied && stateReplayHeader === "applied") {
    gateSummary = "CLEARED (state replay)";
  } else {
    gateSummary = "none";
  }

  let outcome = "SUCCESS_CONTENT";
  let stopReason = progression.stopReason;
  let humanVerdict =
    "Real page content obtained. No anti-bot shield or age-verification gate remains in the HTML.";

  if (finalAudit.isShield || hasBunnyShieldMarkers) {
    outcome = "BLOCKED_BY_SHIELD";
    stopReason = "shield_did_not_clear_within_budget";
    humanVerdict = `Blocked by ${
      finalAudit.shieldKind || "BunnyShield / anti-bot interstitial"
    } (${htmlBytes.toLocaleString()} bytes). The shield did not complete its verification cycle within the ${
      CONFIG.MAX_TOTAL_WAIT_MS / 1000
    }s window—this indicates the shield either stalled on "Hold tight / Submitting…" or actively refused the Cloudflare Browser Run IP/fingerprint.`;
  } else if (hasAgeCompInMarkup || finalAudit.isGatePresent) {
    outcome = "GATE_STILL_PRESENT";
    stopReason = "age_gate_remained_after_clicks";
    humanVerdict = `Age gate was NOT cleared (${htmlBytes.toLocaleString()} bytes). ${
      hasAgeCompInMarkup
        ? "The <app-age-verification> component is still present in the returned HTML."
        : `The "${finalAudit.gateLabel}" confirmation control remained visible after ${progression.gateClickCount} click attempt(s).`
    }`;
  } else if (htmlBytes < 500 && finalAudit.textLength < 20) {
    outcome = "PARTIAL_OR_EMPTY";
    stopReason = "empty_or_minimal_dom";
    humanVerdict = `Page returned minimal or empty HTML (${htmlBytes} bytes). The target server may have returned an empty body or blocked the connection.`;
  }

  return {
    outcome,
    stopReason,
    humanVerdict,
    profileUsed: progression.profileUsed || "generic",
    shieldSummary,
    gateSummary,
    hasAgeCompInMarkup,
    htmlBytes,
    targetUrl,
    finalUrl,
    sessionMode,
    elapsedMs: Date.now() - startTime,
    gotoTimedOut: progression.gotoTimedOut,
    initialHttpStatus: progression.initialHttpStatus,
  };
}

/**
 * Decorates the returned HTML with:
 *   1. An HTML comment block placed immediately after <!DOCTYPE html> (so it
 *      never triggers browser Quirks Mode) containing diagnostic fields
 *      (including Profile, and strictly excluding any session state values).
 *   2. When a shield or gate is still blocking the page (or ?debug=1 is requested),
 *      a self-contained visual diagnostic banner at the top of <body> so a non-expert
 *      can diagnose the failure directly from a screenshot inside the media app.
 */
function decorateReturnedHtml(rawHtml, info, { showBanner }) {
  const safeComment = (str) => String(str || "").replace(/-->/g, "-- >");

  const commentBlock = [
    "<!--",
    "[BROWSER-PROXY DIAGNOSTIC SUMMARY]",
    `Outcome                   : ${safeComment(info.outcome)}`,
    `Verdict                   : ${safeComment(info.humanVerdict)}`,
    `Profile                   : ${safeComment(info.profileUsed)}`,
    `Target URL                : ${safeComment(info.targetUrl)}`,
    `Final URL                 : ${safeComment(info.finalUrl)}`,
    `Initial HTTP Status       : ${info.initialHttpStatus || "n/a"}${
      info.gotoTimedOut
        ? " (domcontentloaded soft-timed-out; captured partial DOM)"
        : ""
    }`,
    `Captured HTML Size        : ${info.htmlBytes.toLocaleString()} bytes`,
    `Elapsed Time              : ${info.elapsedMs.toLocaleString()} ms (session: ${info.sessionMode})`,
    `Shield Status             : ${safeComment(info.shieldSummary)}`,
    `Age Gate Status           : ${safeComment(info.gateSummary)}`,
    `<app-age-verification>    : ${
      info.hasAgeCompInMarkup ? "PRESENT (FAILURE)" : "ABSENT (OK)"
    }`,
    `Stop Reason               : ${safeComment(info.stopReason)}`,
    "-->",
  ].join("\n");

  let output =
    rawHtml || "<!DOCTYPE html><html><head></head><body></body></html>";

  if (/^(\s*<!DOCTYPE[^>]*>)/i.test(output)) {
    output = output.replace(/^(\s*<!DOCTYPE[^>]*>)/i, `$1\n${commentBlock}`);
  } else {
    output = `<!DOCTYPE html>\n${commentBlock}\n${output}`;
  }

  if (!showBanner) {
    return output;
  }

  const isSuccess = info.outcome === "SUCCESS_CONTENT";
  const accentColor = isSuccess ? "#15803d" : "#b91c1c";
  const bgColor = isSuccess ? "#f0fdf4" : "#fef2f2";
  const borderColor = isSuccess ? "#86efac" : "#fca5a5";

  const bannerHtml = `
<div id="__browser_proxy_diagnostic_banner" style="all:initial;display:block;font-family:system-ui,-apple-system,sans-serif;background:${bgColor};border-bottom:3px solid ${borderColor};color:#111827;padding:14px 18px;font-size:13px;line-height:1.5;z-index:2147483647;position:relative;box-sizing:border-box;">
  <div style="font-weight:700;font-size:14px;color:${accentColor};margin-bottom:4px;">
    Browser Proxy Diagnostic — ${escapeHtml(info.outcome)}
  </div>
  <div style="margin-bottom:6px;color:#1f2937;">
    ${escapeHtml(info.humanVerdict)}
  </div>
  <div style="font-family:ui-monospace,monospace;font-size:12px;color:#374151;display:flex;flex-wrap:wrap;gap:6px 16px;">
    <span><b>Profile:</b> ${escapeHtml(info.profileUsed)}</span>
    <span><b>Size:</b> ${info.htmlBytes.toLocaleString()} B</span>
    <span><b>Shield:</b> ${escapeHtml(info.shieldSummary)}</span>
    <span><b>Age Gate:</b> ${escapeHtml(info.gateSummary)}</span>
    <span><b>&lt;app-age-verification&gt;:</b> ${
      info.hasAgeCompInMarkup ? "PRESENT" : "ABSENT"
    }</span>
    <span><b>Elapsed:</b> ${info.elapsedMs.toLocaleString()} ms (${escapeHtml(
      info.sessionMode
    )})</span>
  </div>
</div>`;

  if (/<body[^>]*>/i.test(output)) {
    output = output.replace(/(<body[^>]*>)/i, `$1${bannerHtml}`);
  } else {
    output = `${bannerHtml}\n${output}`;
  }

  return output;
}

/**
 * Builds a clean, self-contained HTML error page for malformed input or browser
 * errors so a non-expert can diagnose the problem from a screenshot inside the app.
 * Never includes any state values.
 */
function buildDiagnosticErrorResponse({
  status,
  title,
  summary,
  hint,
  targetUrl,
  startTime,
  sessionMode = "none",
  stateReplayHeader = "none",
}) {
  const elapsedMs = Date.now() - startTime;
  const html = `<!DOCTYPE html>
<!--
[BROWSER-PROXY DIAGNOSTIC SUMMARY]
Outcome     : FETCH_ERROR (HTTP ${status})
Profile     : generic
Title       : ${title}
Reason      : ${summary}
Target URL  : ${targetUrl || "(none)"}
Elapsed     : ${elapsedMs} ms
-->
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Proxy Diagnostic: ${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;line-height:1.5;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #cbd5e1;border-left:5px solid #dc2626;border-radius:8px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
    <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#dc2626;margin-bottom:4px;">
      Browser Proxy Diagnostic • HTTP ${status}
    </div>
    <h1 style="margin:0 0 10px 0;font-size:18px;color:#0f172a;">
      ${escapeHtml(title)}
    </h1>
    <p style="margin:0 0 14px 0;font-size:14px;color:#334155;">
      ${escapeHtml(summary)}
    </p>
    <div style="background:#f1f5f9;border-radius:6px;padding:12px 14px;font-size:13px;color:#1e293b;margin-bottom:14px;">
      <strong>How to fix:</strong> ${escapeHtml(hint)}
    </div>
    <div style="font-family:ui-monospace,monospace;font-size:12px;color:#64748b;word-break:break-all;">
      <div>Target URL: ${escapeHtml(targetUrl || "(not provided)")}</div>
      <div>Elapsed: ${elapsedMs} ms • Session: ${escapeHtml(sessionMode)}</div>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Proxy-Outcome": "FETCH_ERROR",
      "X-Proxy-Stop-Reason": title,
      "X-Proxy-Final-Url": targetUrl || "",
      "X-Proxy-Profile": "generic",
      "X-Proxy-Shield-Status": "none",
      "X-Proxy-Gate-Status": "none",
      "X-Proxy-Age-Component-Present": "false",
      "X-Proxy-Body-Bytes": String(new TextEncoder().encode(html).byteLength),
      "X-Proxy-Elapsed-Ms": String(elapsedMs),
      "X-Proxy-Browser-Session": sessionMode,
      "X-Proxy-State-Status": "none",
      "X-Proxy-State-Cookies": "0",
      "X-Proxy-State-Replay": stateReplayHeader,
    },
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}