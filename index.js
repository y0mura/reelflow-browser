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
  // LeakGallery (Angular app): the gate is an <app-age-verification>
  // component and the button is a plain <div class="action ok">
  // wrapping a <p> with the text — not a real <button>, which is
  // why the first version's clicker missed it entirely.
  "leakgallery.com": {
    selectors: ["app-age-verification .action.ok", ".action.ok"],
    texts: ["i am 18 or older - enter"],
    waitAfterMs: 1500,
  },
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

// Anti-bot shield pages (bunny.net BunnyShield, Cloudflare's
// "Just a moment", similar) need time: their script verifies the
// browser, submits, sets a cookie, and only then loads the real
// page. Capturing immediately returns the shield itself — a tiny
// page (~2KB) instead of the site. Poll the visible text until
// the shield wording disappears or the budget runs out.
const CHALLENGE_RX =
  /establishing a secure connection|hold tight|checking your browser|just a moment|verify you are human/i;

async function waitOutChallenge(page, budgetMs) {
  const start = Date.now();
  for (;;) {
    const head = await page
      .evaluate(() =>
        document.body ? document.body.innerText.slice(0, 600) : ""
      )
      .catch(() => "");
    if (!CHALLENGE_RX.test(head)) return true; // cleared (or never was one)
    if (Date.now() - start > budgetMs) return false; // still shielded
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function clickGate(page, rule) {
  // 1. Site-specific / explicit selectors first.
  for (const sel of rule.selectors || []) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click().catch(() => {});
      return true;
    }
  }
  // 2. Click by visible text. Wider net than real buttons only:
  // some gates (LeakGallery) use a plain <div> with the text in a
  // child <p>. Among every element whose full text matches, pick
  // the deepest one (fewest element descendants, gate containers
  // preferred) and click it — the click bubbles up to whatever
  // ancestor actually holds the site's click handler.
  const texts = rule.texts && rule.texts.length ? rule.texts : GENERIC_TEXTS;
  const clicked = await page
    .evaluate((wanted) => {
      const norm = (s) =>
        (s || "")
          .trim()
          .toLowerCase()
          .replace(/[’‘]/g, "'")
          .replace(/[–—]/g, "-")
          .replace(/\s+/g, " ");
      const els = document.querySelectorAll(
        'button, a, input[type="button"], input[type="submit"], [role="button"], .btn, .action, div, span, p, li'
      );
      const hits = [];
      for (const b of els) {
        const t = norm(b.innerText || b.value || "");
        if (wanted.includes(t)) hits.push(b);
      }
      if (!hits.length) return null;
      const inGate = (el) =>
        el.closest(
          '[class*="age" i], [id*="age" i], [class*="verif" i], [class*="modal" i], [class*="overlay" i], [class*="splash" i]'
        )
          ? 0
          : 1;
      hits.sort(
        (x, y) =>
          inGate(x) - inGate(y) ||
          x.querySelectorAll("*").length - y.querySelectorAll("*").length
      );
      const el = hits[0];
      el.click();
      return norm(el.innerText || el.value || "");
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

      // Shield first: if this is an anti-bot check page, give its
      // script time to verify, submit, and load the real page
      // before doing anything else.
      const shieldCleared = await waitOutChallenge(page, 20000);

      // SPA gates can render after the load settles — retry the
      // click a few times over ~2 seconds before giving up.
      let clicked = false;
      for (let attempt = 0; attempt < 4 && !clicked; attempt++) {
        clicked = await clickGate(page, rule);
        if (!clicked && attempt < 3) {
          await new Promise((r) => setTimeout(r, 700));
        }
      }
      if (clicked) {
        await new Promise((r) => setTimeout(r, rule.waitAfterMs || 900));
      }

      const html = await page.content();
      return new Response(html, {
        headers: {
          "content-type": "text/html;charset=UTF-8",
          "x-browser-reused": String(reused),
          "x-gate-clicked": String(clicked),
          "x-challenge": String(!shieldCleared),
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
