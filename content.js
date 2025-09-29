// content.js — overlay UI with animated loading + robust Experience-first extraction + Background list

(function () {
  const OVERLAY_ID = "spa-overlay-host";
  try { document.getElementById(OVERLAY_ID)?.remove(); } catch {}

  // ---------------- utilities ----------------
  const DEBUG = true;
  const log  = (...a) => DEBUG && console.log("[SPA]", ...a);
  const warn = (...a) => DEBUG && console.warn("[SPA]", ...a);
  const err  = (...a) => console.error("[SPA]", ...a);

  const q  = (s, r=document) => r.querySelector(s);
  const qa = (s, r=document) => Array.from(r.querySelectorAll(s));
  const tx = (el) => (el?.textContent || "").trim();
  const norm = (s="") => s.replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitFor(selectors, { timeout = 8000, root = document } = {}) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const start = Date.now();
    for (;;) {
      for (const sel of list) { const el = q(sel, root); if (el) return el; }
      if (Date.now() - start > timeout) return null;
      await sleep(120);
    }
  }
  async function waitForLinkedInReady() {
    await Promise.race([
      waitFor(["main", "section.pv-top-card", "section[id*='experience']"], { timeout: 3500 }),
      sleep(1400)
    ]);
    await sleep(350);
  }

  // ---------------- helpers for Experience parsing ----------------


  
  const BAD_COMPANY_TOKENS = [
    "full-time","part-time","intern","internship","contract","self-employed","freelance",
    "remote","hybrid","on-site","onsite","present","current","today","months","month","years","year",
    "india","netherlands","brazil","portugal","united states","uk","london","amsterdam","pune"
  ];
  const MONTHS_RX = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i;

  function looksLikeCompany(s = "", role = "") {
    const t = norm(s).toLowerCase();
    if (!t) return false;
    if (t === norm(role).toLowerCase()) return false;
    if (t.length < 2 || t.length > 70) return false;
    if (/\d{3,}/.test(t)) return false;                 // avoid phone numbers/dates
    if (MONTHS_RX.test(t)) return false;                // dates like "Jan 2024 – Present"
    if (BAD_COMPANY_TOKENS.some(k => t.includes(k))) return false;
    return true;
  }

  // Clean candidates like "Amplitude · Full-time" -> "Amplitude"
  function cleanCompanyCandidate(s = "", role = "") {
    if (!s) return "";
    const raw = norm(s);
    const parts = raw.split(/[·•|—–-]/).map(p => norm(p)).filter(Boolean);
    for (const seg of parts) if (looksLikeCompany(seg, role)) return seg;
    return looksLikeCompany(raw, role) ? raw : "";
  }

  function guessCompanyFromLi(li, role = "") {
    const candidates = [
      "a[href*='/company/']",
      ".pvs-entity__path-node span[aria-hidden='true']",
      ".pv-entity__secondary-title",
      ".t-14.t-normal",
      ".t-14.t-normal.t-black--light", // dates; cleaner will reject
      "div.inline-show-more-text",
      "h3 a[href*='/company/']",
      "h3"
    ];
    for (const sel of candidates) {
      const cleaned = cleanCompanyCandidate(tx(q(sel, li)), role);
      if (cleaned) return cleaned;
    }

    const block = norm(tx(li));
    if (block) {
      const bulletParts = block.split(/[·•]/).map(norm).filter(Boolean);
      if (bulletParts.length >= 2) {
        const cand = cleanCompanyCandidate(bulletParts[1], role);
        if (cand) return cand;
      }
      const m = /(.*?)(?:\s+at\s+|\s+@+\s+)(.*)/i.exec(block);
      if (m) {
        const cand = cleanCompanyCandidate(m[2], role);
        if (cand) return cand;
      }
    }
    return "";
  }

  function getDatesFromLi(li) {
    const s =
      tx(q(".t-14.t-normal.t-black--light", li)) ||
      tx(q("[class*='date'] .t-14", li)) ||
      "";
    return norm(s);
  }

  // ---------------- PARSERS ----------------

  // Experience-first (current)
  function getFromExperienceFirst() {
    const section =
      q("section[id*='experience']") ||
      Array.from(qa("section")).find((s) => /experience/i.test(tx(q("h2", s)) || tx(q("div", s))));
    if (!section) return { role: "", company: "" };

    const liCurrent = Array.from(section.querySelectorAll("li")).find(li =>
      /(present|presente|atual|current|heute)/i.test(li.textContent || "")
    );
    const li = liCurrent || section.querySelector("li");
    if (!li) return { role: "", company: "" };

    let role =
      norm(tx(li.querySelector(".t-bold span[aria-hidden='true']"))) ||
      norm(tx(li.querySelector("span[aria-hidden='true']"))) ||
      norm(tx(li.querySelector(".mr1.t-bold"))) || "";

    let company = guessCompanyFromLi(li, role);
    if (!company) {
      const headerCand =
        tx(section.querySelector("a[href*='/company/']")) ||
        tx(section.querySelector(".pvs-entity__path-node span[aria-hidden='true']")) ||
        tx(section.querySelector("h3"));
      company = cleanCompanyCandidate(headerCand, role);
    }

    if (company || role) log("experience-first matched:", { role, company });
    return { role, company };
  }

  // JSON-LD Person
  function getFromJsonLD() {
    try {
      const scripts = qa('script[type="application/ld+json"]');
      for (const s of scripts) {
        const txt = s.textContent || "";
        if (!txt || txt.length < 20) continue;
        let obj; try { obj = JSON.parse(txt); } catch { continue; }
        const nodes = Array.isArray(obj) ? obj : [obj, ...(obj["@graph"] || [])];
        for (const node of nodes) {
          if (!node || typeof node !== "object") continue;
          if (node["@type"] === "Person" && (node.jobTitle || node.worksFor)) {
            const role = norm(node.jobTitle || "");
            const company = norm(node?.worksFor?.name || "");
            if (role || company) { log("json-ld matched:", { role, company }); return { role, company }; }
          }
        }
      }
    } catch {}
    return { role: "", company: "" };
  }

  // Headline “Role at Company”
  function parseHeadlineRoleCompany(headline) {
    const h = norm(headline);
    if (!h) return { role: "", company: "" };
    const connectors = [" at ", " @ ", " na ", " no ", " em ", " para ", " chez ", " bei ", " en ", " a ", " presso "];
    for (const c of connectors) {
      const rx = new RegExp(`\\s${c.trim()}\\s`, "i");
      const parts = h.split(rx);
      if (parts.length >= 2) {
        const role = norm(parts[0]); const company = norm(parts.slice(1).join(" "));
        log("headline parse matched:", c.trim(), { role, company });
        return { role, company };
      }
    }
    return { role: "", company: "" };
  }
  function getFromHeadline() {
    const sels = [
      ".pv-text-details__left-panel div.inline-show-more-text",
      ".pv-text-details__left-panel .text-body-medium",
      ".pv-text-details__left-panel span",
      "div.text-body-medium.break-words",
      "[data-anonymize='headline']"
    ];
    for (const sel of sels) {
      const headline = tx(q(sel));
      if (!headline) continue;
      const parsed = parseHeadlineRoleCompany(headline);
      if (parsed.role || parsed.company) { log("headline matched:", sel, parsed); return parsed; }
    }
    return { role: "", company: "" };
  }

  // Top card chips (companies)
  function getFromTopCardChips() {
    const topCard = q("section.pv-top-card") || q(".pv-top-card") || q(".scaffold-layout__main");
    if (!topCard) return { role: "", company: "" };
    const companyLink =
      q("a[href*='/company/']", topCard) ||
      q(".pv-top-card__experience-list a[href*='/company/']", topCard) ||
      q(".pv-text-details__right-panel a[href*='/company/']", topCard) ||
      q(".pv-top-card--experience-list a[href*='/company/']", topCard);
    const company = norm(tx(companyLink));
    const role =
      norm(tx(q(".pv-text-details__left-panel .text-body-medium", topCard))) ||
      norm(tx(q(".pv-text-details__left-panel span", topCard))) || "";
    if (company || role) { log("top-card chips matched:", { role, company }); return { role, company }; }
    return { role, company: "" };
  }

  // Meta/Title fallbacks
  function getFromMeta() {
    const meta = q('meta[property="og:description"]') || q('meta[name="description"]') || q('meta[name="twitter:description"]');
    const d = norm(meta?.getAttribute("content") || "");
    if (!d) return { role: "", company: "" };
    const m = /(.*?)\s+(?:at|@)\s+(.*?)(?:\s*\||$)/i.exec(d);
    if (m) return { role: norm(m[1]), company: norm(m[2]) };
    return { role: "", company: "" };
  }
  function getFromTitle() {
    const t = document.title || "";
    const stripped = t.replace(/\s*\|\s*LinkedIn.*$/i, "");
    const parts = stripped.split(" - ").map(norm);
    if (parts.length >= 3) return { role: parts[1] || "", company: parts[2] || "" };
    return { role: "", company: "" };
  }

  // Generic Experience scan
  function scanExperienceNodes(root) {
    const items = qa("li, .pvs-list__item, .pv-entity__position-group-pager", root);
    let role = "", company = "", matched = null;
    for (const li of items) {
      const blockText = (tx(li) || "").toLowerCase();
      const isCurrent = /(present|presente|atual|current|heute)/i.test(blockText);
      if (!isCurrent) continue;

      const rGuess =
        tx(q("span[aria-hidden='true']", li)) ||
        tx(q(".t-bold", li)) ||
        tx(q(".mr1.t-bold", li)) ||
        tx(q("div.inline-show-more-text", li)) || "";

      const cGuess = guessCompanyFromLi(li, rGuess);

      if (rGuess || cGuess) {
        role = norm(rGuess || role);
        company = norm(cGuess || company);
        matched = li;
        break;
      }
    }
    if (!role && !company && items[0]) {
      const first = items[0];
      role = norm(
        tx(q("span[aria-hidden='true']", first)) ||
        tx(q(".t-bold", first)) ||
        tx(q(".mr1.t-bold", first)) ||
        tx(q("div.inline-show-more-text", first)) || ""
      );
      company = norm(guessCompanyFromLi(first, role));
      matched = first;
    }
    if (role || company) log("experience matched", { role, company, matched });
    return { role, company };
  }
  function getFromExperience() {
    const containers = qa("section[id*='experience'], #experience, .pvs-profile-section");
    let role = "", company = "";
    for (const root of containers) {
      const r = scanExperienceNodes(root);
      role = role || r.role;
      company = company || r.company;
      if (role || company) break;
    }
    return { role, company };
  }

  

  // ---------------- Background list (last 3 roles; then education if needed) ----------------
  function scrapeBackgroundList() {
    const out = [];

    // EXPERIENCE — pick the top 3 visible items
    const expRoot =
      q("section[id*='experience']") ||
      Array.from(qa("section")).find((s) => /experience/i.test(tx(q("h2", s)) || tx(q("div", s))));
    if (expRoot) {
      const items = qa("li, .pvs-list__item, .pv-entity__position-group-pager", expRoot).slice(0, 6);
      for (const li of items) {
        const role =
          norm(tx(li.querySelector(".t-bold span[aria-hidden='true']"))) ||
          norm(tx(li.querySelector(".t-bold"))) ||
          norm(tx(li.querySelector("span[aria-hidden='true']"))) || "";

        const company = guessCompanyFromLi(li, role);
        const dates   = getDatesFromLi(li);

        const line = [role || "", company || ""].filter(Boolean).join(" — ");
        if (line) out.push(dates ? `${line} (${dates})` : line);
        if (out.length >= 3) break;
      }
    }

    // EDUCATION — fill remaining slots
    if (out.length < 3) {
      const eduRoot =
        q("section[id*='education']") ||
        Array.from(qa("section")).find((s) => /education/i.test(tx(q("h2", s)) || tx(q("div", s))));
      if (eduRoot) {
        const items = qa("li, .pvs-list__item", eduRoot).slice(0, 5);
        for (const li of items) {
          const school =
            norm(tx(q("span[aria-hidden='true']", li))) ||
            norm(tx(q("a[href*='/school/']", li))) || "";
          const degree = norm(tx(q(".t-14.t-normal", li))) || "";
          const dates  = getDatesFromLi(li);
          const line = [school || "", degree || ""].filter(Boolean).join(" — ");
          if (line) out.push(dates ? `${line} (${dates})` : line);
          if (out.length >= 3) break;
        }
      }
    }

    return out.slice(0, 3);
  }

  // observe for late hydration
  function observeFor(ms = 2500) {
    return new Promise((resolve) => {
      const section = q("main") || document.body;
      const obs = new MutationObserver(() => {
        const r = attemptExtractOnce();
        if (r.role || r.company) { obs.disconnect(); resolve(r); }
      });
      obs.observe(section, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve({ role: "", company: "" }); }, ms);
    });
  }

  // one-pass try (Experience-first first)
  function attemptExtractOnce() {
    const sources = [
      getFromExperienceFirst,
      getFromJsonLD,
      getFromHeadline,
      getFromTopCardChips,
      getFromExperience,
      getFromMeta,
      getFromTitle
    ];
    let out = { role: "", company: "" };
    for (const fn of sources) {
      const r = fn();
      if (r.role) out.role = out.role || r.role;
      if (r.company) out.company = out.company || r.company;
      if (out.role && out.company) break;
    }
    return out;
  }



  async function extractWithRetries() {
    let out = attemptExtractOnce();
    if (out.role && out.company) return out;
    for (let i = 0; i < 5 && (!out.role || !out.company); i++) {
      await sleep(500);
      const next = attemptExtractOnce();
      out.role = out.role || next.role;
      out.company = out.company || next.company;
      if (out.role && out.company) break;
    }
    if (!out.role || !out.company) {
      const fromObs = await observeFor(2500);
      out.role = out.role || fromObs.role;
      out.company = out.company || fromObs.company;
    }
    return out;


  }


      // --- Mount Robin inside overlay right column ---
  const mountRobin = () => {
    const col = document.getElementById("robin-column");
    if (window.Robin && window.Robin.mountInto && col) {
      window.Robin.mountInto(col);
    } else {
      setTimeout(mountRobin, 200);
    }
  };
  mountRobin();


  // (used for Insights or other parts; kept unchanged)
  function scrapePosts() {
    const out = new Set();
    qa("article[role='article'], .update-components-text").forEach(el => {
      const s = norm(tx(el));
      if (s) out.add(s.slice(0, 400));
    });
    return Array.from(out).slice(0, 6);
  }

  async function scrapeContext() {
    await waitForLinkedInReady();

    const name =
      tx(q("h1")) ||
      tx(q("[data-testid='profile-about'] h1")) ||
      tx(q("div.text-heading-xlarge")) || "";

    const rc = await extractWithRetries();
    let role = rc.role, company = rc.company;

    // final fallback: "Role - Company"
    if (!role || !company) {
      const headline =
        tx(q(".pv-text-details__left-panel span")) ||
        tx(q("div.text-body-medium.break-words")) || "";
      if (headline.includes(" - ")) {
        const parts = headline.split(" - ");
        if (parts.length >= 2) { role = role || norm(parts[0]); company = company || norm(parts[1]); log("dash headline fallback:", { role, company }); }
      }
    }

    const profileLocation =
      tx(q(".pv-text-details__left-panel .t-normal.t-black--light")) ||
      tx(q("span.text-body-small.inline.t-black--light.break-words")) || "";

    const url = window.location.href;
    const pageType = /linkedin\.com\/in\//.test(url) ? "profile"
                  : /linkedin\.com\/company\//.test(url) ? "company" : "unknown";

    const ctx = { pageType, url, name: norm(name), role: norm(role || ""), company: norm(company || ""), location: norm(profileLocation) };
    log("scrapeContext ->", ctx);
    if (!ctx.role || !ctx.company) warn("Unable to fully extract role/company yet. Sources include: Experience-first, JSON-LD, Headline, Chips, Experience, Meta, Title.");
    return ctx;
  }

  // ---------------- overlay UI (unchanged visuals) ----------------
  let host, shadow, isOpen = false;

  // ---- Shared state for AI/email/doc generation (one place only) ----
