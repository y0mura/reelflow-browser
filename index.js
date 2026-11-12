// ============================================================
//  ReelFlow browser proxy — DRAFT, not deployed
// ------------------------------------------------------------
//  A second Worker alongside reelflow-proxy. The existing one
//  fetches a page's HTML directly (fast, no JavaScript, no
//  clicking). This one drives a real headless Chrome on
//  Cloudflare (Browser Run), so it can get past gates that are
//  enforced BEFORE the content is served: age splashes that
//  withhold the page until a cookie is set, and JavaScript
//  challenge pages ("Just a moment…") that a plain fetch can
//  never pass.
//
//  How a site gets "solved": add one entry to SITE_RULES below,
//  keyed by hostname, describing that site's gate (button
//  selectors and/or button texts, in click order). One Worker
//  handles every site — you do NOT need a Worker per site.
//  Sites with no entry get the generic Yes/Enter text-click.
//
//  Contract with the app is identical to reelflow-proxy:
//    GET /?url=<encoded page address>  ->  page HTML + CORS *
//  Differences vs the write-up this was based on:
//   - CORS headers added (without them the app cannot read
//     the response at all — the original snippet omitted them)
//   - session reuse only connects to sessions that are not
//     already connected to another request
//   - gate-clicking starts from the button-text list the app's
//     INJ script uses, extended with your three sites' exact
//     "18 or older" phrases, as a fallback to selectors
// ============================================================

import puppeteer from "@cloudflare/puppeteer";

// ---- Per-site gate rules -------------------------------------
// selectors: CSS selectors to try, in order.
// texts:     button/link texts to click if selectors miss.
// waitAfterMs: pause after the last click before reading HTML.
// Example shape (not a real site):
//   "example-site.com": {
//     selectors: ["button#age-yes", ".age-gate .confirm"],
//     texts: ["I am over 18", "Enter"],
//     waitAfterMs: 1200,
//   },
const SITE_RULES = {
  // add solved sites here, one entry per hostname
};

// Generic fallback for sites with no rule: the same button
// texts the app's in-page INJ script already clicks.
const GENERIC_TEXTS = [
  "yes",
  "i am 18",
  "i'm 18",
  "i am over 18",
  "yes, i am over 18",
  "i am 18 or older - enter",
  "i'm 18 or older",
  "enter (i am 18 or older)",
  "enter",
  "enter site",
  "i agree",
  "agree & enter",
  "accept & continue",
  "confirm age",
  "continue to site",
  "proceed",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

async function clickGate(page, rule) {
  // 1. Site-specific / explicit selectors first.
  for (const sel of rule.selectors || []) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click().catch(() => {});
      return true;
    }
  }
  // 2. Click by visible button text.
  const texts = rule.texts && rule.texts.length ? rule.texts : GENERIC_TEXTS;
  const clicked = await page
    .evaluate((wanted) => {
      const els = document.querySelectorAll(
        'button, a, input[type="button"], input[type="submit"], [role="button"], .btn'
      );
      for (const b of els) {
        const t = (b.innerText || b.value || "")
          .trim()
          .toLowerCase()
          .replace(/[’‘]/g, "'")
          .replace(/[–—]/g, "-")
          .replace(/\s+/g, " ");
        if (wanted.includes(t)) {
          b.click();
          return t;
        }
      }
      return null;
    }, texts)
    .catch(() => null);
  return !!clicked;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const targetUrl = new URL(request.url).searchParams.get("url");
    if (!targetUrl) {
      return new Response(
        "ReelFlow browser proxy is running.\n\nUse it like:\n  " +
          new URL(request.url).origin +
          "/?url=https%3A%2F%2Fexample.com",
        { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } }
      );
    }

    let pageUrl;
    try {
      pageUrl = new URL(targetUrl);
    } catch (e) {
      return new Response("That ?url= value is not a valid web address.", {
        status: 400,
        headers: CORS,
      });
    }
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
      return new Response("Only http and https pages can be fetched.", {
        status: 400,
        headers: CORS,
      });
    }

    const rule = SITE_RULES[pageUrl.hostname.replace(/^www\./, "")] || {};

    let browser;
    let reused = false;

    // Reuse a warm browser if one is idle. Filter to sessions
    // with no live connection — connecting to a busy session
    // collides with the request using it.
    const sessions = await puppeteer.sessions(env.MYBROWSER);
    const free = sessions.filter((s) => !s.connectionId);
    for (const session of free) {
      try {
        browser = await puppeteer.connect(env.MYBROWSER, session.sessionId);
        reused = true;
        break;
      } catch (e) {
        // Session ended between listing and connecting; try next.
      }
    }

    if (!browser) {
      browser = await puppeteer.launch(env.MYBROWSER, {
        keep_alive: 600000, // idle shutdown stretched to 10 minutes
      });
    }

    // Default browser context on purpose (no createBrowserContext):
    // that is what makes the gate cookie / storage persist across
    // requests for as long as this browser stays alive.
    const page = await browser.newPage();
    try {
      await page.goto(targetUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      const clicked = await clickGate(page, rule);
      if (clicked) {
        await new Promise((r) => setTimeout(r, rule.waitAfterMs || 900));
      }

      const html = await page.content();
      return new Response(html, {
        headers: {
          "content-type": "text/html;charset=UTF-8",
          "x-browser-reused": String(reused),
          "x-gate-clicked": String(clicked),
          ...CORS,
        },
      });
    } finally {
      // Close the tab only, then disconnect: the browser (and its
      // cookies) stays alive for the next request.
      await page.close().catch(() => {});
      await browser.disconnect();
    }
  },
};
