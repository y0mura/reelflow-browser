// ============================================================
//  ReelFlow browser proxy
// ------------------------------------------------------------
//  A second Worker alongside reelflow-proxy. The existing one
//  fetches a page's HTML directly (fast, no JavaScript, no
//  clicking). This one drives a real headless Chrome on
//  Cloudflare (Browser Run), so it can get past walls that are
//  enforced BEFORE the content is served: anti-bot shield pages
//  (bunny.net, "Just a moment") and age splashes that withhold
//  the page until a cookie is set.
//
//  Contract with the app is identical to reelflow-proxy:
//    GET /?url=<encoded page address>  ->  page HTML + CORS *
//
//  Lifecycle: hit-and-run by default. The Worker's job is to
//  clear the shield/gate and hand ReelFlow the resulting page;
//  ReelFlow then displays that snapshot locally, so the remote
//  browser normally has no reason to remain alive. Add &warm=1
//  only for an explicit burst of page-to-page requests where
//  reuse is worth spending idle browser time.
//
//  Resilience rules (learned from a live Error 1101 outage):
//   - NEVER throw out of the fetch handler. Any failure comes
//     back as a readable 502 text response naming the error,
//     so a failure is diagnosable instead of a bare 1101 page.
//   - Browser acquisition is patient: reuse a free session if
//     one exists; if sessions exist but are all busy, wait for
//     one to free up instead of launching yet another browser
//     (launching into the account's concurrent-browser limit
//     is what threw, on every request, until they expired).
//   - If a run fails mid-flight, CLOSE that browser instead of
//     disconnecting it, so a bad browser is not reused forever.
//   - A navigation timeout is not fatal: continue with
//     whatever part of the page did load.
// ============================================================

import puppeteer from "@cloudflare/puppeteer";

// ---- Per-site gate rules -------------------------------------
// selectors: CSS selectors to try, in order.
// texts:     button/link texts to click if selectors miss.
// waitAfterMs: pause after the last click before reading HTML.
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

// Generic fallback for sites with no rule.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Get a browser without ever making the pileup worse: prefer an
// idle existing session; wait out busy ones; launch only when
// the account has no browsers at all. Returns {browser, reused}
// or throws the last acquisition error after ~30s of patience.
async function acquireBrowser(env, warmMode) {
  let lastErr = null;
  for (let round = 0; round < 6; round++) {
    const sessions = await puppeteer.sessions(env.MYBROWSER);
    const free = sessions.filter((s) => !s.connectionId);
    for (const session of free) {
      try {
        const browser = await puppeteer.connect(
          env.MYBROWSER,
          session.sessionId
        );
        return { browser, reused: true };
      } catch (e) {
        lastErr = e; // died between listing and connecting
      }
    }
    if (sessions.length === 0) {
      try {
        const browser = await puppeteer.launch(env.MYBROWSER, {
          // Only an explicit warm request asks Cloudflare to
          // stretch the idle lifetime after disconnect. The
          // default hit-and-run path closes the browser itself,
          // so no idle tail is wanted: Workers Free Browser Run
          // has only 10 minutes of browser time per day, and a
          // kept-alive browser keeps spending it while idle.
          // Warm mode keeps a deliberately short 2-minute tail,
          // enough for a burst of page fetches seconds apart.
          keep_alive: warmMode ? 120000 : 60000,
        });
        return { browser, reused: false };
      } catch (e) {
        lastErr = e; // e.g. concurrent-browser limit — wait, retry
      }
    }
    // Sessions exist but every one is busy (or launch just
    // failed): wait for the pile to thin instead of adding to it.
    await sleep(5000);
  }
  throw lastErr || new Error("No browser session became available");
}

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
    await sleep(2000);
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

    const reqUrl = new URL(request.url);
    const targetUrl = reqUrl.searchParams.get("url");
    // Hit-and-run is the DEFAULT: do the work, return the page,
    // then CLOSE the browser so browser time is spent only on
    // the work itself. ReelFlow displays the returned page
    // locally; it does not need this remote browser to stay
    // alive while the user reads or uses that page.
    //
    // &warm=1 is the explicit hybrid override for a burst of
    // page-to-page fetches where reuse can amortize launches
    // and shield/gate passes. &close=1 remains accepted as an
    // explicit close request and wins over &warm=1.
    const warmMode =
      reqUrl.searchParams.get("warm") === "1" &&
      reqUrl.searchParams.get("close") !== "1";
    if (!targetUrl) {
      return new Response(
        "ReelFlow browser proxy is running.\n\nUse it like:\n  " +
          reqUrl.origin +
          "/?url=https%3A%2F%2Fexample.com",
        { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } }
      );
    }

    let browser = null;
    let page = null;
    let broken = false;
    try {
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

      const got = await acquireBrowser(env, warmMode);
      browser = got.browser;
      const reused = got.reused;

      // Default browser context on purpose (no
      // createBrowserContext): in warm mode that is what lets
      // the gate cookie / storage persist across requests for
      // as long as this browser stays alive. In the default
      // hit-and-run mode it only needs to persist within this
      // one clearance-and-capture request.
      page = await browser.newPage();

      let navError = "";
      try {
        await page.goto(targetUrl, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
      } catch (e) {
        // A slow or endlessly-chatty page is not fatal — work
        // with whatever loaded.
        navError = String((e && e.message) || e).slice(0, 200);
      }

      // Shield first: if this is an anti-bot check page, give its
      // script time to verify, submit, and load the real page
      // before doing anything else.
      const shieldCleared = await waitOutChallenge(page, 20000);

      // SPA gates can render after the load settles — retry the
      // click a few times over ~2 seconds before giving up.
      let clicked = false;
      for (let attempt = 0; attempt < 4 && !clicked; attempt++) {
        clicked = await clickGate(page, rule);
        if (!clicked && attempt < 3) await sleep(700);
      }
      if (clicked) await sleep(rule.waitAfterMs || 900);

      const html = await page.content();
      return new Response(html, {
        headers: {
          "content-type": "text/html;charset=UTF-8",
          "x-browser-reused": String(reused),
          "x-browser-mode": warmMode ? "warm" : "hit-and-run",
          "x-gate-clicked": String(clicked),
          "x-challenge": String(!shieldCleared),
          ...(navError ? { "x-nav-error": navError } : {}),
          ...CORS,
        },
      });
    } catch (e) {
      // Never surface a bare 1101: name the failure so it can be
      // read (by a human, a screenshot, or a test fetch) and fixed.
      broken = true;
      const msg = (e && e.stack) || String((e && e.message) || e);
      return new Response(
        "ReelFlow browser proxy error:\n\n" + msg.slice(0, 2000),
        {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8", ...CORS },
        }
      );
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) {
        if (broken || !warmMode) {
          // Retire a browser that just failed mid-flight instead
          // of leaving it in the reuse pool. The default
          // hit-and-run path also closes a successful browser
          // immediately so the meter stops when the work is done.
          await browser.close().catch(() => {});
        } else {
          // Explicit warm mode only: disconnect (not close), so
          // the browser and its cookies stay alive briefly for
          // the next request in a page-switching burst.
          await browser.disconnect().catch(() => {});
        }
      }
    }
  },
};