let lastNews = [];
let lastFin = [];
let lastResp = "";
let lastInsights = [];
let lastBg = [];
let lastPeers = [];



  function buildUI() {
    let lastBg = []; // latest background items (roles/education) for this profile
    const style = document.createElement("style");
    style.textContent = `
      :host{ all:initial; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif }
      @keyframes pop-in{0%{opacity:0;transform:translateY(8px) scale(.98)}100%{opacity:1;transform:none}}
      @keyframes shimmer{0%{background-position:-200px 0}100%{background-position:calc(200px + 100%) 0}}
      .skeleton{position:relative;overflow:hidden;background:#1a2246}
      .skeleton::after{content:"";position:absolute;inset:0;background-image:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.08),rgba(255,255,255,0));background-size:200px 100%;animation:shimmer 1.1s linear infinite;opacity:.6}
      .wrap{position:fixed;inset:0;display:flex;flex-direction:column;overflow:auto;-webkit-overflow-scrolling:touch}
      .backdrop{position:fixed;inset:0;background:rgba(8,10,22,.78);backdrop-filter:blur(8px)}
      .top{position:relative;z-index:1;padding:28px 32px 24px;background:linear-gradient(180deg,#3d0f4b2e,#261335ed 60%, rgba(14,27,59,.6));border-bottom:1px solid rgba(255,255,255,.08)}
      .header {
  display: flex;
  align-items: center;   /* vertical centering of children */
  justify-content: space-between;
  gap: 20px;
}

#fit-banner {
  position: relative !important;  /* remove absolute positioning */
  top: auto !important;
  right: auto !important;
  transform: none !important;
  margin-left: auto;              /* pushes it to the far right */
  max-width: 340px !important;
  text-align: right !important;
  align-self: stretch;            /* take full header height */
  display: flex;
  flex-direction: column;
  justify-content: center;        /* vertically center its content */
}






      .avatar{
  width:108px;height:108px;border-radius:50%;
  display:grid;place-items:center;
  border:3px solid rgba(255,255,255,.18);
  background:radial-gradient(circle at 30% 30%, #2a3c8f, #0f1738 70%);
  box-shadow:0 20px 60px rgba(0,0,0,.45);
  position:relative;
    align-self:center;            /* vertically center in the banner */
}
      .dot{position:absolute;right:6px;bottom:6px;width:14px;height:14px;background:#2ddc7b;border:2px solid #0d1433;border-radius:50%}
      .title{
  flex:1;
  min-width:0;
  color:#fff;
  background:linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.06));
  border:1px solid rgba(255,255,255,.12);
  border-radius:14px;
  padding:18px 20px;
  display:flex;                     /* keep content centered vertically */
  flex-direction:column;
  justify-content:center;
  /* height:100%;  <-- remove this line */
}
      .name{font-size:24px;font-weight:900;letter-spacing:.2px}
      .meta{margin-top:6px;opacity:.9;font-size:13px}
      .close{position:absolute;right:20px;top:20px;width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;font-weight:900;cursor:pointer}
      .grid{position:relative;z-index:1;max-width:1200px;margin:24px auto 640px;display:grid;grid-template-columns:1fr 1fr;gap:18px}
      @media (min-width:1200px){
  /* reserve space only for the cards area on desktop */
  .grid{ padding-right:384px; }  /* 360 + 24 gap */
}



@media (min-width:1200px){
  /* Leave room on the right just for the cards grid, not the banner */
  .grid{ padding-right:384px; } /* 360 + 24 gap */
}


      /* Fixed Robin sidebar on the right */
#spa-sidebar {
  position: fixed;
  right: 24px;
  width: 360px;
  bottom: 0;
  display: flex;
  flex-direction: column;
  z-index: 1;
}

.top {
  position: relative;
}

.grid {
  position: relative;
  z-index: 1;
  max-width: 1200px;
  margin: 24px auto 640px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  padding-right: 384px; /* reserve space for Robin */
}

#spa-sidebar {
  top: calc(var(--banner-height, 200px) + 24px); /* just below banner */
  height: calc(100% - var(--banner-height, 200px) - 24px);
}




      #robin-column{
  width:360px;
  max-width:360px;
  flex:0 0 360px;
}


      .card{background:linear-gradient(180deg,#ab5bff1c,#0f1630);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:14px 16px;color:#fff;box-shadow:0 12px 38px rgba(0,0,0,.5);min-height:220px;display:flex;flex-direction:column;opacity:0;transform:translateY(6px) scale(.98)}
      .card.show{animation:pop-in .35s ease forwards}
      .card__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;opacity:.95}
      .card__title{font-weight:800;font-size:13px;color:#c9d7ff}
      .card__count{font-size:12px;opacity:.8}
      .card__body{overflow:auto;max-height:360px;padding-right:6px}
      .card--accent .card__body{max-height:unset}
      .row{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)}
      .row .dot{position:relative;inset:auto;width:8px;height:8px;border:none;background:#6f6cff;border-radius:50%;margin-top:6px}
      .row .txt{font-size:13px;line-height:1.35}
      .row .content{flex:1}
.row .read-btn{
  margin-left:10px;
  font-size:11px;
  padding:4px 8px;
  border-radius:8px;
  border:1px solid rgba(255,255,255,.18);
  background:rgba(255,255,255,.06);
  color:#fff; cursor:pointer; white-space:nowrap
}
  /* Show ONLY one summary: hide the list's inline summary; keep overlay summary */
#card-news .subtxt { display: none; }
      .chips{display:flex;gap:6px;margin-top:4px}
      .pill{
  font-size:12px;
  padding:4px 10px;
  border-radius:999px;
  background:linear-gradient(90deg,#12d69c,#35e0c0);
  border:none;
  color:#07122c !important;
  font-weight:800;
  text-decoration:none;
}
  .news-links{display:flex; gap:10px; margin-top:8px}
.pill:hover{ filter:brightness(1.06); }
a.pill:link, a.pill:visited{ color:#07122c !important; } /* defeat purple visited color */
      .fit{margin-top:8px;background:rgba(0,0,0,.14);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 12px}
      .badge{font-size:11px;font-weight:800;padding:4px 8px;border-radius:999px;background:#12d69c;color:#0b1431;margin-left:8px}
      #fit-banner {
  color: #fff; /* make all text white inside Fit Summary */
}
#fit-banner .badge {
  color: #0b1431; /* keep badge text dark so it’s readable against green */
}
      .footer{position:fixed;left:0;right:0;bottom:0;z-index:1;display:flex;justify-content:center;padding:20px;background:linear-gradient(180deg, rgba(8,10,22,0), rgba(8,10,22,.92));border-top:1px solid rgba(255,255,255,.08)}
      .cta{min-width:260px;padding:14px 20px;border:none;border-radius:16px;font-weight:900;color:#fff;background:linear-gradient(90deg,#6f6cff,#9b6cff);box-shadow:0 16px 40px rgba(111,108,255,.35);cursor:pointer}
      .muted{opacity:.75}
            /* Accent card (subtle purple outline) */
      /* Purple accent (thicker) */
.card.card--accent{
  border:2px solid rgba(155,108,255,.85);
  box-shadow:0 10px 36px rgba(155,108,255,.24), inset 0 1px 0 rgba(155,108,255,.35);
}

/* Green accent (for Job Responsibilities) */
.card.card--accent-green{
  border:2px solid rgba(18,214,156,.95);
  box-shadow:0 10px 36px rgba(18,214,156,.28), inset 0 1px 0 rgba(18,214,156,.38);
}
  /* Fit Summary outline colors (match badge) */
#fit-banner.fit--low{
  border:2px solid rgba(255,107,107,.95);
  box-shadow:0 10px 36px rgba(255,107,107,.28), inset 0 1px 0 rgba(255,107,107,.36);
}
#fit-banner.fit--medium{
  border:2px solid rgba(18,214,156,.95);
  box-shadow:0 10px 36px rgba(18,214,156,.28), inset 0 1px 0 rgba(18,214,156,.36);
}
#fit-banner.fit--high{
  border:2px solid rgba(90,163,255,.95);
  box-shadow:0 10px 36px rgba(90,163,255,.28), inset 0 1px 0 rgba(90,163,255,.36);
}
#fit-banner.fit--highest{
  border:2px solid rgba(255,209,102,.95);
  box-shadow:0 10px 36px rgba(255,209,102,.28), inset 0 1px 0 rgba(255,209,102,.36);
}

/* make the badge color follow the level too */
#fit-banner.fit--low .badge{ background:#ff6b6b; color:#0b1431; }
#fit-banner.fit--medium .badge{ background:#12d69c; color:#0b1431; }
#fit-banner.fit--high .badge{ background:#5aa3ff; color:#0b1431; }
#fit-banner.fit--highest .badge{ background:#ffd166; color:#0b1431; }

      .email-box{
        white-space:pre-wrap;
        font-size:13px; line-height:1.45;
        background:rgba(255,255,255,.04);
        border:1px solid rgba(155,108,255,.35);
        border-radius:12px;
        padding:12px;
        min-height:120px;
      }
      .email-actions{display:flex;gap:8px;margin-top:12px}
      .btn{
        padding:10px 14px;border-radius:10px;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(255,255,255,.06);
        color:#fff; cursor:pointer; font-weight:700
      }
      .btn--primary{
        background:linear-gradient(90deg,#6f6cff,#9b6cff);
        border-color:transparent
      }
      
      /* --- Responsibilities overlay support --- */
 .card__head .expand-btn{
  margin-left:8px;
  font-size:12px;
  padding:6px 10px;
  border-radius:8px;
  border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.06);
  color:#fff; cursor:pointer; font-weight:700;
 }
  #fit-banner .expand-btn{
  margin-left:10px;
  font-size:12px; padding:6px 10px; border-radius:8px;
  border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.06);
  color:#fff; cursor:pointer; font-weight:700;
}


/* Expanded Responsibilities card sizing */
.card--overlay{
  width:min(1100px, calc(100% - 48px));
  height:72vh;
  box-shadow:0 24px 70px rgba(0,0,0,.55);
}
.card--overlay .card__body{
  max-height: calc(72vh - 60px);
}

/* Compact overlay sizing for the News card */
.card--overlay-news{
  width: min(720px, calc(100% - 48px)); /* narrower than full overlay */
  height: auto;                         /* grow with content */
  max-height: 56vh;                     /* cap height */
  box-shadow: 0 24px 70px rgba(0,0,0,.55);
}
.card--overlay-news .card__body{
  max-height: calc(56vh - 60px);        /* keep header visible; body scrolls if long */
}
  /* Fit Summary becomes a card when expanded */
#fit-banner.card{
  background: linear-gradient(180deg,#ab5bff1c,#0f1630) !important;
  text-align: left !important;
  margin-left: 0 !important;
  max-width: none !important;
}
#fit-banner.card--overlay{
  max-height:72vh;
  overflow:auto;
}

  /* Fit Summary becomes a card when expanded; give it scroll */
#fit-banner.card--overlay{
  max-height:72vh;
  overflow:auto;
}
/* Full-screen container used only when Responsibilities is expanded */
.overlay-modal{
  position:fixed;
  inset:0;
    right: 380px;           /* reserve space for Robin sidebar */
  display:none;                 /* hidden by default */
  z-index:9998;
  display:none;
  place-items:center;           /* center horizontally & vertically */
}
.overlay-modal.show{ display:grid; }

/* Allow interaction with the card while the modal blocks the page */
.overlay-modal .card{ pointer-events:auto; }

    `;
    shadow.appendChild(style);

    // === PATCH: keep banner compact, restore avatar circle, dock Robin to the right ===
{
  const patch = document.createElement("style");
  patch.textContent = `
    /* Fit Summary stays compact in the header (full text in expanded card only) */
    #fit-banner { max-width: 340px; }
    #fit-summary { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
    #fit-reco    { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

    /* Avatar: circular badge with an initial inside */
    .avatar .initial{ font-size:44px; line-height:1; font-weight:900; color:#fff; }

    /* Robin sidebar: always docked to the window’s right edge (prevents overlap) */
    #spa-sidebar{ position:fixed !important; right:24px !important; left:auto !important; width:360px !important; z-index:1; }
  `;
  shadow.appendChild(patch);
}


    // --- layout fixes: center header, keep Fit Summary inside header and vertically centered,
// and stop reserving space on the right so the cards can center under the banner.
{
  const fix = document.createElement("style");
  fix.textContent = `
    .header{
      justify-content:center !important;      /* center the avatar+name block */
      position:relative !important;           /* allow fit banner to be absolutely positioned */
      gap:20px;
    }
    /* Fit Summary stays inside the header, vertically centered, on the right edge */
    #fit-banner{
  position:relative !important;      /* stay inside header flow */
  margin-left:20px !important;       /* small gap from the avatar/name block */
  align-self:center !important;      /* vertically center inside header */
  max-width:420px !important;        /* allow it to grow/shrink with content */
  flex-shrink:1 !important;          /* shrink if space is tight */
}

    /* Make sure the avatar+name block can occupy center naturally */
    .title{
      flex: 0 1 720px !important;   /* flexible but not pushing the center off */
      min-width: 0 !important;
    }
    /* Do NOT reserve space on the right inside the grid; we’ll place Robin separately */
    @media (min-width:1200px){
      .grid{ padding-right:0 !important; }
    }
  `;
  shadow.appendChild(fix);

// Let Fit Summary expand/shrink with content but never overlap the Close button
{
  const nudge = document.createElement("style");
  nudge.textContent = `
    /* leave space for the Close button on the far right */
    .header{
  justify-content:center !important;
  position:relative !important;
  gap:20px;
}
#fit-banner{
  position:relative !important;      /* stay inside header flow */
  margin-left:20px !important;       /* small gap from the avatar/name block */
  align-self:center !important;      /* vertically center inside header */
  max-width:420px !important;        /* allow it to grow/shrink with content */
  flex-shrink:1 !important;          /* shrink if space is tight */
}


  `;
  shadow.appendChild(nudge);
}




  
}


    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <div class="backdrop"></div>
      <div class="top">
      <div class="header">
  <div class="avatar" id="spa-avatar">
  <div class="initial">?</div>
  <span class="dot"></span>
</div>


  <div class="title" style="flex:1">
      <div class="brand-banner" style="font-weight:900;text-transform:uppercase;letter-spacing:.06em;opacity:.9;font-size:11px;margin-bottom:4px;color:#A27EBF">Threadline</div>

      <div style="margin:4px 0 6px 0">
  <a id="cta-open-webapp" href="http://127.0.0.1:5500/webapp/index.html" target="_blank" rel="noopener"
     style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;
            font-size:11px;font-weight:800;border:1px solid rgba(255,255,255,.22);
            background:rgba(255,255,255,.08);color:#fff;text-decoration:none;">
    <span>View in Threadline App</span>
    <span style="opacity:.8">↗</span>
  </a>
  <label id="dbg-wrap" style="margin-left:12px;display:inline-flex;align-items:center;gap:6px;">
  <input type="checkbox" id="spa-debug-toggle" style="transform:scale(1.15)" />
  <span style="font-size:11px;opacity:.85">Debug logs</span>
</label>

</div>


    <div class="name" id="spa-name">Prospect Name</div>
    <div class="meta"><span id="spa-role">—</span> • <span id="spa-company">—</span> • <span id="spa-location">—</span></div>
  </div>

  <!-- NEW Fit Summary banner block -->
  <div id="fit-banner" style="margin-left:auto; text-align:right; max-width:340px; background:rgba(255,255,255,.04); border-radius:12px; padding:12px 14px;">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
    <div style="font-weight:800;font-size:13px;opacity:.9">
      Fit Summary <span class="badge" id="fit-badge">—</span>
    </div>
    <button class="expand-btn" id="expand-fit">Expand</button>
  </div>
  <div id="fit-summary" style="margin-top:6px;font-size:13px;line-height:1.35;opacity:.95">Loading…</div>
  <div style="margin-top:10px;font-size:12px;opacity:.9">⚡ Recommended Action</div>
  <div id="fit-reco" style="font-size:13px;line-height:1.35;opacity:.95">Loading…</div>
</div>


  <button class="close" id="spa-close">×</button>
</div>

      </div>

      <main class="grid">
      
     <aside id="spa-sidebar">
  <div id="robin-column"></div>
</aside>



<section class="card" id="card-action-plan" style="grid-column: 1 / -1;">
  <div class="card__head">
    <div class="card__title">Action Plan</div>
  </div>
  <div class="card__body">
    <div id="plan-paragraph" style="font-size:18px; line-height:1.5; opacity:.95;">—</div>
    <ul id="plan-bullets" style="margin-top:10px; padding-left:15px;"></ul>
    <div id="plan-cta-label"
     style="margin-top:20px; font-size:11px; letter-spacing:.08em; text-transform:uppercase; opacity:.7;">
  Next Step
</div>
    <div id="plan-cta" style="margin-top:20px; font-weight:700; font-size:15px; line-height:1.6; opacity:.98;">—</div>
  </div>
</section>



        <section class="card" id="card-news">
          <div class="card__head">
  <div class="card__title">News & Media</div>
  <div style="display:flex;align-items:center;gap:8px">
    <div class="card__count" id="count-news">Loading…</div>
    <button class="expand-btn" id="news-collapse" style="display:none; position:relative; z-index:10000">Close</button>
  </div>
</div>
          <div class="card__body" id="body-news"></div>
        </section>

        <section class="card card--accent-green" id="card-resp">
          <div class="card__head">
  <div class="card__title">Job Responsibilities</div>
  <div style="display:flex;align-items:center;gap:8px">
    <div class="card__count" id="count-resp">Loading…</div>
    <button class="expand-btn" id="expand-resp">Expand</button>
  </div>
</div>
          <div class="card__body" id="body-resp">
            <div id="list-resp"></div>
          </div>
        </section>



<section class="card" id="card-peers">
  <div class="card__head">
  <div class="card__title">Relevant Peers</div>
  <div style="display:flex;align-items:center;gap:8px">
    <div class="card__count" id="count-peers">Loading…</div>
    <button class="expand-btn" id="expand-peers">Expand</button>
    <button class="expand-btn" id="peers-copy">Copy</button>
    <button class="expand-btn" id="peers-reload">Regenerate</button>
  </div>
</div>

  <div class="card__body" id="body-peers"></div>
</section>


        <section class="card" id="card-insights">
        

          <div class="card__head"><div class="card__title">Insights</div><div class="card__count" id="count-ins">Loading…</div></div>
          <div class="card__body" id="body-ins"></div>
        </section>

        <section class="card" id="card-bg">
          <div class="card__head"><div class="card__title">Background</div><div class="card__count" id="count-bg">Loading…</div></div>
          <div class="card__body" id="body-bg"></div>
        </section>

        <section class="card" id="card-fin">
          <div class="card__head"><div class="card__title">Financial Overview</div><div class="card__count" id="count-fin">Loading…</div></div>
          <div class="card__body" id="body-fin"></div>
        </section>


                <section class="card card--accent" id="card-email">
          <div class="card__head">
            <div class="card__title">AI Email Generation</div>
            <div class="card__count" id="count-email">Loading…</div>
          </div>
          <div class="card__body">
            <div class="email-box" id="email-text">Preparing email…</div>
            <div class="email-actions">
              <button class="btn btn--primary" id="email-regenerate">Regenerate</button>
              <button class="btn" id="email-copy">Copy</button>
                            <button class="btn" id="email-send">Send Email</button>

              <button class="btn btn--primary" id="gen-sales-files">Generate Sales Files</button>
            </div>
          </div>
        </section>
      </main>
      <div class="overlay-modal" id="resp-modal"></div>

    `;
    shadow.appendChild(wrap);

    // Debug toggle wiring
{
  const dbg = shadow.getElementById("spa-debug-toggle");
  if (dbg) {
    chrome.storage.sync.get({ debug_logs: false }, (r) => { dbg.checked = !!r.debug_logs; });
    dbg.addEventListener("change", () => {
      chrome.storage.sync.set({ debug_logs: !!dbg.checked });
    });
  }
}


    // --- position Robin sidebar relative to the centered grid and align its top with the first card row
{
  const sidebar = shadow.getElementById("spa-sidebar");
  const grid    = shadow.querySelector("main.grid");
  const topWrap = shadow.querySelector(".top");

  function placeSidebar(){
  if (!sidebar || !grid) return;
  const gridRect = grid.getBoundingClientRect();
  sidebar.style.position = "fixed";
  sidebar.style.top   = `${Math.round(gridRect.top)}px`; // align with cards’ top
  sidebar.style.right = "24px";                          // stick to window edge
  sidebar.style.left  = "auto";                          // never compute 'left'
  sidebar.style.height = `calc(100% - ${Math.round(gridRect.top)}px - 24px)`; // keep a small bottom margin
  sidebar.style.width  = "360px";
}


  // make sure the CSS var the old rules referenced is accurate (used nowhere else now, but safe)
  if (topWrap && shadow.host && topWrap.offsetHeight) {
    shadow.host.style.setProperty("--banner-height", `${topWrap.offsetHeight}px`);
  }

  // place now and on resize/scroll
  placeSidebar();
  window.addEventListener("resize", placeSidebar);
  window.addEventListener("scroll", placeSidebar);
}


    // Ensure the right column is a fixed sidebar
{
  const styleSidebar = document.createElement("style");
  styleSidebar.textContent = `
    #robin-column{ width:360px; max-width:360px; flex:0 0 360px; }
  `;
  shadow.appendChild(styleSidebar);
}


    // --- Ensure Robin is mounted inside the right column, even if it booted early ---


    

// --- Mount Robin inside overlay right column (SHADOW DOM AWARE + RELOCATE) ---
(function mountRobin() {
  try {
    // 1) our shadow root + column
    const col =
      (shadow && shadow.getElementById && shadow.getElementById("robin-column")) ||
      (shadow && shadow.querySelector && shadow.querySelector("#robin-column"));

    // 2) if bot already exists anywhere in shadow, MOVE it under #robin-column (same as your console)
    const existingBot =
      (shadow && shadow.getElementById && shadow.getElementById("spa-chatbot-host")) ||
      (shadow && shadow.querySelector && shadow.querySelector("#spa-chatbot-host"));

    if (col && existingBot && existingBot.parentElement !== col) {
      console.log("[DEBUG] Relocating existing Robin into #robin-column");
      col.appendChild(existingBot);     // <— this is the exact console move
      return;
    }

    // 3) otherwise call the global mount API once it exists
    if (window.Robin && typeof window.Robin.mountInto === "function" && col) {
      console.log("[DEBUG] Mounting Robin into #robin-column");
      window.Robin.mountInto(col);
    } else {
      console.log("[DEBUG] Robin not ready or column missing, retrying…");
      setTimeout(mountRobin, 200);
    }
  } catch (e) {
    console.error("[DEBUG] mountRobin error:", e);
    setTimeout(mountRobin, 400);
  }
})();




        // Quick purple accent override for primary buttons
    {
      const styleOverride = document.createElement("style");
      styleOverride.textContent = `
        .btn--primary{
          background: linear-gradient(90deg,#8B5DB5,#9C6AB0) !important;
        }
      `;
      shadow.appendChild(styleOverride);
    }

    Array.from(shadow.querySelectorAll(".card")).forEach((c, i) => setTimeout(()=>c.classList.add("show"), 90*i));
  }

  function setList(shadowRoot, bodySel, countSel, items, fallbackMsg) {
    const body = shadowRoot.querySelector(bodySel);
    const countEl = shadowRoot.querySelector(countSel);
    body.innerHTML = "";
    if (!items || items.length === 0) {
      body.innerHTML = `<div class="row"><span class="dot"></span><div class="content"><div class="txt">${fallbackMsg || "No data available."}</div></div></div>`;
      countEl.textContent = `0 items`;
      return;
    }
    
    if (bodySel === "#body-news" || bodySel === "#body-fin") {
  const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[m]));
  const hostOf = (u="") => { try { return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; } };

  items.forEach((it, i) => {
    const title   = (it && typeof it === "object") ? (it.title || it.label || "") : String(it || "");
    const summary = (it && typeof it === "object") ? (it.summary || "") : "";
    const link    = (it && typeof it === "object") ? (it.link || it.url || "") : "";
    const host    = hostOf(link) || "Source";

    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <span class="dot"></span>
      <div class="content">
        <div class="headline">${esc(title)}</div>
        ${summary ? `<div class="subtxt" style="margin-top:4px">${esc(summary)}</div>` : ""}
        ${link ? `<div class="news-links" style="margin-top:8px"><a class="pill" href="${esc(link)}" target="_blank" rel="noopener">${esc(host)} →</a></div>` : ""}
      </div>
      <button class="read-btn" data-idx="${i}">Read</button>
    `;
    body.appendChild(row);
  });

  countEl.textContent = `${items.length} items`;
  return; // done
}


// default for the other cards
items.forEach(ti => {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<span class="dot"></span><div class="content"><div class="txt">${ti}</div></div>`;
  body.appendChild(row);
});

    countEl.textContent = `${items.length} items`;
  }

  async function openOverlay() {
    if (isOpen) return;
    isOpen = true;

    document.documentElement.dataset._spaPrevOverflow = document.documentElement.style.overflow || "";
    document.documentElement.style.overflow = "hidden";

    const hostDiv = document.createElement("div");
    hostDiv.id = OVERLAY_ID;
    hostDiv.style.position = "fixed";
    hostDiv.style.inset = "0";
    hostDiv.style.zIndex = "2147483647";
    document.documentElement.appendChild(hostDiv);

    const root = (host = hostDiv).attachShadow({ mode: "open" });

    // Size bump for overlay cards (+10%), without touching Robin
const styleBump = document.createElement('style');
styleBump.textContent = `
  /* Slightly larger cards in overlay */
  .card { 
    padding: 18px !important;       /* was ~16px */
    border-radius: 18px !important; /* was 16px */
  }
  /* If your overlay uses a 2-col grid, make right column a bit wider */
  
  /* Tighten gaps proportionally */
  .cards, .grid, .stack { gap: 18px !important; } /* was ~16px */

  /* Do NOT scale Robin frame; target only host if needed */
  #spa-chatbot-host, #spa-chatbot-host * { transform: none !important; }
`;
root.appendChild(styleBump);





    shadow = root;
    buildUI();

// --- universal collapse on backdrop click + central registration of collapse handlers ---
const modalHost = root.getElementById("resp-modal");
let collapseRespRef = null;
let collapseFitRef  = null;
let collapseNewsRef = null;
let collapsePeersRef = null;


modalHost.addEventListener("click", (e) => {
  if (e.target !== modalHost) return; // only when the dark backdrop is clicked
  const respOpen  = !!root.getElementById("card-resp")?.classList.contains("card--overlay");
  const fitOpen   = !!root.getElementById("fit-banner")?.classList.contains("card--overlay");
  const newsOpen  = !!root.getElementById("card-news")?.classList.contains("card--overlay-news");
  const peersOpen = !!root.getElementById("card-peers")?.classList.contains("card--overlay");
  if (respOpen  && typeof collapseRespRef  === "function") return collapseRespRef();
  if (fitOpen   && typeof collapseFitRef   === "function") return collapseFitRef();
  if (newsOpen  && typeof collapseNewsRef  === "function") return collapseNewsRef();
  if (peersOpen && typeof collapsePeersRef === "function") return collapsePeersRef();
});


// allow card modules to register their collapse functions
root.__setCollapseHandlers = (resp, fit, news) => {
  if (typeof resp === "function") collapseRespRef = resp;
  if (typeof fit  === "function") collapseFitRef  = fit;
  if (typeof news === "function") collapseNewsRef = news;
};


    const ctx    = await scrapeContext();
    const posts  = scrapePosts();

    // HEADER
    root.getElementById("spa-name").textContent     = ctx.name || "Prospect";
    root.getElementById("spa-role").textContent     = ctx.role || "—";
    root.getElementById("spa-company").textContent  = ctx.company || "—";
    root.getElementById("spa-location").textContent = ctx.location || "—";

    // Log a "search/view" event to Supabase (for dashboard metrics)
    try {
      chrome.runtime.sendMessage({
        type: "SPA_ACTIVITY_LOG",
        payload: {
          event: "profile_view",
          prospect_url: ctx.url || "",
          prospect_name: ctx.name || "",
          prospect_company: ctx.company || ""
        }
      }, (resp) => {
        // no-op; dashboard will read activity_log
      });
    } catch {}


    root.getElementById("spa-avatar").querySelector(".initial").textContent =
  (ctx.name || "P").charAt(0).toUpperCase();


    // Skeletons
    const sk = (sel, rows=4) => { const b = root.querySelector(sel); b.innerHTML = ""; for (let i=0;i<rows;i++){ const d=document.createElement("div"); d.className="skeleton"; d.style.height="14px"; d.style.margin="8px 0"; d.style.borderRadius="6px"; b.appendChild(d);} };
    sk("#body-news",5); sk("#list-resp",3); sk("#body-bg",5); sk("#body-fin",4); sk("#body-ins",4);
    
    sk("#body-peers",4);


      // Background: robust load with retries + cache + safe AI overlay
    (async function loadBgWithRetries(){
      const cacheKey = "bg_cache::" + (ctx.url || location.href);

      // 1) try multiple passes to wait for LinkedIn hydration
      let list = scrapeBackgroundList();
      for (let i = 0; i < 6 && (!list || !list.length); i++) {
        await sleep(350);
        list = scrapeBackgroundList();
      }
      if ((!list || !list.length) && typeof MutationObserver !== "undefined") {
        list = await new Promise((resolve) => {
          const host = q("main") || document.body;
          const mo = new MutationObserver(() => {
            const got = scrapeBackgroundList();
            if (got && got.length) { mo.disconnect(); resolve(got); }
          });
          mo.observe(host, { childList: true, subtree: true });
          setTimeout(() => { mo.disconnect(); resolve([]); }, 2500);
        });
      }

      // 2) if still empty, use cached last-good list (if any)
      if (!list || !list.length) {
        try {
          chrome.storage.local.get(cacheKey, (obj) => {
            const cached = obj && obj[cacheKey];
            if (Array.isArray(cached) && cached.length) {
              setList(root, "#body-bg", "#count-bg", cached, "No background information available.");
              lastBg = cached.slice(0);
            } else {
              setList(root, "#body-bg", "#count-bg", [], "No background information available.");
              lastBg = [];
            }
          });
        } catch {
          setList(root, "#body-bg", "#count-bg", [], "No background information available.");
          lastBg = [];
        }
      } else {
        // show list + cache it
        setList(root, "#body-bg", "#count-bg", list, "No background information available.");
        lastBg = list.slice(0);
        try { chrome.storage.local.set({ [cacheKey]: lastBg }); } catch {}
      }

      // 3) optional AI brief overlay: ONLY replace if it returns something
      try {
        chrome.runtime.sendMessage({
          type: "SPA_SUMMARIZE_BACKGROUND",
          payload: { company: ctx.company || "", items: lastBg }
        }, (resp) => {
          const arr = (resp && resp.ok && Array.isArray(resp.result)) ? resp.result.slice(0,3) : [];
          if (!arr.length) return; // <-- keep the scraped list; do NOT wipe it
          setList(root, "#body-bg", "#count-bg", arr, "No background found.");
          lastBg = arr.slice(0);
        });
      } catch {}
    })();



        // ---- Email generator state + actions ----

    function requestEmail() {
      const countEl = root.getElementById("count-email");
      const box = root.getElementById("email-text");
      countEl.textContent = "Loading…";
      box.textContent = "Generating…";

      chrome.runtime.sendMessage({
        type: "SPA_GENERATE_EMAIL",
        payload: {
          profile: {
            name: ctx.name, role: ctx.role, company: ctx.company, location: ctx.location
          },
          inputs: {
            responsibilities: lastResp,
            insights: lastInsights,
            news: (Array.isArray(lastNews)
  ? lastNews.map(n => (n && typeof n === "object") ? (n.title || n.label || "") : String(n || ""))
  : []),
            financial: lastFin,
            background: lastBg
          },
          tone: "Professional"
        }
      }, (resp2) => {
        const email = resp2?.result?.email || "";
        if (email) {
          box.textContent = email.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\r/g, "");
          countEl.textContent = "Ready";
        } else {
          box.textContent = resp2?.error || "Couldn't generate email.";
          countEl.textContent = "Error";
        }
      });
    }

    root.getElementById("email-regenerate").addEventListener("click", requestEmail);

// --- On first load: show saved draft if present; otherwise auto-generate once ---
(function initEmailDraftOnce(){
  const box = root.getElementById("email-text");
  const countEl = root.getElementById("count-email");
  chrome.runtime.sendMessage({
    type: "SPA_GET_EMAIL_DRAFT",
    payload: { prospect_url: ctx.url || "", prospect_name: ctx.name || "", company: ctx.company || "" }
  }, (r) => {
    const txt = r?.result?.draft || "";
    if (txt) {
      box.textContent = txt.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\r/g, "");
      countEl.textContent = "Ready";
    } else {
      requestEmail(); // background saves on first generation
    }
  });
})();


        root.getElementById("email-send").addEventListener("click", () => {
      const txt = root.getElementById("email-text")?.textContent || "";
      const subject = "Introduction";
      const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(txt)}`;
      window.location.href = mailto;
    });

    root.getElementById("email-copy").addEventListener("click", async () => {
      const txt = root.getElementById("email-text").textContent || "";
      try {
        await navigator.clipboard.writeText(txt);
      } catch {
        // Fallback when clipboard API is blocked inside shadow roots
        const ta = document.createElement("textarea");
        ta.value = txt; root.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      }
    });

    // --- Generate Sales Files (2-page PDF via print) ---
    root.getElementById("gen-sales-files").addEventListener("click", async () => {
      const btn = root.getElementById("gen-sales-files");
      const oldLabel = btn.textContent;
      btn.textContent = "Generating…";
            btn.textContent = "Generating Sales File…";

      btn.disabled = true;

      try {
        const fit = {
          badge: (root.getElementById("fit-badge")?.textContent || "").trim(),
          summary: (root.getElementById("fit-summary")?.textContent || "").trim(),
          recommendedAction: (root.getElementById("fit-reco")?.textContent || "").trim()
        };

        // Normalize news for AI (titles only are fine; objects also fine)
        const newsForAI = Array.isArray(lastNews) ? lastNews.map(n => {
          if (!n) return "";
          if (typeof n === "string") return n;
          return n.title || n.label || "";
        }).filter(Boolean) : [];

        const payload = {
          profile: { name: ctx.name, role: ctx.role, company: ctx.company, location: ctx.location },
          inputs: {
            responsibilities: lastResp || "",
            insights: Array.isArray(lastInsights) ? lastInsights : [],
            news: Array.isArray(lastNews) ? lastNews : newsForAI,   // pass objects when we have them
            financial: Array.isArray(lastFin) ? lastFin : [],
            background: Array.isArray(lastBg) ? lastBg : [],
            fit
          }
        };

        chrome.runtime.sendMessage({ type: "SPA_GENERATE_SALES_FILES", payload }, (resp) => {
          const brief = resp?.result || {};
          const html  = buildSalesDocHTML(ctx, brief);
          openPrintWindow(html);
        });
      } catch (e) {
        console.error("[SPA] Generate Sales Files failed:", e);
        alert("Sorry — couldn’t generate the document.");
      } finally {
        btn.textContent = oldLabel;
        btn.disabled = false;
      }
    });

    // Build a branded, 2-page, print-ready HTML
    function buildSalesDocHTML(ctx, brief) {
      const p1 = brief.page1 || {};
      const p2 = brief.page2 || {};
      const esc = (s="") => String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m]));
      const li  = (arr=[]) => arr.map(x => `<li>${esc(x)}</li>`).join("");

      const brandBgStart = "#3d0f4b2e";
      const brandBgEnd   = "#261335ed";
      const brandAccent1 = "#6f6cff";
      const brandAccent2 = "#9b6cff";
      const chipBg       = "rgba(255,255,255,.06)";
      const borderSoft   = "rgba(255,255,255,.12)";

      // News list (allow objects {title,summary,url} or plain strings)
      const newsList = (p2.company_recent_news || []).map(it => {
        if (!it) return "";
        if (typeof it === "string") return `<li>${esc(it)}</li>`;
        const t = it.title || it.label || "";
        const s = it.summary || "";
        const u = it.url || it.link || "";
        const host = (() => { try { return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; } })();
        return `<li><div style="font-weight:600">${esc(t)}</div>${s ? `<div style="opacity:.9;margin:2px 0 4px">${esc(s)}</div>` : ""}${u ? `<div style="opacity:.9;font-size:12px">🔗 <a href="${esc(u)}" target="_blank" rel="noopener" style="color:${brandAccent2};text-decoration:none">${esc(host || "link")} →</a></div>`:""}</li>`;
      }).join("");

      const fitBadge  = esc((brief.inputs?.fit?.badge) || "");
      const fitLine   = esc((brief.inputs?.fit?.summary) || "");
      const fitReco   = esc((brief.inputs?.fit?.recommendedAction) || "");
      const fitMeta   = fitBadge ? `<div style="margin-top:8px;padding:10px;border:1px solid ${borderSoft};border-radius:10px;background:${chipBg}"><div style="font-weight:800;font-size:12px;letter-spacing:.02em">Fit Summary <span style="border-radius:8px;padding:2px 8px;margin-left:6px;background:${brandAccent1};color:#0b1431;font-weight:900">${fitBadge}</span></div><div style="margin-top:6px">${fitLine || "—"}</div><div style="margin-top:6px;opacity:.95">⚡ ${fitReco || ""}</div></div>` : "";

      const headerName = esc(p1.prospect_name || ctx.name || "Prospect");
      const headerRole = esc(p1.prospect_title || ctx.role || "—");
      const headerCo   = esc(p1.prospect_company || ctx.company || "—");
      const headerLoc  = esc(p1.prospect_location || ctx.location || "—");

      return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${headerName} — Sales Brief</title>
  <style>
    @page { size: A4; margin: 16mm 14mm; }
    * { box-sizing: border-box; }
    body { margin:0; background:${brandBgEnd}; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#fff; }
    .page { width: 210mm; min-height: 297mm; background: linear-gradient(180deg, ${brandBgStart}, ${brandBgEnd}); padding: 20mm 16mm; margin: 0 auto; }
    .title { display:flex; align-items:center; gap:14px; margin-bottom:12px; }
    .avatar { width:56px; height:56px; border-radius:50%; display:grid; place-items:center; background: radial-gradient(circle at 30% 30%, #2a3c8f, #0f1738 70%); border:2px solid ${borderSoft}; }
    .name { font-weight:900; font-size:20px; }
    .meta { opacity:.95; font-size:13px; }
    h2 { font-size:14px; letter-spacing:.04em; text-transform:uppercase; opacity:.9; margin:18px 0 10px }
    .card { border:1px solid ${borderSoft}; border-radius:14px; padding:12px; background:${chipBg}; margin-top:10px; }
    ul { margin:8px 0 0 16px; padding:0; }
    li { margin:4px 0; }
    .two-col { display:grid; grid-template-columns: 1fr 1fr 360px; gap:12px; }
    .col-right { display:flex; align-items:flex-start; }


    .accent { background: linear-gradient(90deg, ${brandAccent1}, ${brandAccent2}); -webkit-background-clip: text; background-clip: text; color: transparent; font-weight:900 }
    .pill { display:inline-block; padding:4px 8px; border-radius:999px; background:${chipBg}; border:1px solid ${borderSoft}; font-size:12px; }
    .page-break { page-break-before: always; }
    a { color:${brandAccent2}; }
  </style>
</head>
<body>
  <!-- Page 1 -->
  <div class="page">
    <div class="title">
      <div class="avatar"><div style="font-weight:900">${esc((headerName||"?").charAt(0))}</div></div>
      <div>
        <div class="name">${headerName}</div>
        <div class="meta">${headerRole} • ${headerCo} • ${headerLoc}</div>
      </div>
    </div>

    ${fitMeta}

    <h2><span class="accent">Page 1</span> — Prospect Intel</h2>
    <div class="card">
      <div><strong>Summary of Role:</strong> ${esc(p1.prospect_role_summary || "") || "—"}</div>
    </div>

    <div class="two-col">
      <div class="card">
        <div><strong>Career Highlights</strong></div>
        <ul>${li(p1.prospect_experience || [])}</ul>
      </div>
      <div class="card">
        <div><strong>Skills & Interests</strong></div>
        <ul>${li(p1.prospect_skills || [])}</ul>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div><strong>Conversation Hooks</strong></div>
        <ul>${li(p1.prospect_connections_or_activity || [])}</ul>
      </div>
      <div class="card">
        <div><strong>Personalization Angles</strong></div>
        <ul>${li(p1.hooks || [])}</ul>
      </div>
    </div>
  </div>

  <!-- Page 2 -->
  <div class="page page-break">
    <h2><span class="accent">Page 2</span> — Account Intel</h2>
    <div class="card">
      <div><strong>Company Overview</strong></div>
      <div style="margin-top:6px">${esc(p2.company_overview || "") || "—"}</div>
    </div>

    <div class="two-col">
      <div class="card">
        <div><strong>Strategic Moves / News</strong></div>
        <ul>${newsList}</ul>
      </div>
      <div class="card">
        <div><strong>Pain Points / Challenges</strong></div>
        <ul>${li(p2.company_challenges || [])}</ul>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div><strong>Current Tools / Tech Stack</strong></div>
        <ul>${li(p2.company_tech_stack || [])}</ul>
      </div>
      <div class="card">
        <div><strong>Relevant Metrics</strong></div>
        <div style="margin-top:6px">${esc(p2.company_metrics || "") || "—"}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div><strong>Opportunity for Us (Sales Angle)</strong></div>
        <div style="margin-top:6px">${esc(p2.company_sales_opportunity || "") || "—"}</div>
      </div>
      <div class="card">
        <div><strong>Suggested Discovery Questions</strong></div>
        <ul>${li(p2.discovery_questions || [])}</ul>
      </div>
    </div>
  </div>

  <script>
    window.onload = () => setTimeout(() => window.print(), 600);
  </script>
</body>
</html>
      `;
    }

    function openPrintWindow(html) {
      const w = window.open("", "_blank");
      if (!w) return alert("Pop-up blocked. Please allow pop-ups for this site.");
      w.document.open();
      w.document.write(html);
      w.document.close();
    }

    // Settings check
    const settings = await new Promise((res) => chrome.runtime.sendMessage({ type: "SPA_GET_SETTINGS" }, res));
    const hasKey = !!(settings && settings.ok && settings.result && settings.result.hasKey);
    if (!hasKey) {
      warn(`OpenAI key missing — showing in-card messages. storageSource=${settings?.result?.source || "unknown"}`);
      setTimeout(() => setList(root, "#body-news", "#count-news", [], "Not paired. In the web app, open “Connect Extension”, generate a code, and paste it in the extension prompt."), 700);
      setTimeout(() => setList(root, "#body-fin",  "#count-fin",  [], "Not paired. In the web app, open “Connect Extension”, generate a code, and paste it in the extension prompt."), 800);
      setTimeout(() => setList(root, "#list-resp", "#count-resp", [], "Not paired. In the web app, open “Connect Extension”, generate a code, and paste it in the extension prompt."), 900);
      setTimeout(() => setList(root, "#body-ins", "#count-ins", [], "Not paired. In the web app, open “Connect Extension”, generate a code, and paste it in the extension prompt."), 950);
      root.getElementById("count-email").textContent = "—";
      root.getElementById("email-text").textContent  = "Not paired. In the web app, open “Connect Extension”, generate a code, and paste it in the extension prompt.";
      root.getElementById("fit-summary").textContent = "—";
      root.getElementById("fit-reco").textContent    = "—";
      root.getElementById("fit-badge").textContent   = "—";
      wireClose(root); return;
    }

    // Enrichment (OpenAI)
    chrome.runtime.sendMessage({
      type: "SPA_ENRICH_PROFILE",
      payload: {
        profile: {
  name: ctx.name,
  role: ctx.role,
  company: ctx.company,
  location: ctx.location,
  experiences: lastBg,   // use the shared cached background we populate earlier
  education: [],
  posts,
  pageUrl: ctx.url
}
      }
    }, (resp) => {
      if (!resp || !resp.ok) {
        err("Enrichment failed:", resp && resp.error);
        setList(root, "#body-news", "#count-news", [], "Couldn’t load news.");
        setList(root, "#body-fin",  "#count-fin",  [], "Couldn’t load financial items.");
        setList(root, "#list-resp", "#count-resp", [], "Couldn’t generate responsibilities.");
      } else {
        const r = resp.result || {};
        if (!ctx.company) warn("Company missing — news/financial may be empty.");
        if (!ctx.role) warn("Role missing — responsibilities may be empty.");
        setList(root, "#body-news", "#count-news", r.news || [], ctx.company ? "No online information found about this company." : "Current company name not found.");
        function wireNewsRead(){
  const body   = shadow.getElementById("body-news");
  const modal  = shadow.getElementById("resp-modal");
  const card   = shadow.getElementById("card-news");
  const close  = shadow.getElementById("news-collapse");
  if (!body || !modal || !card || !close) return;

  const ease = "cubic-bezier(0.22,0.61,0.36,1)";
  let ph = null;
let originalHTML = null;
let originalParent = null, originalNext = null;   // NEW

  async function showDetails(idx){
  const item = (Array.isArray(lastNews) && lastNews[idx]) ? lastNews[idx] : null;
  const headline = (item && typeof item === "object") ? (item.title || item.label || "") : String(item || "");
  const openUrl  = (item && typeof item === "object" && (item.link || item.url)) ? (item.link || item.url) : "";
  if (!headline) return;

originalParent = card.parentElement;
originalNext   = card.nextElementSibling;

    // Expand News card to center (FLIP)
    const first = card.getBoundingClientRect();
    ph = document.createElement("div");
    ph.style.width  = first.width + "px";
    ph.style.height = first.height + "px";
    card.parentElement.insertBefore(ph, card);

    modal.classList.add("show");
    modal.appendChild(card);
    card.classList.add("card--overlay-news");

    const last = card.getBoundingClientRect();
    const dx = first.left - last.left, dy = first.top - last.top;
    const sx = first.width / last.width, sy = first.height / last.height;

    card.style.transformOrigin = "top left";
    card.style.transform  = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    card.style.transition = `transform 320ms ${ease}`;
    requestAnimationFrame(() => { card.style.transform = "translate(0,0) scale(1,1)"; });

    card.addEventListener("transitionend", function done() {
      card.style.transition = ""; card.style.transform = "";
      card.removeEventListener("transitionend", done);
    });

    // Show skeleton while we get the summary
    const bodyEl = shadow.getElementById("body-news");
    originalHTML = bodyEl.innerHTML;
    bodyEl.innerHTML = `
      <div class="skeleton" style="height:18px;border-radius:8px;margin:8px 0"></div>
      <div class="skeleton" style="height:14px;border-radius:8px;margin:8px 0"></div>
      <div class="skeleton" style="height:14px;border-radius:8px;margin:8px 0"></div>`;

    close.style.display = "inline-block";

    chrome.runtime.sendMessage({
      type: "SPA_SUMMARIZE_NEWS",
      payload: { company: shadow.getElementById("spa-company")?.textContent || "", headline }
    }, (resp) => {
      const sum = resp?.result?.summary || "No summary available.";
const companyName = shadow.getElementById("spa-company")?.textContent || "";
const q = encodeURIComponent((companyName + " " + headline).trim());
const primary = openUrl || `https://www.google.com/search?q=${q}`;

bodyEl.innerHTML = `
  <div style="font-size:14px;font-weight:800;margin-bottom:8px">${headline}</div>
  <div style="font-size:13px;line-height:1.55;margin-bottom:12px">${sum}</div>
  <div class="news-links">
    <a class="pill" href="${primary}" target="_blank" rel="noopener">Open Article →</a>
    <a class="pill" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Open on Google →</a>
  </div>
`;



    });
  }

  function collapseDetails(){
  // If placeholder is missing, snap back safely
  if (!ph) {
    modal.classList.remove("show");
    card.classList.remove("card--overlay-news");
    (originalParent || shadow.querySelector("main.grid"))?.insertBefore(card, originalNext || null);
    if (originalHTML != null) {
      shadow.getElementById("body-news").innerHTML = originalHTML;
      originalHTML = null;
      wireNewsRead();
    }
    close.style.display = "none";
    return;
  }

  const last   = card.getBoundingClientRect();
  const target = ph.getBoundingClientRect();
  const dx = target.left - last.left,  dy = target.top - last.top;
  const sx = target.width / last.width, sy = target.height / last.height;

  card.style.transformOrigin = "top left";
  card.style.transition = `transform 280ms cubic-bezier(0.22,0.61,0.36,1)`;
  card.style.transform  = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

  let doneCalled = false;
  const done = () => {
    if (doneCalled) return; doneCalled = true;
    card.style.transition = ""; card.style.transform = "";
    card.classList.remove("card--overlay-news");

    // restore in original place
    (originalParent || ph.parentElement).insertBefore(card, originalNext || ph);
    ph.remove(); ph = null;

    modal.classList.remove("show");

    if (originalHTML != null) {
      shadow.getElementById("body-news").innerHTML = originalHTML;
      originalHTML = null;
      wireNewsRead();
    }
    close.style.display = "none";
  };

  card.addEventListener("transitionend", done, { once:true });
  setTimeout(done, 420); // fallback if transitionend doesn't fire
}


collapseNewsRef = collapseDetails;  // expose to global backdrop closer

  close.addEventListener("click", (e) => {
  e.stopPropagation();
  collapseDetails();
});

  body.querySelectorAll(".read-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      const idx = Number(e.currentTarget.getAttribute("data-idx") || "0");
      showDetails(idx);
    });
  });
}
        lastNews = Array.isArray(r.news) ? r.news.slice(0) : [];
wireNewsRead();

const topNews = (Array.isArray(r.news) ? r.news.slice(0,8) : []);
setList(root, "#body-news", "#count-news", topNews, "No company news found.");



        setList(root, "#body-fin",  "#count-fin",  r.financial || [], ctx.company ? "No financial items found for this company." : "Current company name not found.");
        wireNewsRead();

        lastFin = Array.isArray(r.financial) ? r.financial.slice(0) : [];

        // Wire "Read" clicks for Financial Overview (open link or Google fallback)
(function wireFinRead(){
  const finBody = root.getElementById("body-fin");
  if (!finBody) return;

  finBody.querySelectorAll(".read-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.getAttribute("data-idx") || "0");
      const it = (Array.isArray(lastFin) && lastFin[idx]) ? lastFin[idx] : null;

      const title = (it && typeof it === "object") ? (it.title || it.label || "") : String(it || "");
      const url   = (it && typeof it === "object") ? (it.url || it.link || "") : "";
      const companyName = shadow.getElementById("spa-company")?.textContent || "";

      const fallback = `https://www.google.com/search?q=${encodeURIComponent((companyName + " " + title).trim())}`;
      const openUrl  = url || fallback;

      try { window.open(openUrl, "_blank", "noopener"); } catch { location.href = openUrl; }
    });
  });
})();


       // --- Relevant Peers (Top 5, expandable + actions) ---
const peersBody  = root.getElementById("body-peers");
const peersCount = root.getElementById("count-peers");
peersBody.innerHTML = `<div class="row"><span class="dot"></span><div class="content"><div class="txt">Finding peers…</div></div></div>`;

function renderPeers(peers = []) {
  peersBody.innerHTML = "";
  if (!Array.isArray(peers) || peers.length === 0) {
    peersBody.innerHTML = `<div class="row"><span class="dot"></span><div class="content"><div class="txt">No peers found.</div></div></div>`;
    peersCount.textContent = "0 items";
    return;
  }
  peers.forEach((p, i) => {
    const name  = (p && p.name)  || "—";
    const title = (p && p.title) || "";
    const url   = (p && p.url)   || "";
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <input type="checkbox" class="peer-check" data-idx="${i}" style="margin:6px 6px 0 0">
      <span class="dot"></span>
      <div class="content">
        <div class="txt" style="font-weight:700">${name}</div>
        <div class="txt" style="opacity:.9">${title}</div>
        ${url ? `<div class="news-links" style="margin-top:6px"><a class="pill" href="${url}" target="_blank" rel="noopener">${/\/in\//.test(url) ? "Open Profile →" : "Search on LinkedIn →"}</a></div>` : ""}
      </div>
    `;
    peersBody.appendChild(row);
  });
  peersCount.textContent = `${peers.length} items`;
}

// initial fetch (limit 5 for compact card)
chrome.runtime.sendMessage({
  type: "SPA_FIND_PEERS",
  payload: { company: ctx.company || "", prospect_name: ctx.name || "", role: ctx.role || "", limit: 5 }
}, (resp) => {
  const peers = (resp && resp.ok && Array.isArray(resp.result)) ? resp.result.slice(0, 12) : [];
  lastPeers = peers.slice(0);
  renderPeers(peers);
});

// COPY selected (or all if none selected)
const copyBtn = root.getElementById("peers-copy");
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const checks = Array.from(peersBody.querySelectorAll(".peer-check:checked"));
    const chosen = checks.length
      ? checks.map(chk => lastPeers[Number(chk.dataset.idx || "0")]).filter(Boolean)
      : lastPeers.slice(0);

    const lines = chosen.map(p => {
      const n = p?.name || "—";
      const t = p?.title || "";
      const u = p?.url ? ` — ${p.url}` : "";
      return `${n} — ${t}${u}`;
    }).join("\n") || "No peers selected.";
    try {
      await navigator.clipboard.writeText(lines);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = lines; root.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
  });
}

// REGENERATE (fetch up to 12 for richer list)
const regenBtn = root.getElementById("peers-reload");
if (regenBtn) {
  regenBtn.addEventListener("click", () => {
    regenBtn.textContent = "Finding…";
    regenBtn.disabled = true;
    // skeleton
    peersBody.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      const d = document.createElement("div");
      d.className = "skeleton";
      d.style.height = "14px";
      d.style.margin = "8px 0";
      d.style.borderRadius = "6px";
      peersBody.appendChild(d);
    }
    chrome.runtime.sendMessage({
      type: "SPA_FIND_PEERS",
      payload: { company: ctx.company || "", prospect_name: ctx.name || "", role: ctx.role || "", limit: 12 }
    }, (resp) => {
      const peers = (resp && resp.ok && Array.isArray(resp.result)) ? resp.result.slice(0, 12) : [];
      lastPeers = peers.slice(0);
      renderPeers(peers);
      regenBtn.textContent = "Regenerate";
      regenBtn.disabled = false;
    });
  });
}

// EXPAND / COLLAPSE via overlay (FLIP)
(function wirePeersOverlay(){
  const peersCard = root.getElementById("card-peers");
  const expandBtn = root.getElementById("expand-peers");
  const modal     = root.getElementById("resp-modal");
  if (!peersCard || !expandBtn || !modal) return;

  let ph = null;
  const ease = "cubic-bezier(0.22,0.61,0.36,1)";

  function expandPeers() {
    const first = peersCard.getBoundingClientRect();

    ph = document.createElement("div");
    ph.style.width  = first.width + "px";
    ph.style.height = first.height + "px";
    peersCard.parentElement.insertBefore(ph, peersCard);

    modal.classList.add("show");
    modal.appendChild(peersCard);
    peersCard.classList.add("card--overlay");

    const last = peersCard.getBoundingClientRect();
    const dx = first.left - last.left,  dy = first.top - last.top;
    const sx = first.width / last.width, sy = first.height / last.height;

    peersCard.style.transformOrigin = "top left";
    peersCard.style.transform  = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    peersCard.style.transition = `transform 320ms ${ease}, box-shadow 320ms ${ease}`;
    requestAnimationFrame(() => { peersCard.style.transform = "translate(0,0) scale(1,1)"; });

    const done = () => {
      peersCard.style.transition = "";
      peersCard.style.transform  = "";
      peersCard.removeEventListener("transitionend", done);
    };
    peersCard.addEventListener("transitionend", done);

    expandBtn.textContent = "Collapse";
  }

  function collapsePeers() {
    // safety snap-back if placeholder missing
    if (!ph) {
      peersCard.classList.remove("card--overlay");
      modal.classList.remove("show");
      expandBtn.textContent = "Expand";
      return;
    }
    const last   = peersCard.getBoundingClientRect();
    const target = ph.getBoundingClientRect();
    const dx = target.left - last.left,  dy = target.top - last.top;
    const sx = target.width / last.width, sy = target.height / last.height;

    peersCard.style.transformOrigin = "top left";
    peersCard.style.transition = `transform 280ms ${ease}`;
    peersCard.style.transform  = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

    let doneCalled = false;
    const done = () => {
      if (doneCalled) return; doneCalled = true;
      peersCard.style.transition = "";
      peersCard.style.transform  = "";
      peersCard.classList.remove("card--overlay");
      ph.parentElement.insertBefore(peersCard, ph);
      ph.remove(); ph = null;
      modal.classList.remove("show");
      expandBtn.textContent = "Expand";
    };
    peersCard.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 420);
  }

  collapsePeersRef = collapsePeers; // allow backdrop click to close

  expandBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (peersCard.classList.contains("card--overlay")) collapsePeers();
    else expandPeers();
  });
})();


        
{
  const box = root.getElementById("list-resp");
  const cnt = root.getElementById("count-resp");
  box.innerHTML = "";

  let txt = r.responsibilities || "";
  lastResp = r.responsibilities || "";

  // --- Sanitize: remove any stray Markdown bold/asterisks ---
  txt = txt.replace(/\*\*/g, "");

    // Strip leading numbering/bullets and hard-limit each item to 125 chars, render as plain paragraphs
  txt = txt
    .split(/\n+/)
    .map(s => s.replace(/^\s*(?:\d+[\.\)]\s+|[-*]\s+)/, "").trim())
    .filter(Boolean)
    .map(s => s.length > 125 ? s.slice(0, 125) + "…" : s)
    .join("\n\n");


  // --- Ensure there is a blank line between numbered items (1., 2., 3., etc.) ---
  // If the model didn't put blank lines, add one before any "\nN. " sequence.
  txt = txt.replace(/\n(\d+\.\s)/g, "\n\n$1");

  // --- Ensure header line has a blank line after it ---
  txt = txt.replace(/(Job Responsibilities \(with Confidence Levels\):)\s*/i, "$1\n\n");

  if (txt.trim()) {
    box.innerHTML = `<div style="font-size:13px;line-height:1.55;white-space:pre-wrap">${txt}</div>`;
    cnt.textContent = "AI generated";
  } else {
    box.innerHTML = `<div style="opacity:.75">No responsibilities found (missing role/company or API issue).</div>`;
    cnt.textContent = "0 items";
  }

  // --- Expand/Collapse wiring ---
  // --- Responsibilities: expand/collapse via modal + FLIP (robust) ---
// --- Responsibilities: expand/collapse via modal + FLIP (final, reliable) ---
{
  const respCard  = root.getElementById("card-resp");
  const expandBtn = root.getElementById("expand-resp");
  const modal     = root.getElementById("resp-modal");
  if (respCard && expandBtn && modal) {
    let ph = null;
    const ease = "cubic-bezier(0.22,0.61,0.36,1)";

    function expandResp() {
      const first = respCard.getBoundingClientRect();

      ph = document.createElement("div");
      ph.style.width  = first.width + "px";
      ph.style.height = first.height + "px";
      respCard.parentElement.insertBefore(ph, respCard);

      modal.classList.add("show");
      modal.appendChild(respCard);
      respCard.classList.add("card--overlay");

      const last = respCard.getBoundingClientRect();
      const dx = first.left - last.left,  dy = first.top - last.top;
      const sx = first.width / last.width, sy = first.height / last.height;

      respCard.style.transformOrigin = "top left";
      respCard.style.transform  = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      respCard.style.transition = `transform 320ms ${ease}, box-shadow 320ms ${ease}`;
      requestAnimationFrame(() => { respCard.style.transform = "translate(0,0) scale(1,1)"; });

      const done = () => {
        respCard.style.transition = "";
        respCard.style.transform  = "";
        respCard.removeEventListener("transitionend", done);
      };
      respCard.addEventListener("transitionend", done);

      expandBtn.textContent = "Collapse";
    }

    function collapseResp() {
      // safety snap-back if placeholder is gone
      if (!ph) {
        respCard.classList.remove("card--overlay");
        modal.classList.remove("show");
        expandBtn.textContent = "Expand";
        return;
      }

      const last   = respCard.getBoundingClientRect();
      const target = ph.getBoundingClientRect();
      const dx = target.left - last.left,  dy = target.top - last.top;
      const sx = target.width / last.width, sy = target.height / last.height;

      respCard.style.transformOrigin = "top left";
      respCard.style.transition = `transform 280ms ${ease}`;
      respCard.style.transform  = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

      let doneCalled = false;
      const done = () => {
        if (doneCalled) return; doneCalled = true;
        respCard.style.transition = "";
        respCard.style.transform  = "";
        respCard.classList.remove("card--overlay");
        ph.parentElement.insertBefore(respCard, ph);
        ph.remove(); ph = null;
        modal.classList.remove("show");
        expandBtn.textContent = "Expand";
      };

      respCard.addEventListener("transitionend", done, { once:true });
      setTimeout(done, 420); // fallback if transitionend is missed
    }

    // Expose for backdrop closer (already wired elsewhere)
    collapseRespRef = collapseResp;

    // Single click handler that always works
    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (respCard.classList.contains("card--overlay")) collapseResp();
      else expandResp();
    });
  }
}

}
// --- Fit Summary: expand/collapse via modal + FLIP (final, reliable) ---
{
  const fitEl  = root.getElementById("fit-banner");
  const fitBtn = root.getElementById("expand-fit");
  const modal  = root.getElementById("resp-modal");
  if (fitEl && fitBtn && modal) {
    let ph = null;
    let saved = null;
    const ease = "cubic-bezier(0.22,0.61,0.36,1)";

    function expandFit() {
      const first = fitEl.getBoundingClientRect();

      ph = document.createElement("div");
      ph.style.width  = first.width + "px";
      ph.style.height = first.height + "px";
      fitEl.parentElement.insertBefore(ph, fitEl);

      // remember inline banner styles so we can neutralize while expanded
      saved = {
        marginLeft: fitEl.style.marginLeft,
        maxWidth:   fitEl.style.maxWidth,
        background: fitEl.style.background,
        textAlign:  fitEl.style.textAlign
      };

      modal.classList.add("show");
      modal.appendChild(fitEl);
      fitEl.classList.add("card","show","card--overlay");

      // neutralize banner-specific inline styles
      fitEl.style.marginLeft = "0";
      fitEl.style.maxWidth   = "none";
      fitEl.style.background = "";
      fitEl.style.textAlign  = "left";

      const last = fitEl.getBoundingClientRect();
      const dx = first.left - last.left,  dy = first.top - last.top;
      const sx = first.width / last.width, sy = first.height / last.height;

      fitEl.style.transformOrigin = "top left";
      fitEl.style.transform  = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      fitEl.style.transition = `transform 320ms ${ease}, box-shadow 320ms ${ease}`;
      requestAnimationFrame(() => { fitEl.style.transform = "translate(0,0) scale(1,1)"; });

      const done = () => {
        fitEl.style.transition = "";
        fitEl.style.transform  = "";
        fitEl.removeEventListener("transitionend", done);
      };
      fitEl.addEventListener("transitionend", done);

      fitBtn.textContent = "Collapse";
    }

    function collapseFit() {
      if (!ph) { // safety snap-back
        fitEl.classList.remove("card","card--overlay","show");
        modal.classList.remove("show");
        // restore banner styles
        if (saved) {
          fitEl.style.marginLeft = saved.marginLeft;
          fitEl.style.maxWidth   = saved.maxWidth;
          fitEl.style.background = saved.background;
          fitEl.style.textAlign  = saved.textAlign;
          saved = null;
        }
        fitBtn.textContent = "Expand";
        return;
      }

      const last   = fitEl.getBoundingClientRect();
      const target = ph.getBoundingClientRect();
      const dx = target.left - last.left,  dy = target.top - last.top;
      const sx = target.width / last.width, sy = target.height / last.height;

      fitEl.style.transformOrigin = "top left";
      fitEl.style.transition = `transform 280ms ${ease}`;
      fitEl.style.transform  = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

      let doneCalled = false;
      const done = () => {
        if (doneCalled) return; doneCalled = true;
        fitEl.style.transition = "";
        fitEl.style.transform  = "";
        fitEl.classList.remove("card","card--overlay","show");
        // restore banner styles + position
        if (saved) {
          fitEl.style.marginLeft = saved.marginLeft;
          fitEl.style.maxWidth   = saved.maxWidth;
          fitEl.style.background = saved.background;
          fitEl.style.textAlign  = saved.textAlign;
          saved = null;
        }
        ph.parentElement.insertBefore(fitEl, ph);
        ph.remove(); ph = null;
        modal.classList.remove("show");
        fitBtn.textContent = "Expand";
      };

      fitEl.addEventListener("transitionend", done, { once:true });
      setTimeout(done, 420); // fallback if transitionend is missed
    }

    // Expose for backdrop closer (already wired elsewhere)
    collapseFitRef = collapseFit;

    // Single click handler that always works
    fitBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (fitEl.classList.contains("card--overlay")) collapseFit();
      else expandFit();
    });
  }
}

        setList(
  root,
  "#body-ins",
  "#count-ins",
  Array.isArray(r.insights) ? r.insights : [],
  posts.length ? "No clear insights from their recent activity." : "No recent activity found."
);
lastInsights = Array.isArray(r.insights) ? r.insights.slice(0) : [];

        root.getElementById("fit-summary").textContent = r.fitSummary || "—";
        root.getElementById("fit-reco").textContent    = r.recommendedAction || "—";
        // Fill Action Plan card
const plan = r.actionPlan || {};
const planParagraphEl = root.getElementById("plan-paragraph");
const planBulletsEl   = root.getElementById("plan-bullets");
const planCtaEl       = root.getElementById("plan-cta");

if (planParagraphEl) planParagraphEl.textContent = String(plan.paragraph || "—");

if (planBulletsEl) {
  planBulletsEl.innerHTML = "";
  planBulletsEl.style.listStyleType = "disc";
planBulletsEl.style.paddingLeft   = "20px";
planBulletsEl.style.marginTop     = "12px";
  const items = Array.isArray(plan.bullets) ? plan.bullets.slice(0, 5) : [];
  for (const t of items) {
    const li = document.createElement("li");
    li.textContent = String(t || "").trim();
    planBulletsEl.appendChild(li);
    li.style.margin     = "4px 0 6px";
li.style.lineHeight = "1.6";
li.style.fontSize   = "13px";
li.style.opacity    = ".95";
  }
}

if (planCtaEl) planCtaEl.textContent = String(plan.cta || "—");

        root.getElementById("fit-badge").textContent   = r.fitBadge || "—";
        // Color the Fit banner border according to the level
const fitBanner = root.getElementById("fit-banner");
const badgeTxt = (r.fitBadge || "").toLowerCase();
fitBanner.classList.remove("fit--low","fit--medium","fit--high","fit--highest");
if (badgeTxt.includes("highest"))      fitBanner.classList.add("fit--highest");
else if (badgeTxt.includes("high"))    fitBanner.classList.add("fit--high");
else if (badgeTxt.includes("medium"))  fitBanner.classList.add("fit--medium");
else if (badgeTxt.includes("low"))     fitBanner.classList.add("fit--low");
      }
    });

    wireClose(root);
  }

  function wireClose(root) {
    const closeAll = () => {
      document.getElementById(OVERLAY_ID)?.remove();
      document.documentElement.style.overflow = document.documentElement.dataset._spaPrevOverflow || "";
      isOpen = false;
    };
    root.getElementById("spa-close").addEventListener("click", closeAll, { once: true });
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); }, { once: true });
  }

  function toggleOverlay() {
    if (isOpen) {
      document.getElementById(OVERLAY_ID)?.remove();
      document.documentElement.style.overflow = document.documentElement.dataset._spaPrevOverflow || "";
      isOpen = false;
    } else {
      openOverlay();
    }
  }

  chrome.storage.sync.get({ supabase_token: "" }, (r) => {
  if (!r.supabase_token) {
    alert("Please pair the extension in the web app first (Connect Extension → Generate code), then paste the code here.");
    return;
  }
  // if paired, continue with the normal toggle logic (the existing code below will run)
});


  chrome.runtime.onMessage.addListener((msg) => {
if (msg?.type === "SPA_TOGGLE_OVERLAY") {
chrome.storage.sync.get({ supabase_token: "" }, (r) => {
if (!r.supabase_token) {
alert('Not paired. In the web app, open “Connect Extension”, click “Generate code”, and paste it in the extension prompt.');} 
else {toggleOverlay();
}
});
}
return true;
});

  console.log("[SPA] content script ready");

  // --- Threadline side launcher (static pill, right-center) ---
(function addThreadlineLauncher(){
  if (document.getElementById('threadline-launcher')) return;
  const btn = document.createElement('button');
  btn.id = 'threadline-launcher';
  btn.textContent = 'Threadline';
  btn.style.position = 'fixed';
  btn.style.right = '16px';
  btn.style.top = '50%';
  btn.style.transform = 'translateY(-50%)';
  btn.style.zIndex = '2147483647';
  btn.style.padding = '8px 12px';
  btn.style.borderRadius = '999px';
  btn.style.border = '0';
  btn.style.fontWeight = '800';
  btn.style.cursor = 'pointer';
  btn.style.background = '#8B5DB5';
  btn.style.color = '#fff';
  btn.style.boxShadow = '0 6px 18px rgba(0,0,0,.18)';
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SPA_TOGGLE_OVERLAY' });
  });
  document.body.appendChild(btn);
})();



// First-run: if we don't yet have a Supabase token, ask the user to paste the device token
(async () => {
  try {
    const s = await chrome.storage.sync.get(['supabase_token']);
    if (!s.supabase_token) {
      const pasted = window.prompt("Connect Extension:\nPaste the device token you generated in the web app (valid ~2 minutes).", "");
      if (pasted && pasted.trim()) {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "SPA_DEVICE_LOGIN", payload: { token: pasted.trim() } }, (r) => {
            if (!r || !r.ok) alert("Could not connect with that token. Please try again from the web app Connect button.");
            resolve();
          });
        });
      }
    }
  } catch {}
})();


  function renderOverlay(insights, email) {
  const overlay = document.createElement("div");
  overlay.id = "spa-overlay";
  overlay.innerHTML = `
    <div class="spa-card" style="border: 1px solid #9b59b6; border-radius: 10px; padding: 16px; background: #1e1e2f; color: #fff; max-width: 500px; margin: 20px auto;">
      <h3 style="margin-bottom: 10px;">AI Email Generation</h3>
      <p id="ai-email-content" style="white-space: pre-wrap; background: #2c2c3c; padding: 10px; border-radius: 6px;">${email || "Click regenerate to generate an email."}</p>
      <div style="margin-top: 12px; display: flex; gap: 10px;">
        <button id="ai-regenerate" style="padding: 6px 12px; background: #9b59b6; color: #fff; border: none; border-radius: 6px; cursor: pointer;">Regenerate</button>
        <button id="ai-copy" style="padding: 6px 12px; background: #444; color: #fff; border: none; border-radius: 6px; cursor: pointer;">Copy</button>
      </div>
    </div>
  `;

  // Add overlay to page
  document.body.appendChild(overlay);

  // Copy functionality
  document.getElementById("ai-copy").addEventListener("click", () => {
    const emailText = document.getElementById("ai-email-content").innerText;
    navigator.clipboard.writeText(emailText);
    alert("Email copied!");
  });

  // Regenerate functionality
  document.getElementById("ai-regenerate").addEventListener("click", () => {
    document.getElementById("ai-email-content").innerText = "Generating new email...";
    chrome.runtime.sendMessage({ type: "GENERATE_EMAIL", insights }, (response) => {
      document.getElementById("ai-email-content").innerText = response.email || "Failed to generate email.";
    });
  });



  
}


})();
