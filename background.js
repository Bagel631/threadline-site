// background.js — MV3 service worker

// ---------------- Settings ----------------
let userOptions = { apiKey: "", model: "gpt-4o-mini" };

// --- Hardcoded service credentials (TEMPORARY until server proxy/OAuth) ---
const SUPABASE_URL = "https://qcesvtizjskieuxvyyqx.supabase.co"; // hardcoded
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjZXN2dGl6anNraWV1eHZ5eXF4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwMTUyMzUsImV4cCI6MjA3MjU5MTIzNX0.s3oBiUAaT6a_BEvBwgLLGV3KpwHhSGBoKXItS9KrYf8"; // public anon


async function readStorage() {
  // Try sync, then local
  try {
    const r = await chrome.storage.sync.get(["openai_key", "openai_model", "apiKey", "model"]);
    if ((r.openai_key || r.apiKey)) {
      return {
        apiKey: (r.openai_key || r.apiKey || "").trim(),
        model: (r.openai_model || r.model || "gpt-4o-mini").trim(),
        source: "sync"
      };
    }
  } catch (e) {
    console.warn("[BG] sync get failed:", e);
  }
  try {
    const r = await chrome.storage.local.get(["openai_key", "openai_model", "apiKey", "model"]);
    return {
      apiKey: (r.openai_key || r.apiKey || "").trim(),
      model: (r.openai_model || r.model || "gpt-4o-mini").trim(),
      source: "local"
    };
  } catch (e) {
    console.warn("[BG] local get failed:", e);
  }
  return { apiKey: "", model: "gpt-4o-mini", source: "empty" };
}

async function ensureSettingsLoaded() {
  // Always refresh; cheap and avoids stale cache when user just saved
  const r = await readStorage();
  userOptions.apiKey = r.apiKey;
  userOptions.model = r.model;
  userOptions.source = r.source;

    // Force-use the hardcoded OpenAI key (no Options page anymore)

    await readDebugFromStorage();

}

chrome.storage.onChanged.addListener((changes, area) => {
  // Keep cache hot
  if (["sync", "local"].includes(area)) {
    if (changes.openai_key)   userOptions.apiKey = (changes.openai_key.newValue || "").trim();
    if (changes.apiKey)       userOptions.apiKey = (changes.apiKey.newValue || "").trim();
    if (changes.openai_model) userOptions.model  = (changes.openai_model.newValue || "gpt-4o-mini").trim();
    if (changes.model)        userOptions.model  = (changes.model.newValue || "gpt-4o-mini").trim();
    if (changes.debug_logs)   DEBUG_LOGS = !!changes.debug_logs.newValue;

  }
});

const hasKey = () => !!(userOptions.apiKey && userOptions.apiKey.length > 10);

// Schema version (bump when adding/removing vendor fields)
const VENDOR_SCHEMA_VERSION = 1;

// Quick visibility of what's in storage on boot (helps debug tokens)
chrome.storage.sync.get(null, (all) => {
  if (all && typeof all === 'object') {
    console.log('[BG] storage snapshot keys:', Object.keys(all));
  }
});



// Debug flag (must exist before helpers that log)
let DEBUG_LOGS = false;
async function readDebugFromStorage() {
  try {
    const { debug_logs } = await chrome.storage.sync.get('debug_logs');
    DEBUG_LOGS = !!debug_logs;
  } catch { DEBUG_LOGS = false; }
}


// ---------- Supabase (WebApp sync) ----------

// Canonical Supabase config (includes refresh token)
async function readSupabaseConfig() {

  // No Options page: URL + anon are hardcoded; only token/refresh come from storage
  try {
    const s = await chrome.storage.sync.get(['supabase_token','supabase_refresh']);
    return {
      url: SUPABASE_URL.replace(/\/+$/,''),
      anon: SUPABASE_ANON_KEY,
      token: (s.supabase_token || '').trim(),
      refresh: (s.supabase_refresh || '').trim()
    };
  } catch {
    return {
      url: SUPABASE_URL.replace(/\/+$/,''),
      anon: SUPABASE_ANON_KEY,
      token: '',
      refresh: ''
    };
  }


 
}


// JWT -> user id (sub)
function parseJwtSub(jwt='') {
  try {
    const base64Url = jwt.split('.')[1]; if (!base64Url) return '';
    const base64 = base64Url.replace(/-/g,'+').replace(/_/g,'/');
    const json = JSON.parse(atob(base64));
    return json.sub || '';
  } catch { return ''; }
}

// Generic Supabase request with 401 refresh
async function supaRequest(path, { method='GET', body=null } = {}) {
  const { url, anon, token } = await readSupabaseConfig();
  if (DEBUG_LOGS) {
  const cfg = await readSupabaseConfig();
  console.log('[CRM] Supabase cfg snapshot:', { haveUrl: !!cfg.url, haveAnon: !!cfg.anon, haveToken: !!cfg.token, haveRefresh: !!cfg.refresh });
}

  if (!url || !anon) throw new Error('Supabase URL/anon key not set');

  const headers = {
    'apikey': anon,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  if (DEBUG_LOGS) console.log('[CRM] supaRequest ->', { path, method, body, fullUrl: `${url}${path}` });

  let res = await fetch(`${url}${path}`, { method, headers, body: body ? JSON.stringify(body) : null });

  // Handle expired JWT once via refresh
  if (res.status === 401) {
    try {
      const txt = await res.text().catch(()=> '');
      if (/jwt expired|JWT expired/i.test(txt)) {
        if (DEBUG_LOGS) console.warn('[CRM] JWT expired; refreshing…');
        const newAccess = await refreshAccessToken();
        if (newAccess) {
          headers['Authorization'] = `Bearer ${newAccess}`;
          res = await fetch(`${url}${path}`, { method, headers, body: body ? JSON.stringify(body) : null });
        }
      } else {
        res = new Response(txt, { status: 401 });
      }
    } catch (e) {
      if (DEBUG_LOGS) console.warn('[CRM] refresh failed', e);
    }
  }

  if (!res.ok) {
    const t = await res.text().catch(()=>String(res.status));
    console.error('[CRM] Supabase error', res.status, t);
    throw new Error(`Supabase ${method} ${path} -> ${res.status} ${t}`);
  }
  return res.json();
}

// Thin helpers on top of supaRequest
async function supaInsert(table, row) {
  return supaRequest(`/rest/v1/${encodeURIComponent(table)}`, { method: 'POST', body: row });
}
async function supaUpdate(table, id, patch) {
  return supaRequest(`/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}


async function supaSelectOne(table, query) {
  const { url, anon, token } = await readSupabaseConfig();
  if (!url || !anon) throw new Error('Supabase URL/anon key not set');
  const headers = { 'apikey': anon, 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const qs = Object.entries(query)
    .map(([k,v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`)
    .join('&');
  const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?${qs}&select=*&limit=1`, { headers });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
  }


// ---- Financial: Google Search top results (no Google News) ----
async function fetchGoogleFinancialTop(company = "", max = 8) {
  try {
    if (!company) return [];
    const q = `financial news about ${company}`.trim();
    const params = new URLSearchParams({
      q,
      hl: "en",
      gl: "us",
      num: String(Math.max(8, max)) // ask for 8+ results, we’ll filter dupes
    });
    const url = `https://www.google.com/search?${params.toString()}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        // mimic a browser a bit to reduce odd layouts
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache"
      }
    });
    const html = await res.text();
    if (!html || html.length < 1000) return [];

    // Parse simple organic results: look for <a href="/url?q=..."> near <h3>Title</h3>
    // This is intentionally simple and robust-ish across variants.
    const items = [];
    const seen = new Set();

    // Match blocks like: <a href="/url?q=URL&sa=..."><h3>Title</h3>
    const rx = /<a href="\/url\?q=([^"&]+)[^"]*"[^>]*>\s*<h3[^>]*>(.*?)<\/h3>/gims;
    let m;
    while ((m = rx.exec(html)) && items.length < 20) {
      const href = decodeURIComponent(m[1]);
      const title = m[2]
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      // Filter out Google/self links and duplicates
      if (!href || !/^https?:\/\//i.test(href)) continue;
      const host = (() => {
        try { return new URL(href).hostname.replace(/^www\./, ""); } catch { return ""; }
      })();
      const key = `${title}::${href}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        title,
        url: href,
        source: host
      });
    }

    // Basic relevancy filter (keep sites with a host and normal-looking title)
    const cleaned = items
      .filter(x => x.title && x.url && x.source && x.title.length > 4)
      .slice(0, max);

    return cleaned;
  } catch (e) {
    console.warn("[Finance] fetchGoogleFinancialTop failed:", e);
    return [];
  }
}


// Always return clickable financial items (never empty)
async function materializeFinancialItems(company = "", aiTitles = [], limit = 8) {
  if (!company) return [];

  // 1) Preferred: Google Search Top results
  try {
    const top = await fetchGoogleFinancialTop(company, limit);
    if (Array.isArray(top) && top.length) return top.slice(0, limit);
  } catch (e) { console.warn("[Finance] top scrape failed:", e); }

  // 2) Fallback: turn AI titles into Google searches
  if (Array.isArray(aiTitles) && aiTitles.length) {
    return aiTitles.slice(0, limit).map(t => ({
      title: String(t || ""),
      url: `https://www.google.com/search?q=${encodeURIComponent(`${company} ${t}`)}`
    }));
  }

  // 3) Last-ditch: deterministic queries
  const keywords = ["earnings","results","revenue","guidance","profit","loss","funding","acquisition"];
  return keywords.slice(0, limit).map(k => ({
    title: `${company} ${k}`,
    url: `https://www.google.com/search?q=${encodeURIComponent(`${company} ${k}`)}`
  }));
}




async function saveProspectAndEnrichment(profile, result) {

  // If enrichment already exists for this prospect, do not overwrite.
  try {
    const { token } = await readSupabaseConfig();
    if (token && profile?.pageUrl) {
      const existing = await (async () => {
        const { url, anon, token: access } = await readSupabaseConfig();
        const headers = { 'apikey': anon, 'Content-Type': 'application/json' };
        if (access) headers['Authorization'] = `Bearer ${access}`;
        const p = await supaSelectOne('prospects', { linkedin_url: profile.pageUrl });
        if (!p?.id) return null;
        const res = await fetch(
          `${url}/rest/v1/enrichments?prospect_id=eq.${encodeURIComponent(p.id)}&select=id&order=created_at.desc&limit=1`,
          { headers }
        );
        if (!res.ok) return null;
        const rows = await res.json();
        return rows[0] || null;
      })();
      if (existing) {
        if (DEBUG_LOGS) console.log('[CRM] saveProspectAndEnrichment: cache present; skipping overwrite');
        return; // respect cache; do not re-save
      }
    }
  } catch (e) {
    if (DEBUG_LOGS) console.warn('[CRM] cache check before save failed:', e);
  }



  if (DEBUG_LOGS) console.log('[CRM] saveProspectAndEnrichment called with:', { profile, result });



  const { token } = await readSupabaseConfig();
  if (!token) { if (DEBUG_LOGS) console.warn('[CRM] No user token; skipping save'); return; }

  const user_id = parseJwtSub(token);
  const linkedin_url = profile?.pageUrl || '';

  let prospect = linkedin_url ? await supaSelectOne('prospects', { linkedin_url }) : null;
  if (!prospect) {
    const inserted = await supaInsert('prospects', {
      user_id,
      name: profile?.name || '',
      role: profile?.role || '',
      company: profile?.company || '',
      linkedin_url,
      location: profile?.location || ''
    });
    prospect = inserted && inserted[0];
    // fallback: if PostgREST didn't return a row, read it back by URL
if (!prospect && linkedin_url) {
  try { prospect = await supaSelectOne('prospects', { linkedin_url }); } catch {}
}

  }
  if (!prospect?.id) return;

    // ---- Ensure "financial" contains linkable results from Google Search ----
  try {
    const companyName = (profile?.company || "").trim();
    if (companyName) {
      // If financial already looks like objects with urls, keep it; otherwise fetch.
      const looksLinked =
        Array.isArray(result?.financial) &&
        result.financial.length > 0 &&
        typeof result.financial[0] === "object" &&
        result.financial[0] !== null &&
        ("url" in result.financial[0] || "link" in result.financial[0]);

      if (!looksLinked) {
        const fin = await fetchGoogleFinancialTop(companyName, 8);
        if (Array.isArray(fin) && fin.length) {
          result.financial = fin; // [{title,url,source}]
        } else {
          result.financial = []; // fallback empty
        }
      } else {
        // Normalize key to "url" if it's "link"
        result.financial = result.financial.map(it => {
          if (it && typeof it === "object") {
            if (it.link && !it.url) return { ...it, url: it.link };
            return it;
          }
          return it;
        });
      }
    }
  } catch (e) {
    console.warn("[Finance] normalization failed:", e);
  }


  await supaInsert('enrichments', {
    prospect_id: prospect.id,
    responsibilities: (result?.responsibilities || '').trim(),
    insights: Array.isArray(result?.insights) ? result.insights : [],
    news: Array.isArray(result?.news) ? result.news : [],
    financial: Array.isArray(result?.financial) ? result.financial : [],
    fit_summary: result?.fitSummary || '',
    fit_badge: result?.fitBadge || '',
    recommended_action: result?.recommendedAction || '',
    reasons: Array.isArray(result?.reasons) ? result.reasons : []

  });
}

async function saveEmailForProspect(profile, emailText, tone='Professional') {
  const { token } = await readSupabaseConfig();
  if (!token) { if (DEBUG_LOGS) console.warn('[CRM] No user token; skipping email save'); return; }

  const user_id = parseJwtSub(token);
  const linkedin_url = profile?.pageUrl || '';

  let prospect = linkedin_url ? await supaSelectOne('prospects', { linkedin_url }) : null;
  if (!prospect) {
    const inserted = await supaInsert('prospects', {
      user_id,
      name: profile?.name || '',
      role: profile?.role || '',
      company: profile?.company || '',
      linkedin_url,
      location: profile?.location || ''
    });
    prospect = inserted && inserted[0];
    // fallback: if PostgREST didn't return a row, read it back by URL
if (!prospect && linkedin_url) {
  try { prospect = await supaSelectOne('prospects', { linkedin_url }); } catch {}
}

  }
  if (!prospect?.id) return;

  await supaInsert('emails', {
    prospect_id: prospect.id,
    user_id,
    tone,
    draft: String(emailText || '')
  });
}






async function refreshAccessToken() {
  const { url, anon, refresh } = await readSupabaseConfig();
  if (!url || !anon || !refresh) throw new Error('Missing URL/anon/refresh token');

  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'apikey': anon,
      'Authorization': `Bearer ${anon}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ refresh_token: refresh })
  });

  if (!res.ok) {
    const t = await res.text().catch(()=>String(res.status));
    throw new Error(`refresh token failed: ${res.status} ${t}`);
  }

  const data = await res.json(); // { access_token, refresh_token?, expires_in, ... }

  // === token usage (from OpenAI) ===
try {
  if (DEBUG_LOGS && data?.usage) {
    console.log('[AI usage] prompt:', data.usage.prompt_tokens,
                'completion:', data.usage.completion_tokens,
                'total:', data.usage.total_tokens);
  }
  // keep a running total
  const inc = (data?.usage?.total_tokens || 0);
  chrome.storage.sync.get(['token_usage_total'], ({ token_usage_total = 0 }) => {
    chrome.storage.sync.set({ token_usage_total: token_usage_total + inc });
  });
} catch (e) {
  console.warn('[AI usage] logging failed:', e);
}





  const newAccess = data.access_token || '';
  if (newAccess) {
    await chrome.storage.sync.set({ supabase_token: newAccess });
  }
  // if Supabase returns a new refresh_token, persist it too
  if (data.refresh_token) {
    await chrome.storage.sync.set({ supabase_refresh: data.refresh_token });
  }
  return newAccess;
}



// ---- Vendor config (per user) ----

// === Fit Summary: cache-first helper ===
// Reuse the most recent enrichment for this prospect; only call AI if none exists.
// Returns an object: { fitSummary, fitBadge, recommendedAction, responsibilities, insights, news, financial }
async function ensureEnrichmentFor(profile) {
  await ensureSettingsLoaded(); // refresh userOptions (apiKey/model/debug)
  const { token } = await readSupabaseConfig();
  if (!token) {
    if (DEBUG_LOGS) console.warn('[CRM] No user token; cannot ensure enrichment');
    return null;
  }

  // 1) Ensure we have (or create) the prospect row
  const user_id = parseJwtSub(token);
  const linkedin_url = profile?.pageUrl || '' ;
  const name     = (profile?.name || '').trim();
const role     = (profile?.role || '').trim();
const company  = (profile?.company || '').trim();
const location = (profile?.location || '').trim();

  
  if (!linkedin_url) return null;

  let prospect = await supaSelectOne('prospects', { linkedin_url });
  if (!prospect) {
    const inserted = await supaInsert('prospects', {
      user_id,
      name: profile?.name || '',
      role: profile?.role || '',
      company: profile?.company || '',
      linkedin_url,
      location: profile?.location || ''
    });
    prospect = inserted && inserted[0];
    if (!prospect) {
      prospect = await supaSelectOne('prospects', { linkedin_url });
    }
  }
  if (!prospect?.id) return null;

  // refresh if role/company changed on LinkedIn since last save
let refreshWanted = false;
try {
  const patch = {};
  if (role && role !== (prospect.role || "")) { patch.role = role; refreshWanted = true; }
  if (company && company !== (prospect.company || "")) { patch.company = company; refreshWanted = true; }
  if (Object.keys(patch).length) {
    await supaUpdate('prospects', prospect.id, patch);
  }
} catch {}


  // 2) Try cache: latest enrichment for this prospect
  try {
    const { url, anon, token: access } = await readSupabaseConfig();
    const headers = { 'apikey': anon, 'Content-Type': 'application/json' };
    if (access) headers['Authorization'] = `Bearer ${access}`;
    const res = await fetch(
      `${url}/rest/v1/enrichments?prospect_id=eq.${encodeURIComponent(prospect.id)}&select=fit_summary,fit_badge,recommended_action,responsibilities,insights,news,financial,created_at&order=created_at.desc&limit=1`,

      { headers }
    );
    if (res.ok) {
  const rows = await res.json();
  const row = rows && rows[0];
  if (row) {
    const ageMs = Date.now() - Date.parse(row.created_at || 0);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (!refreshWanted && ageMs < sevenDays) {
      if (DEBUG_LOGS) console.log('[CRM] Using cached enrichment');
      return row;
    }
  }
}

  } catch (e) {
    if (DEBUG_LOGS) console.warn('[CRM] cache lookup failed:', e);
  }

  

 
  const backgroundList = Array.isArray(profile?.backgroundList) ? profile.backgroundList : [];
  const posts = Array.isArray(profile?.posts) ? profile.posts : [];

  // Build a strict, JSON-only prompt for stable output
 const prompt = `
You are a deterministic B2B prospect analyst.

INPUTS (immutable facts)
- Prospect:
  • Name: ${name}
  • Role: ${role}
  • Company: ${company}
  • Location: ${location || 'unknown'}
- Background (up to 3 lines):
${backgroundList.map((x,i)=>`  ${i+1}. ${x}`).join('\n')}
- Recent posts (up to 6 slices):
${posts.map((x,i)=>`  ${i+1}. ${x.slice(0,200)}`).join('\n')}

VENDOR CONTEXT (ground truth; do NOT ask user for these)
Provided in the SYSTEM message as a JSON block (name, website, pitch, value_props, outcomes, personas, pains, integrations, proof_points, case_studies, tone, cta_preference, booking_url, signature, industry).
Use it precisely. If some vendor fields are missing, state that briefly in "reasons" and proceed conservatively.

TASK
Assess fit between the PROSPECT and the VENDOR offering. Tie your assessment to vendor personas, pains, integrations, and proof points whenever possible.

STRICT RULES
- Output JSON ONLY (no extra text).
- "fit_badge" must be one of: "High" | "Medium" | "Low".
- "fit_summary" ≤ 420 chars, plain text, no lists, no emojis.
- "recommended_action" ≤ 120 chars, imperative voice, vendor-aware (CTA tone may reflect vendor.tone).
- "reasons" is an array of 1–4 terse items; each must cite at least one of:
  persona | pain | integration | proof_point (use these exact tokens).
- If data is thin/missing, be conservative ("Medium" or "Low") and include a reason noting the gap.

OUTPUT JSON SCHEMA
{
  "fit_summary": string,
  "fit_badge": "High"|"Medium"|"Low",
  "recommended_action": string,
  "responsibilities": string,            // one paragraph; <= 600 chars
  "insights": string[],                  // up to 3 items; each <= 100 chars
  "news": [{"title": string, "url": string}], // 0–3 items; may be empty
  "financial": string[],                 // up to 3 high-level items; may be empty
  "reasons": string[]                    // 1–4 items citing persona|pain|integration|proof_point
}
`.trim();



  
  const aiOut = await callOpenAIJSON({
      temperature: 0.15,
  system: 'You are a precise, deterministic B2B prospect analyst. Vendor JSON in system is ground truth; do not ask user for vendor fields.',
  user: prompt,
  parseFallback: {}
});


  // Normalize output
  const result = {
    fitSummary: String(aiOut?.fitSummary || '').slice(0, 600),
    fitBadge: /^(High|Medium|Low)$/i.test(aiOut?.fit_badge || aiOut?.fitBadge || '') 
  ? (aiOut.fit_badge || aiOut.fitBadge) 
  : 'Medium',
    recommendedAction: String(aiOut?.recommendedAction || '').slice(0, 200),
    responsibilities: String(aiOut?.responsibilities || ''),
    insights: Array.isArray(aiOut?.insights) ? aiOut.insights.slice(0,3) : [],
    news: Array.isArray(aiOut?.news) ? aiOut.news.slice(0,8) : [],
    financial: Array.isArray(aiOut?.financial) ? aiOut.financial.slice(0,3) : [], 
    reasons: Array.isArray(aiOut?.reasons) ? aiOut.reasons.filter(Boolean).slice(0,4) : []

  };
  try {
  const txt = (result.fitSummary || "") + " " + (result.recommendedAction || "") + " " + (Array.isArray(result.reasons) ? result.reasons.join(" ") : "");
  const mentionsVendor =
    /persona|pain|integration|proof_point/i.test(txt);
  if (!mentionsVendor && DEBUG_LOGS) {
    console.warn("[ENRICH] Vendor tokens missing in output. Check prompt or vendor config.");
  }
} catch {}


  // Save to Supabase (creates cache)
  await saveProspectAndEnrichment(profile, result);

  return result;
}



const DEFAULT_VENDOR = {
  name: "Your company",
  pitch: "What do you sell",
  valueProps: ["Value proposition"],
  outcomes: ["Your product/Service business result"],
  customerExamples: [],
  industryHint: "Industry"
};

async function readVendorFromStorage() {

  // New source of truth: profiles table (per logged-in user)
  try {
    const { token } = await readSupabaseConfig();
    if (token) {
      // Get user id from JWT (sub)
      const uid = parseJwtSub(token);
      if (uid) {
        const rows = await supaRequest(`/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=` +
  `vendor_name,vendor_pitch,vendor_value_props,vendor_outcomes,vendor_customer_examples,vendor_industry,` +
  `vendor_website,vendor_personas,vendor_icp_industries,vendor_pain_points,vendor_integrations,vendor_proof_points,` +
  `vendor_case_studies,vendor_tone,vendor_cta_preference,vendor_booking_url,vendor_signature,` +
  `remote_enabled,remote_company_id,remote_endpoint,remote_bearer`);

const p = rows && rows[0];


        if (p) {
          const vendor = {
            name: p.vendor_name || DEFAULT_VENDOR.name,
            pitch: p.vendor_pitch || DEFAULT_VENDOR.pitch,
            valueProps: Array.isArray(p.vendor_value_props) ? p.vendor_value_props : DEFAULT_VENDOR.valueProps,
            outcomes: Array.isArray(p.vendor_outcomes) ? p.vendor_outcomes : DEFAULT_VENDOR.outcomes,
            customerExamples: Array.isArray(p.vendor_customer_examples) ? p.vendor_customer_examples : DEFAULT_VENDOR.customerExamples,
            industryHint: p.vendor_industry || DEFAULT_VENDOR.industryHint
            , website: p.vendor_website || "",
  personas: Array.isArray(p.vendor_personas) ? p.vendor_personas : [],
  icpIndustries: Array.isArray(p.vendor_icp_industries) ? p.vendor_icp_industries : [],
  painPoints: Array.isArray(p.vendor_pain_points) ? p.vendor_pain_points : [],
  integrations: Array.isArray(p.vendor_integrations) ? p.vendor_integrations : [],
  proofPoints: Array.isArray(p.vendor_proof_points) ? p.vendor_proof_points : [],
  caseStudies: Array.isArray(p.vendor_case_studies) ? p.vendor_case_studies : [],
  tone: p.vendor_tone || "Professional",
  ctaPreference: p.vendor_cta_preference || "Book a demo",
  bookingUrl: p.vendor_booking_url || "",
  signature: p.vendor_signature || ""

          };

          // Remote override if enabled
          if (p.remote_enabled && p.remote_endpoint) {
            try {
              const headers = { "Content-Type": "application/json" };
              if (p.remote_bearer) headers.Authorization = `Bearer ${p.remote_bearer}`;
              const ep = p.remote_endpoint.replace("{companyId}", (p.remote_company_id || "").trim());
              const r = await fetch(ep, { headers });
              if (r.ok) {
                const j = await r.json();
                const v = j.vendor ? j.vendor : j;
                return { ...DEFAULT_VENDOR, ...vendor, ...v };
              }
            } catch {/* ignore remote failure; keep local vendor */}
          }

          return { ...DEFAULT_VENDOR, ...vendor };
        }
      }
    }
  } catch {/* fall through to old local storage vendor */}


    try {
    // Read local vendor_config + remote controls
    const s = await chrome.storage.sync.get([
      "vendor_config",
      "remote_enabled",
      "remote_companyId",
      "remote_endpoint",
      "remote_token",
      "vendor_schema_version"
    ]);

    const localVendor = (s.vendor_config && (s.vendor_config.vendor || s.vendor_config)) || {};

    // If remote disabled or missing inputs, return local merged with defaults
    const remoteEnabled = !!s.remote_enabled;
    const companyId     = (s.remote_companyId || "").trim();
    const endpoint      = (s.remote_endpoint  || "").trim();
    const token         = (s.remote_token     || "").trim();

    // Try remote override if enabled and we have a companyId+endpoint
    if (remoteEnabled && endpoint) {
      const remote = await fetchRemoteVendor({ endpoint, companyId, token }).catch(() => null);
      if (remote && typeof remote === "object") {
        // The endpoint may return {vendor:{...}} or a flat vendor object
        const v = remote.vendor ? remote.vendor : remote;

        // Optional: version mapping if backend includes schema_version
        const remoteVersion = Number(remote.schema_version || v.schema_version || s.vendor_schema_version || VENDOR_SCHEMA_VERSION) || VENDOR_SCHEMA_VERSION;

        // TODO: if you change schema later, map old→new here based on remoteVersion
        const merged = { ...DEFAULT_VENDOR, ...v };

        // Cache last seen remote version (not required, but handy)
        chrome.storage.sync.set({ vendor_schema_version: remoteVersion }).catch(()=>{});

        return merged;
      }
    }

    // Fallback: local (merged with defaults)
    return { ...DEFAULT_VENDOR, ...localVendor };
  } catch {
    return { ...DEFAULT_VENDOR };
  }

}

async function fetchRemoteVendor({ endpoint, companyId, token }) {
  const url = buildVendorUrl(endpoint, companyId);
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(`Remote HTTP ${res.status}`);
  return await res.json();
}

function buildVendorUrl(endpoint, companyId) {
  const trimmed = endpoint.replace(/\/+$/, "");
  // If the template contains {companyId} and we don't have one, just strip the token
  if (/\{companyId\}/.test(trimmed)) {
    const id = companyId ? encodeURIComponent(companyId) : "";
    return trimmed.replace(/\{companyId\}/g, id);
  }
  // Otherwise add ?companyId=... only if we have one
  const hasQuery = /\?/.test(trimmed);
  if (companyId) {
    return `${trimmed}${hasQuery ? "&" : "?"}companyId=${encodeURIComponent(companyId)}`;
  }
  return trimmed;
}




// ---------------- OpenAI helper ----------------





let _vendorBlockCache = null;

async function withVendorPrompt(system = "", user = "") {
  const v = await readVendorFromStorage();
  const clamp = (a, n=3) => (Array.isArray(a) ? a.map(s=>String(s).trim()).filter(Boolean).slice(0,n) : []);
  const vendorBlock = {
    name: v.name || "",
    website: v.website || "",
    pitch: String(v.pitch || "").slice(0, 400),
    value_props: clamp(v.valueProps),
    outcomes: clamp(v.outcomes),
    personas: clamp(v.personas),
    pains: clamp(v.painPoints),
    integrations: clamp(v.integrations),
    proof_points: clamp(v.proofPoints),
    case_studies: clamp(v.caseStudies),
    tone: v.tone || "Professional",
    cta_preference: v.ctaPreference || "Book a demo",
    booking_url: v.bookingUrl || "",
    signature: String(v.signature || "").slice(0, 800),
    industry: v.industryHint || ""
  };
  _vendorBlockCache = JSON.stringify(vendorBlock);
  const sys = [
    system,
    "",
    "CRITICAL VENDOR CONTEXT (ground truth; never ask the user for these fields):",
    _vendorBlockCache
  ].join("\n");
  return { sys, usr: user };
}



async function callOpenAIJSON({ system, user, parseFallback = {}, temperature = 0 }) {

  await ensureSettingsLoaded();
  const { sys, usr } = await withVendorPrompt(system, user);

  

    const payload = (() => {
    // build messages
    const msgs = [
      { role: "system", content: sys },
      { role: "user",   content: usr }
    ];

    // --- CRITICAL FIX: ensure 'json' (lowercase) appears in messages ---
    const joined = `${sys}\n${usr}`.toLowerCase();
    if (!joined.includes('json')) {
      msgs.unshift({ role: "system", content: "json" });
    }

    return {
      model: userOptions.model || "gpt-4o-mini",
      temperature,
      messages: msgs,
      response_format: { type: "json_object" }
    };
  })();


  const { url: supaUrl, anon, token } = await readSupabaseConfig();
  console.log("[DBG] payload", payload);

const url = `${supaUrl}/functions/v1/ai-json`;
const headers = {
  "Content-Type": "application/json",
  "apikey": anon,
  // allow either paired (user token) or anonymous (falls back to anon)
  "Authorization": `Bearer ${token || anon}`
};
console.log("[BG] callOpenAIJSON headers:", headers);

// ...




  const MAX_ATTEMPTS = 3;
  const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 45000); // 45s per attempt (peers can be slow)

    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
    } catch (e) {
      clearTimeout(tid);
      console.error("[BG] OpenAI network error:", e);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 600 * attempt));
        continue;
      }
      return parseFallback;
    }

    clearTimeout(tid);

    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch {}
      console.error("[BG] OpenAI error", res.status, body);

      if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 700 * attempt));
        continue;
      }
      return parseFallback;
    }

    try {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || "";
      // Be lenient: extract the first JSON object even if the model wrapped it.
let raw = text.trim();
// strip ```json fences if present
const fenced = raw.match(/```json([\s\S]*?)```/i);
if (fenced) raw = fenced[1].trim();
// grab the first {...} block
const m = raw.match(/\{[\s\S]*\}$/);
if (m) raw = m[0];

      return JSON.parse(raw);

    } catch (e) {
      console.warn("[BG] Failed parsing OpenAI JSON:", e);
      return parseFallback;
    }
  }

  return parseFallback;
}


// === OpenAI TTS (cloud) ===
// Uses your existing OPENAI_API_KEY. Outputs base64 MP3 for the content script to play.
// Model options: "gpt-4o-mini-tts" (newer, expressive) or "tts-1" (classic).
// === OpenAI TTS (cloud) ===
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = "alloy";

async function openaiTTS(text, { model = OPENAI_TTS_MODEL, voice = OPENAI_TTS_VOICE } = {}) {
  await ensureSettingsLoaded();
const { url: supaUrl, anon, token } = await readSupabaseConfig();

const res = await fetch(`${supaUrl}/functions/v1/tts`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "apikey": anon,
    "Authorization": `Bearer ${token || anon}`
  },
  body: JSON.stringify({
    text: String(text || "").slice(0, 4000),
    model,
    voice
  })
});

console.log("[DBG] response status", res.status);
console.log("[DBG] response headers", [...res.headers.entries()]);
console.log("[DBG] response raw", await res.clone().text());

if (!res.ok) {
  const t = await res.text().catch(()=>String(res.status));
  throw new Error(`TTS failed: ${res.status} ${t}`);
}
const { audioB64 } = await res.json();
return audioB64;

}


// ---- Let AI decide the query strategy for different situations ----
// ---- Let AI decide the query strategy for different situations (GOOGLE.COM) ----
async function gptBuildNewsQueries({ company, mode = "financial", instruction = "" }) {
  // modes: financial, product, hiring, risk, exec, partnerships, generic
  const system = [
    "You generate Google Web search queries (for google.com/search).",
    "Return strictly JSON: {\"queries\":[\"...\"]}.",
    "Each query must be short, precise, and likely to surface Top Stories.",
    "Honor user instruction exactly (site:, AND/OR, quoted phrases, time hints).",
    "No markdown. No commentary."
  ].join("\n");

  const user = `
Company: ${company}
Mode: ${mode}
UserInstruction: ${instruction || "(none)"}

Rules:
- 3 to 6 queries only.
- Use quoted company name when helpful.
- Prefer boolean operators (AND/OR) and site: filters if relevant.
- Avoid filler like "latest" or "news".
- Assume search will open google.com/search (not Google News RSS).
`.trim();

  const out = await callOpenAIJSON({
    system, user,
    parseFallback: { queries: [] }
  });

  // robust fallback if AI returns nothing
  if (!Array.isArray(out.queries) || out.queries.length === 0) {
    const fallback = {
      financial: [
        `"${company}" earnings OR results OR revenue OR guidance`,
        `"${company}" profit OR loss OR outlook`,
        `"${company}" funding OR acquisition OR IPO OR merger`
      ],
      product: [
        `"${company}" product launch OR feature OR AI`,
        `"${company}" roadmap OR release OR update`,
        `"${company}" integration OR partnership`
      ],
      generic: [
        `"${company}" announcement`,
        `"${company}" interview OR CEO`,
        `"${company}" partnership OR expansion`
      ]
    };
    return fallback[mode] || fallback.generic;
  }

  return out.queries.slice(0, 6);
}

// ---------------- Company Top Stories via GOOGLE.COM (no scraping) ----------------
// ---------------- Company Top Stories (AI queries → RSS to get article links) ----------------
// ---------------- Company Top Stories from GOOGLE.COM (tbm=nws) ----------------
async function gptCompanyTopStories({ company, mode = "product", instruction = "" }) {
  // 1) AI crafts exact queries
const queries = await gptBuildNewsQueries({ company, mode, instruction });

// 2) Try Google.com (tbm=nws)
let aggregated = [];
for (const q of queries) {
  try {
    const items = await openAndScrapeGoogleNews(q); // [{title,link,host}]
    aggregated.push(...items);
  } catch (e) {
    console.warn("[BG] google scrape failed:", e);
  }
}

// 3) Dedupe + limit per domain
const seen = new Set();
const byHost = new Map();
let picked = [];
for (const it of aggregated) {
  const title = (it.title || "").trim();
  const link  = (it.link  || "").trim();
  if (!title || !link) continue;

  const key = title.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);

  const cnt = byHost.get(it.host) || 0;
  if (cnt >= 2) continue;
  byHost.set(it.host, cnt + 1);

  picked.push({ title, link, host: it.host });
  if (picked.length >= 6) break;
}

// 4) If Google returned nothing (DOM changed / blocked), fall back to RSS materialization
if (picked.length === 0) {
  console.warn("[BG] Google scrape returned 0. Falling back to RSS.");
  const viaRss = await materializeArticlesFromQueries(queries);
  const sum = await gptSummarizeHeadlines(viaRss, company);
  return viaRss.slice(0, 6).map((a, i) => ({
    label: a.title,
    summary: sum[i] || "",
    url: a.link
  }));
}

// 5) Summaries for Google-picked items
const summaries = await gptSummarizeHeadlines(picked, company);

// 6) Return the exact shape the UI needs
return picked.map((a, i) => ({
  label: a.title,
  summary: summaries[i] || "",
  url: a.link
}));
}


const normalizeCompany = (s = "") =>
  s.replace(/\s+/g, " ").replace(/[|•–—\-]+.*$/g, "").trim();

// ---------------- Company News via AI-built queries + Google News RSS ----------------
async function gptCompanyNews(company, mode = "product") {
  // 1) ask AI to build 3–6 targeted queries for the chosen mode
  const queries = await gptBuildNewsQueries({ company, mode });

  // 2) fetch/parse RSS for each query
  const aggregated = [];
  for (const q of queries) {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRSSItems(xml);
      aggregated.push(...items);
    } catch (e) {
      console.warn("[BG] Company RSS fetch error:", e);
    }
  }

  // 3) dedupe by title, limit repeats per domain → keep {title,link,host}
const seen = new Set();
const byHost = new Map();
const itemsOut = [];
for (const it of aggregated) {
  const title = (it.title || "").trim();
  const link  = (it.link  || "").trim();
  if (!title || !link) continue;

  const key = title.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);

  const count = byHost.get(it.host) || 0;
  if (count >= 2) continue;
  byHost.set(it.host, count + 1);

  itemsOut.push({ title, link, host: it.host });
  if (itemsOut.length >= 6) break;
}

// 4) summaries
const summaries = await gptSummarizeHeadlines(itemsOut, company);

// 5) return enriched objects
return itemsOut.map((a, i) => ({
  title: a.title,
  summary: summaries[i] || "",
  link: a.link,
  host: a.host
}));

}

// --- RSS helpers ---
function decodeHTML(s = "") {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRSSItems(xml = "") {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag) =>
      (block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] || "";
    const link = decodeHTML(pick("link"));
    let host = "";
    try { host = new URL(link).hostname.replace(/^www\./, ""); } catch {}
    items.push({
      title: decodeHTML(pick("title")),
      link,
      host,
      pubDate: decodeHTML(pick("pubDate"))
    });
  }
  return items;
}

// ---- Wait for a tab to finish loading ----
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const onUpd = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// ---- Open a google.com News result (tbm=nws) and scrape publisher links ----
// ---- Open a google.com News result (tbm=nws) and scrape publisher links ----
async function openAndScrapeGoogleNews(query) {
  const url = "https://www.google.com/search?hl=en&gl=US&tbm=nws&q=" + encodeURIComponent(query);
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    // wait until complete (also handle the 'already complete' race)
    const info = await chrome.tabs.get(tab.id).catch(() => null);
    if (!info || info.status !== "complete") {
      await new Promise((resolve) => {
        const onUpd = (id, details) => {
          if (id === tab.id && details.status === "complete") {
            chrome.tabs.onUpdated.removeListener(onUpd);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpd);
      });
    }

    const [{ result: items = [] } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        // Runs inside google.com
        const clean = (href) => {
          try {
            const u = new URL(href, location.origin);
            // unwrap /url?url=... or /url?q=...
            if (u.hostname === "www.google.com" && u.pathname === "/url") {
              return u.searchParams.get("url") || u.searchParams.get("q") || href;
            }
            return u.href;
          } catch { return href; }
        };
        const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

        const out = [];
        const seen = new Set();

        // 1) Prefer true news results area
        const root = document.querySelector("#search") || document.body;

        // candidates: standard anchors + the news-tab anchors (often no <h3>, only role=heading)
        const candidates = Array.from(root.querySelectorAll("a[href]"));

        for (const a of candidates) {
          let link = a.getAttribute("href") || "";
          if (!link) continue;
          link = clean(link);
          if (!/^https?:\/\//i.test(link)) continue;

          // skip Google-owned links
          const host = hostOf(link);
          if (!host || /(^|\.)google\.(com|[a-z.]+)$/.test(host)) continue;

          // title sources in the news tab vary: <h3>, [role="heading"], or anchor text
          let title = "";
          const h3 = a.querySelector("h3") || a.closest("div")?.querySelector("h3");
          if (h3 && h3.textContent) title = h3.textContent.trim();

          if (!title) {
            const heading = a.querySelector('[role="heading"]') || a.closest("div")?.querySelector('[role="heading"]');
            if (heading && heading.textContent) title = heading.textContent.trim();
          }

          if (!title) {
            const txt = (a.textContent || "").trim().replace(/\s+/g, " ");
            if (txt.length > 20) title = txt;
          }

          if (!title) continue;

          const key = (title + "|" + host).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          out.push({ title, link, host });
          if (out.length >= 10) break;
        }

        return out;
      }
    });

    return items || [];
  } finally {
    try { if (tab?.id) await chrome.tabs.remove(tab.id); } catch {}
  }
}

// --- LinkedIn people-search resolver (pick the first sensible /in/ profile) ---

const _liResolveCache = new Map();

function _isLinkedInPeopleSearch(u = "") {
  try {
    const x = new URL(u);
    return /(^|\.)linkedin\.com$/i.test(x.hostname) && /\/search\/results\/people/i.test(x.pathname);
  } catch { return false; }
}

async function resolveLinkedInPeopleSearch(peopleSearchUrl, { company = "", titleHint = "", avoidName = "" } = {}) {
  if (!_isLinkedInPeopleSearch(peopleSearchUrl)) return null;
  if (_liResolveCache.has(peopleSearchUrl)) return _liResolveCache.get(peopleSearchUrl);

  const tab = await chrome.tabs.create({ url: peopleSearchUrl, active: false });
  const cleanup = async () => { try { tab?.id && await chrome.tabs.remove(tab.id); } catch {} };

  try {
    await waitForTabLoad(tab.id);

    const [{ result: best = null } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (company, titleHint, avoidName) => {
        const norm = s => (s || "").replace(/\s+/g, " ").trim();
        const low  = s => norm(s).toLowerCase();

        const wantCo = low(company);
        const wantTi = low(titleHint);
        const avoid  = low(avoidName);

        // Collect anchors that point to profile pages
        const anchors = Array.from(document.querySelectorAll('a[href*="/in/"]'));
        const items = anchors.map(a => {
          const href = a.getAttribute("href") || "";
          const url = href.startsWith("http") ? href : new URL(href, location.origin).href;
          if (!/\/in\//.test(url)) return null;

          // Heuristic: look at the nearest result container text
          const card = a.closest("[data-chameleon-result-urn], .reusable-search__result-container, .entity-result, li, article") || a;
          const text = norm(card.innerText || a.textContent || "");

          // First non-empty line looks like a name; next lines include title/company
          const lines = text.split("\n").map(norm).filter(Boolean);
          const name = lines[0] || "";

          const titleLine = lines.find(l =>
            /chief|c[io]o|vp|director|head|lead|manager|engineer|product|marketing|sales|success|data|design|owner|founder/i.test(l)
          ) || "";

          const companyLine = lines.find(l => /\bat\b|\s@\s/.test(l)) || "";
          const companyFromText = companyLine.replace(/.*(?:\bat\b|@)\s+/i, "");

          return { url, name, title: titleLine, company: companyFromText, text };
        }).filter(Boolean);

        if (!items.length) return null;

        // Score by relevance to company/title, penalize the current prospect's name if provided
        const ranked = items.map(it => {
          const t = low(it.text);
          let score = 0;
          if (wantCo && t.includes(wantCo)) score += 3;
          if (wantTi && t.includes(wantTi)) score += 2;
          if (avoid && low(it.name).includes(avoid)) score -= 5;
          return { ...it, score };
        }).sort((a, b) => b.score - a.score);

        return ranked[0] || items[0] || null;
      },
      args: [company, titleHint, avoidName]
    });

    if (best && best.url) {
      _liResolveCache.set(peopleSearchUrl, best);
      return best;
    }
    return null;
  } catch {
    return null;
  } finally {
    await cleanup();
  }
}


// ---- Get one-line AI summaries for headlines ----
async function gptSummarizeHeadlines(items = [], company = "") {
  if (!Array.isArray(items) || items.length === 0) {

    return items.map(() => "");
  }

  const system = [
    "You are a news desk assistant.",
    "Given headlines about a target company, write one neutral summary for each, 18–28 words.",
    'Return strictly JSON: {"summaries":["..."]}.',
    "Plain text only. No Markdown."
  ].join("\n");

  const user = JSON.stringify({
    company,
    headlines: items.map(it => it.title).slice(0, 8)
  });

  const out = await callOpenAIJSON({
    system,
    user,
    parseFallback: { summaries: [] }
  });

  const arr = Array.isArray(out.summaries) ? out.summaries : [];
  return items.map((_, i) => (typeof arr[i] === "string" ? arr[i] : ""));
}

// ---- Build article list from AI queries via RSS (to get real article links) ----
async function materializeArticlesFromQueries(queries = []) {
  const aggregated = [];
  for (const q of queries) {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRSSItems(xml); // {title, link, host, pubDate}
      aggregated.push(...items);
    } catch {}
  }
  // dedupe by title, limit repeats per domain
  const seen = new Set();
  const byHost = new Map();
  const out = [];
  for (const it of aggregated) {
    const title = (it.title || "").trim();
    const link  = (it.link  || "").trim();
    if (!title || !link) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const cnt = byHost.get(it.host) || 0;
    if (cnt >= 2) continue;
    byHost.set(it.host, cnt + 1);

    out.push({ title, link, host: it.host });
    if (out.length >= 8) break; // cap
  }
  return out;
}



// Build deduped news items (title + direct link) from Google News RSS
async function gptCompanyNewsItems(company, mode = "product", limit = 6, instruction = "") {
  const queries = await gptBuildNewsQueries({ company, mode, instruction });

  const aggregated = [];
  for (const q of queries) {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRSSItems(xml);
      aggregated.push(...items);
    } catch (e) {
      console.warn("[BG] Company RSS fetch error:", e);
    }
  }

  // dedupe by title + limit per domain
  const seen = new Set();
  const byHost = new Map();
  const out = [];
  for (const it of aggregated) {
    const title = (it.title || "").trim();
    if (!title) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const count = byHost.get(it.host) || 0;
    if (count >= 2) continue;
    byHost.set(it.host, count + 1);

    out.push({ title, link: it.link, host: it.host });
    if (out.length >= limit) break;
  }

  return out;
}

// Return [{label, summary, url}] using RSS items + AI headline summaries
async function gptCompanyNewsWithSummaries(company, mode = "product", limit = 5, instruction = "") {
  const items = await gptCompanyNewsItems(company, mode, limit, instruction);
  const out = [];
  for (const it of items.slice(0, limit)) {
    const { summary, url } = await gptNewsSummary({ company, headline: it.title, link: it.link });
    out.push({ label: it.title, summary, url: url || it.link });
  }
  return out;
}


// ---------------- Financial News via Google News RSS ----------------
// ---- Financial news using AI-built queries + Google News RSS ----
async function gptFinancialNews(company) {
  const FIN_RE = /(earnings|results|revenue|guidance|profit|loss|funding|acquisition|acquires|merger|ipo|m&a)/i;

  // 1) let AI produce 3–6 precise queries for financial mode
  const queries = await gptBuildNewsQueries({ company, mode: "financial" });

  // 2) fetch/parse RSS for each query
  const aggregated = [];
  for (const q of queries) {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRSSItems(xml); // assumes you already have parseRSSItems
      aggregated.push(...items);
    } catch (e) {
      console.warn("[BG] Financial RSS fetch error:", e);
    }
  }

  // 3) filter: clearly financial, dedupe by title, limit length
  const seen = new Set();
  const out = [];
  for (const it of aggregated) {
    const title = (it.title || "").trim();
    if (!title) continue;
    if (!FIN_RE.test(title)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // clip to 16 words, titles only (no URLs)
    const words = title.split(/\s+/);
    const clipped = words.length > 16 ? words.slice(0, 16).join(" ") + "…" : title;
    out.push(clipped);
    if (out.length >= 5) break;
  }

  return out;
}



// Summarize one company-related headline and prefer a direct article link
async function gptNewsSummary({ company = "", headline = "", link = "" } = {}) {
  const url = link || "https://www.google.com/search?q=" + encodeURIComponent((company ? company + " " : "") + headline);
  if (!headline) return { summary: "", url };


  const system = [
    "You write careful, neutral news abstracts.",
    "You DO NOT have web access. Do not claim to have read the article.",
    "Return strictly JSON: {\"summary\":\"...\"}.",
    "If the headline lacks context, say what's likely, note uncertainty, and keep it concise."
  ].join("\n");

  const user = `
Company: ${company}
Headline: ${headline}

Task:
- Write 2 short paragraphs (max ~120 words total).
- Base only on the headline and widely known context; avoid fabricating specifics.
- If uncertain, state that clearly.
`.trim();

  const out = await callOpenAIJSON({
    system,
    user,
    parseFallback: { summary: "" }
  });

  return { summary: out.summary || "", url };
}



async function gptResponsibilitiesRich({ role = "", company = "", background = [] } = {}) {
  if (!role) return "";


  // Use your saved vendor profile so the analysis is industry-aware
  const v = await readVendorFromStorage();

  const system = [
    "You are a sales intelligence analyst.",
    "Return strictly JSON: {\"text\":\"...\"} where `text` is the FULL response.",
    "PLAIN TEXT ONLY — no Markdown, no asterisks, no bold, no headers.",
    "Insert ONE BLANK LINE between each numbered item.",
    "Keep it concise, scannable, and prioritized for " + (v.industryHint || "the vendor’s industry") + " relevance."
  ].join("\n");

  const user = `
You analyze a person's likely job responsibilities to assess buying influence for "${v.name || "our solution"}".

Inputs:
- Job Title: ${role}
- Company: ${company}
- Previous Experience (most recent first):
${Array.isArray(background) && background.length ? background.map((l,i)=>`${i+1}. ${l}`).join("\n") : "None provided"}
- Vendor context:
  • What we sell: ${v.pitch || "—"}
  • Value props: ${(v.valueProps || []).slice(0,5).join("; ") || "—"}
  • Outcomes: ${(v.outcomes || []).slice(0,5).join("; ") || "—"}
  • Industry hint: ${v.industryHint || "—"}

Instructions:
- Output 5–8 specific, concrete responsibilities this person is likely to have, ordered by relevance to the vendor context.
- Include a confidence percentage (0–100%) and a short reasoning tied to the inputs (title, company, background, industry norms).
- If inferring, label "Guess" and explain why it’s reasonable.
- PLAIN TEXT ONLY. ONE BLANK LINE between items.
`.trim();

  const out = await callOpenAIJSON({
    system,
    user,
    parseFallback: { text: "" }
  });

  return typeof out.text === "string" ? out.text : "";
}


  
// AI Fit Summary from responsibilities text
async function gptFitSummaryFromResponsibilities({ responsibilities = "", role = "", company = "" } = {}) {
  if (!responsibilities) {
    return { fitLevel: "", confidence: 0, reasoning: "", notes: "", summaryLine: "" };
  }

  const system = [
    "You are a B2B sales intelligence expert.",
    "Return strictly JSON with these fields:",
    "{\"fitLevel\":\"Low|Medium|High|Highest\",\"confidence\":NUMBER,\"reasoning\":\"...\",\"notes\":\"...\",\"summaryLine\":\"Fit: [Low/Medium/High/Highest] → Reasoning: ...\"}",
    "Plain text only (no Markdown)."
  ].join("\n");

  const user = [
    "Evaluate whether the person is a potential buyer for a product or service based on their job responsibilities.",
    "Follow the rules:",
    "1) Decide if they have buying authority, influence, or budget control.",
    "2) Classify fit: Low | Medium | High | Highest.",
    "3) Explain WHY using evidence from responsibilities.",
    "4) Clarify if this is strong reasoning or educated guessing.",
    "5) End with a clear summary statement as: Fit: [Level] → Reasoning: ...",
    "",
    `Role: ${role}`,
    `Company: ${company}`,
    "",
    "Job Responsibilities:",
    responsibilities
  ].join("\n");

  const out = await callOpenAIJSON({
    system,
    user,
    parseFallback: { fitLevel: "", confidence: 0, reasoning: "", notes: "", summaryLine: "" }
  });

  // Normalize types
  const lvl = (out.fitLevel || "").trim();
  return {
    fitLevel: lvl,
    confidence: Number(out.confidence || 0),
    reasoning: (out.reasoning || "").trim(),
    notes: (out.notes || "").trim(),
    summaryLine: (out.summaryLine || "").trim()
  };
}

// Extract insights from recent LinkedIn activity (posts user wrote/shared/liked)
async function gptInsights(posts = [], profile = {}) {
    const v = await readVendorFromStorage();

  if (!Array.isArray(posts) || posts.length === 0) return [];
  const trimmed = posts.slice(0, 15);

  const system = [
    "You analyze a person's LinkedIn activity, including comments, likes, reposts, shares and others. All linkedin activity.",
    "Return up to 4 concrete insights about themes, posts commented, interests, tools, or markets they care about. Organize them in timestamp order",
    "Each bullet must be <= 18 words, neutral and specific. Do not invent facts not evident from snippets.",
    "Output JSON strictly as {\"items\":[\"...\",\"...\"]}.",
    "If profile/company context is broad, prefer insights that are relevant to: " + (v.industryHint || "the seller's industry") + "."

  ].join("\n");

  const user = JSON.stringify({
    profile: {
      name:  profile?.name  || "",
      role:  profile?.role  || "",
      company: profile?.company || ""
    },
    activity_snippets: trimmed
  });

  const out = await callOpenAIJSON({ system, user, parseFallback: { items: [] } });
  return Array.isArray(out.items) ? out.items.filter(Boolean).slice(0, 4) : [];
}

// Prospecting email (120–160 words, friendly first-touch)
// Small helper to extract a safe first name
function firstNameOf(full = "") {
  const n = (full || "").trim().split(/\s+/);
  return n[0] || "";
}

/**
 * Prospecting email generator (vendor-agnostic, role-tailored, industry-safe peers, clear CTA)
 *
 * inputs.vendor is optional and can include:
 * {
 *   name: "Amplitude",                            // or any vendor; defaults to "our platform"
 *   pitch: "a product analytics platform...",     // one short phrase used once
 *   valueProps: ["identify friction", "optimize adoption", "measure impact"], // bullets/phrases
 *   outcomes: ["conversion", "retention"],        // business outcomes to reference
 *   customerExamples: ["Tesco", "Sainsbury's"],   // ONLY these may be name-dropped
 *   industryHint: "UK grocery retail"             // helps choose category phrasing if examples absent
 * }
 */
async function gptEmail({ profile = {}, inputs = {}, tone = "Professional" } = {}) {
  

  const { name = "", role = "", company = "", location = "" } = profile || {};
  const firstName = firstNameOf(name);

  const {
    responsibilities = [],
    insights = [],
    news = [],
    financial = [],
    background = [],
    vendor = {}
  } = inputs || {};

  const vendorName = (vendor.name || "").trim();
  const vendorPitch = (vendor.pitch || "a platform that helps teams identify bottlenecks, optimize journeys, and measure impact").trim();
  const valueProps = Array.isArray(vendor.valueProps) && vendor.valueProps.length
    ? vendor.valueProps.slice(0, 5)
    : ["identify friction", "optimize adoption", "improve retention", "measure impact", "align teams on product KPIs"];
  const outcomes = Array.isArray(vendor.outcomes) && vendor.outcomes.length
    ? vendor.outcomes.slice(0, 5)
    : ["conversion", "retention", "time-to-value"];
  const customerExamples = Array.isArray(vendor.customerExamples) ? vendor.customerExamples.slice(0, 4) : [];
  const industryHint = (vendor.industryHint || "").trim();
  const website     = (vendor.website || "").trim();
const bookingUrl  = (vendor.bookingUrl || "").trim();
const ctaPref     = (vendor.ctaPreference || "Book a demo").trim();
const signature   = (vendor.signature || "").trim();


  // ---- System prompt: JSON-only, role-tailored, peer-safe, clear CTA ----
  const system = [
    "You are a senior SDR writing a concise, friendly first-touch prospecting email.",
    "Return strictly JSON: {\"email\":\"...\"}. No other fields. No markdown. No emojis.",
    "Length: 120–150 words total.",
    "Tone: " + tone + ", clear, specific, value-led.",
    "Personalization rules:",
    "- Start with `${firstName},` (use 'Hi there,' if empty).",
    "- Derive the opening problem statement from the provided responsibilities, news, and financial signals for the prospect’s role at their current company.",
    "- If responsibility signals are thin/uncertain, use cautious phrasing (e.g., 'is it fair to say your focus includes…').",
    "Peer example rules (CRITICAL):",
    "- Only reference peer companies included in user-provided customerExamples.",
    "- If NONE are provided, DO NOT guess names; instead use category phrasing like 'other leaders in " + (industryHint || "your industry") + "'.",
    "- Never mention FanDuel, Betclic, Atlassian, PayPal, or any brand unless it appears in customerExamples.",
    "Vendor rules:",
    "- Refer to the offering as " + (vendorName ? vendorName : "our platform") + " and one short pitch once: \"" + vendorPitch + "\".",
    "- Emphasize up to 2 value props from the provided list and tie them to outcomes.",
    "CTA rules (CRITICAL):",
    "- Use this CTA preference verbatim in the closing ask: " + ctaPref + ".",
"- If a booking URL is provided, include it in the CTA once: " + (bookingUrl || "(none)") + ".",
"- If a website is provided, include it once as a reference in the body: " + (website || "(none)") + ".",
"- End the email with this signature block exactly if provided (after 'Best,'): " + (signature ? JSON.stringify(signature) : "\"\"") + ".",
    "- End with ONE clear, friendly, time-bound ask for a 15–20 minute call next week (offer two options), or invite a referral if they’re not the right person.",
    "- Example CTA style: 'Open to 15 minutes Tue or Wed afternoon next week?'",
    "Other constraints:",
    "- No placeholders like [Name]. Use the provided first name string.",
    "- Do not claim you read full articles; base on signals only.",
    "- Do not invent metrics, tools, or customers.",
    "- Close with 'Best,' (no signature block)."
  ].join("\n");

  // ---- User payload: all the signals we have ----
  const user = JSON.stringify({
    profile: {
      firstName,
      fullName: name,
      role,
      company,
      location
    },
    signals: {
      responsibilities,  // free text list or single string
      insights,          // short bullets about interests/activity
      news,              // headlines list (strings)
      financial,         // financial headlines (strings)
      background         // career lines
    },
    vendor: {
      name: vendorName || "our platform",
      pitch: vendorPitch,
      valueProps,
      outcomes,
      customerExamples,  // <- only safe names to reference
      industryHint       // <- helps with category phrasing
    }
  });

  const out = await callOpenAIJSON({
    system,
    user,
    parseFallback: { email: "" }
  });


let body = String(out.email || "").trim();

// — Normalize escaped characters to real newlines/tabs —
body = body
  .replace(/\r/g, "")
  .replace(/\\n/g, "\n")
  .replace(/\\t/g, "\t")
  .replace(/\n{3,}/g, "\n\n"); // collapse 3+ blank lines


// Ensure website present once
if (website && !/https?:\/\//i.test(website) && !body.includes(website)) {
  body += `\n\nMore about us: ${website}`;
} else if (website && !body.includes(website)) {
  body += `\n\nMore about us: ${website}`;
}

// Ensure booking URL present once
if (bookingUrl && !body.includes(bookingUrl)) {
  body += `\n\nQuick scheduling link: ${bookingUrl}`;
}

// Ensure signature appended after "Best," style closing if signature exists
const safeSignature = signature ? String(signature).replace(/\\n/g, "\n").trim() : "";
if (safeSignature && !body.includes(safeSignature)) {
  if (!/(\n|^)Best,/.test(body)) body += `\n\nBest,`;
  body += `\n${safeSignature}`;
}


out.email = body;



  return out.email || "";
  

}


function fitFromRole(roleRaw = "") {
  if (!roleRaw) return { fitBadge: "—", summary: "—", reco: "—" };
  const role = roleRaw.toLowerCase();
  const senior = /chief|c[io]o|vp|head|director/.test(role);
  if (/procurement|purchas|sourcing|buyer/.test(role))
    return { fitBadge: "High Fit", summary: "Direct buyer persona.", reco: "Lead with ROI & risk reduction." };
  if (/finance|cfo|fp&a|controller/.test(role))
    return { fitBadge: senior ? "High Fit" : "Medium Fit", summary: "Budget owner focus.", reco: "Quantify savings & payback." };
  if (/engineer|developer|analyst|tester|designer/.test(role))
    return { fitBadge: "Low Fit", summary: "Practitioner; limited authority.", reco: "Create an internal champion." };
  return { fitBadge: senior ? "High Fit" : "Medium Fit", summary: "Potential stakeholder.", reco: "Propose short discovery." };
}

function recoForFit(level = "") {
  const l = (level || "").toLowerCase();
  if (l === "highest") return "Drive budget & timeline. Propose a pilot.";
  if (l === "high")     return "Lead with ROI and proof. Align stakeholders.";
  if (l === "medium")   return "Nurture & find a champion. Propose short discovery.";
  if (l === "low")      return "Create an internal champion.";
  return "Propose short discovery.";
}


// ---- Vendor-aware Action Plan (paragraph + 3–5 bullets + CTA line) ----
async function gptActionPlan({ profile = {}, inputs = {}, fitBadge = "" } = {}) {
  await ensureSettingsLoaded();

  const system = [
  "You are a senior B2B sales strategist, you are always explaining the action plan on how to sell to this prospect, if this is not a good buyer, then reference that. never talk as the vendor, but always as your are explaining to the vendor. Return STRICT JSON only.",
  "The system includes a CRITICAL VENDOR CONTEXT JSON block (ground truth).",
  "Vendor JSON is authoritative. Never ask for vendor fields. Never invent customers.",
  "",
  "Your job: craft a short rationale paragraph + 3–5 very tactical next steps + one CTA sentence.",
  "Audience is the seller (the vendor team), not the prospect. Never address the prospect directly. No greetings, no 'let’s', no scheduling language, no sign-offs. Write in third-person (about the prospect) and imperative bullets for the seller.",
  "Fuse vendor value_props → outcomes with THIS prospect’s role, responsibilities, posts/news, and company context.",
  "Be decisive but honest about uncertainty; if the contact is not the buyer, include a referral/multithread step.",
  "",
  "Bullets quality bar (principles, not templates):",
  "- Each bullet starts with a strong verb and is 10–16 words.",
  "- At least one bullet targets referral or multithreading to titles in vendor.personas when buyer mismatch.",
  "- At least one bullet leverages vendor.integrations OR vendor.proof_points/case_studies (only those provided).",
  "- At least one bullet asks a crisp discovery question tied to their role/company signals.",
  "- No fluff, no emojis, no claims of reading full articles.",
  "",
  "CTA is an internal next step for the seller (e.g., 'map stakeholders', 'prep a 15-min discovery outline'), not a message to the prospect. One sentence. Text only.",
  "If vendor.booking_url exists, you MAY include it inline as plain text in the CTA sentence.",
  "",
  "Output JSON exactly:",
  "{",
  '  "paragraph": "80–120 words tying the vendor offer to this prospect/company. Plain text only.",',
  '  "bullets": ["3–5 concrete next steps, each 10–16 words"],',
  '  "cta_line": "≤ 140 chars, friendly, time-bound, single sentence (text only)"',
  "}",
  "",
  "Self-check before answering:",
  "- Paragraph references a specific prospect cue (role, responsibility, post, news) and vendor value_props→outcomes.",
  "- Bullets follow the quality bar and include referral/multithread when appropriate.",
  "- CTA uses vendor.cta_preference and includes booking_url if present.",
  "- Never invent customers; only use proof_points/case_studies that exist in vendor JSON."
].join("\n");


  const user = JSON.stringify({
    fit_badge: fitBadge || "",
    profile: {
      name: profile?.name || "",
      role: profile?.role || "",
      company: profile?.company || "",
      location: profile?.location || ""
    },
    signals: {
      responsibilities: inputs?.responsibilities || "",
      insights: Array.isArray(inputs?.insights) ? inputs.insights.slice(0, 10) : [],
      news: Array.isArray(inputs?.news) ? inputs.news.slice(0, 8) : [],
      financial: Array.isArray(inputs?.financial) ? inputs.financial.slice(0, 8) : [],
      background: Array.isArray(inputs?.background) ? inputs.background.slice(0, 12) : []
    }
  });

  const out = await callOpenAIJSON({
    system,
    user,
    parseFallback: { paragraph: "", bullets: [], cta_line: "" },
    temperature: 0.15
  });

  return {
    paragraph: String(out?.paragraph || ""),
    bullets: Array.isArray(out?.bullets) ? out.bullets : [],
    cta_line: String(out?.cta_line || "")
  };
}


// ---------------- Enricher ----------------
async function enrichProfile(payload) {
  await ensureSettingsLoaded();
    const vendor = await readVendorFromStorage();


  const p = payload?.profile || {};
    const posts = Array.isArray(p.posts) ? p.posts : [];
  let company = normalizeCompany(p.company || "");
  if (!company && Array.isArray(p.experiences)) {
    for (const line of p.experiences) {
      const parts = (line || "").split(" — ").map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) { company = normalizeCompany(parts[1]); break; }
    }
  }

const newsEngine = payload?.mode?.engine || "google_top";   // "google_top" | "news_rss"
const newsMode   = payload?.mode?.news   || "product";
const newsNote   = payload?.mode?.instruction || (vendor.industryHint ? `Prioritize items relevant to ${vendor.industryHint}.` : "");

const newsPromise = (newsEngine === "google_top")
  ? gptCompanyTopStories({ company, mode: newsMode, instruction: newsNote })
  : gptCompanyNewsWithSummaries(company, newsMode, 5, newsNote);



const [newsCards, finTitles, responsibilitiesText, insights] = await Promise.all([
  newsPromise,
  gptFinancialNews(company), // returns array of strings (titles)
  gptResponsibilitiesRich({
    role: p.role || "",
    company,
    background: Array.isArray(p.experiences) ? p.experiences : []
  }),
  gptInsights(posts, p)
]);

const financialItems = await materializeFinancialItems(company, finTitles, 8);



// Last-ditch fallback: if AI returned nothing but we have a role/company, synthesize concise, generic responsibilities.
let _responsibilities = (responsibilitiesText || "").trim();
console.log("[BG] responsibilities (final to UI):", (_responsibilities || "").slice(0, 140));

if (!_responsibilities && (p.role || company)) {
  const who = [p.role, company].filter(Boolean).join(" — ");
  _responsibilities = [
    "Job Responsibilities (with Confidence Levels):",
    `1) Prospects and qualifies opportunities aligned to ICP; runs discovery and pain qualification. [High]`,
    `2) Leads product demos, value mapping, and objection handling; collaborates with SEs. [Medium]`,
    `3) Builds multi-threaded relationships with economic and technical buyers; navigates procurement. [Medium]`,
    `4) Forecasts pipeline, updates CRM hygiene, and manages deal stages to close. [High]`,
    `5) Partners with Marketing/CS on handoffs, pilots, and expansions; gathers customer feedback. [Medium]`,
    "",
    `Target: ${who}`
  ].join("\n");
}


// AI Fit from the AI Responsibilities
let fitBadge = "", fitSummary = "", recommendedAction = "";
let actionParagraph = "";
let actionBullets = [];
let actionCta = "";

try {
  const aiFit = await gptFitSummaryFromResponsibilities({
    responsibilities: _responsibilities,
    role: p.role || "",
    company
  });
  if (aiFit.fitLevel) {
    fitBadge = `${aiFit.fitLevel} Fit`;
    const conf = (aiFit.confidence || 0);
    // Show confidence + the core reasoning in the banner text
    fitSummary = (conf ? `Confidence ${conf}% — ` : "") + (aiFit.reasoning || aiFit.summaryLine || "");
    recommendedAction = recoForFit(aiFit.fitLevel);
  }
} catch (e) {
  console.warn("[BG] AI fit failed, falling back to role-based:", e);
}

// Build vendor-aware Action Plan (paragraph + bullets + CTA) using all signals
try {
  const bgAll = [
    ...(Array.isArray(p.experiences) ? p.experiences : []),
    ...(Array.isArray(p.education) ? p.education : [])
  ].slice(0, 12);

  const plan = await gptActionPlan({
    profile: p,
    inputs: {
      responsibilities: _responsibilities,
      insights,
      news: newsCards,
      financial: financialItems,
      background: bgAll
    },
    fitBadge: (fitBadge || "").replace(/\s*fit\s*$/i, "")
  });

  actionParagraph = String(plan.paragraph || "").slice(0, 800);
  actionBullets = Array.isArray(plan.bullets) ? plan.bullets.filter(Boolean).slice(0, 5) : [];
  actionCta = String(plan.cta_line || "").slice(0, 240);

  
} catch (e) {
  if (DEBUG_LOGS) console.warn("[BG] Action Plan generation failed:", e);
}


  const fit = fitFromRole(p.role || "");
  const background = [
    ...(Array.isArray(p.experiences) ? p.experiences : []),
    ...(Array.isArray(p.education)   ? p.education   : [])
  ].slice(0, 12);

  return {
  ok: true,
  result: {
    news: newsCards,
    financial: financialItems,
    responsibilities: _responsibilities,
    insights,
    fitSummary: fitSummary || fit.summary,
    fitBadge: fitBadge || fit.fitBadge,
    recommendedAction: recommendedAction || fit.reco,
    actionPlan: {
  paragraph: actionParagraph,
  bullets: actionBullets,
  cta: actionCta
},

    background,
    reasons: { noCompany: !company }

  }
};
}

// ---- Prospect & Account 2-page brief (JSON fields, no hallucinations) ----
async function gptProspectAccountBrief({ profile = {}, inputs = {} } = {}) {
  await ensureSettingsLoaded();
  

  const {
    responsibilities = "",    // free text ok
    insights = [],            // [], bullets ok
    news = [],                // can be [{title,summary,url}] or strings
    financial = [],
    background = [],
    fit = {}                  // { badge, summary, recommendedAction }
  } = inputs || {};

  const system = [
    "You are an assistant that generates concise, sales-ready prospect and account briefs.",
    "Your goal: produce a 2-page document (Page 1: Prospect Intel, Page 2: Account Intel) to help a sales rep personalize outreach and prep discovery.",
    "Rules:",
    "- Keep each section short, scannable, relevant.",
    "- Use bullet points wherever possible.",
    "- Do NOT invent facts. If data is missing, leave the field empty or [].",
    "- Output strictly JSON with the fields shown below. No markdown."
  ].join("\n");

  const userPayload = {
    profile: {
      prospect_name: profile.name || "",
      prospect_title: profile.role || "",
      prospect_company: profile.company || "",
      prospect_location: profile.location || ""
    },
    signals: {
      responsibilities,
      insights,
      news,
      financial,
      background,
      fit
    },
    template_keys: {
      page1: {
        prospect_role_summary: true,
        prospect_experience: true,
        prospect_skills: true,
        prospect_connections_or_activity: true,
        hooks: true
      },
      page2: {
        company_overview: true,
        company_recent_news: true,
        company_challenges: true,
        company_tech_stack: true,
        company_metrics: true,
        company_sales_opportunity: true,
        discovery_questions: true
      }
    }
  };

  const user = `
Github code: You are an assistant that generates concise, sales-ready prospect and account briefs.

Guidelines:
- Keep each section short, scannable, and relevant.
- Use bullet points wherever possible.
- Do not invent facts. Only use the provided input data.
- If data is missing, leave the section blank (do not hallucinate).
- Output should be formatted in JSON with fields below.

### Page 1: Prospect Intel
- Name: {{prospect_name}}
- Title & Company: {{prospect_title}}, {{prospect_company}}
- Location: {{prospect_location}}
- Summary of Role: {{prospect_role_summary}}
- Career Highlights: {{prospect_experience}}
- Skills & Interests: {{prospect_skills}}
- Conversation Hooks: {{prospect_connections_or_activity}}
- Personalization Angles (AI-generated hooks for outreach): {{hooks}}

### Page 2: Account Intel
- Company Overview: {{company_overview}}
- Strategic Moves / News: {{company_recent_news}}
- Pain Points / Challenges: {{company_challenges}}
- Current Tools / Tech Stack: {{company_tech_stack}}
- Relevant Metrics: {{company_metrics}}
- Opportunity for Us (Sales Angle): {{company_sales_opportunity}}
- Suggested Discovery Questions: {{discovery_questions}}

Return JSON strictly:
{
  "page1": {
    "prospect_name": "",
    "prospect_title": "",
    "prospect_company": "",
    "prospect_location": "",
    "prospect_role_summary": "",
    "prospect_experience": [],
    "prospect_skills": [],
    "prospect_connections_or_activity": [],
    "hooks": []
  },
  "page2": {
    "company_overview": "",
    "company_recent_news": [],
    "company_challenges": [],
    "company_tech_stack": [],
    "company_metrics": "",
    "company_sales_opportunity": "",
    "discovery_questions": []
  }
}

Input JSON:
${JSON.stringify(userPayload)}
`.trim();

  const out = await callOpenAIJSON({
    system,
    user,
    parseFallback: {
      page1: {
        prospect_name: profile.name || "",
        prospect_title: profile.role || "",
        prospect_company: profile.company || "",
        prospect_location: profile.location || "",
        prospect_role_summary: "",
        prospect_experience: [],
        prospect_skills: [],
        prospect_connections_or_activity: [],
        hooks: []
      },
      page2: {
        company_overview: "",
        company_recent_news: [],
        company_challenges: [],
        company_tech_stack: [],
        company_metrics: "",
        company_sales_opportunity: "",
        discovery_questions: []
      }
    }
  });

  return out;
}

// ---- Lightweight chatbot sessions (per tab) ----
const chatSessions = new Map(); // key: tabId -> { ctx, history: [{role, content}], collected: {} }

async function gptChatbotReply({ ctx = {}, history = [], collected = {} } = {}) {

  const vendor = await readVendorFromStorage();

  // --- Minimal vendor guard (chat replies)
if (!vendor?.name || !String(vendor.name).trim()) {
  return {
    reply: "No vendor profile found — please set at least your company in Vendor Profile.",
    followups: ["Open Vendor Profile", "What info do you need from me?"],
    updates: {}
  };
}


  if (DEBUG_LOGS) console.log("[DBG] CHAT vendor:", vendor, "ctx:", ctx);


  // Lawrence drives toward the same 2-page brief used by the overlay.
  // He sees what we already scraped (ctx) + what we've already collected in chat (collected) + last ~14 turns.
  const system = [
    "You are Lawrence — a proactive Jarvis/FRIDAY-style sales copilot embedded on LinkedIn. Call the operator 'Boss'.",
    "Clearly separate: OUR COMPANY (the seller) vs THEIR COMPANY (the LinkedIn target).",
    "OUR COMPANY (seller): " + (vendor.name || "—") + " — " + (vendor.pitch || ""),
    "Vendor value props: " + ((vendor.valueProps || []).slice(0,5).join("; ") || "—"),
    "Vendor outcomes: " + ((vendor.outcomes || []).slice(0,5).join("; ") || "—"),
    "Industry hint: " + (vendor.industryHint || "—"),
    "THEIR COMPANY (prospect): comes from ctx.company.",
    "Goal: answer the user’s question directly using scraped profile (ctx) and the vendor JSON. Only ask at most one short follow-up if their question truly cannot be answered without it.",
    "Rules:",
    "- NEVER invent facts. Prefer answering with available info; only ask one precise follow-up if essential.",
    "- Use ctx.name/role/company/location when present.",
    "- Keep answers sales-useful (crisp bullets or a short paragraph).",
    "- Suggest at most 3 quick-actions as FOLLOWUPS.",
    "- Plain text only. No Markdown, no asterisks. Use short paragraphs and line breaks for bullets.",
    'Return STRICT JSON only: {"reply":"...","followups":["..."],"updates":{}}.'
  ].join("\n");



  const user = JSON.stringify({
  ctx,
  collected,
  vendor: {
    name: vendor.name,
    pitch: vendor.pitch,
    valueProps: vendor.valueProps,
    outcomes: vendor.outcomes,
    customerExamples: vendor.customerExamples,
    industryHint: vendor.industryHint
  },
  history
});


    const out = await callOpenAIJSON({
    system,
    user,
    parseFallback: {
      reply: "Ask me anything about this person or their company — I’ll answer directly using profile + our vendor context.",
      followups: [
        "Show recent company news",
        "Summarize responsibilities",
        "What are their current challenges?"
      ],
      updates: {}
    }
  });


  return {
    reply: (out.reply || "").trim(),
    followups: Array.isArray(out.followups) ? out.followups.filter(Boolean).slice(0, 3) : [],
    updates: (typeof out.updates === "object" && out.updates) ? out.updates : {}
  };
}



// ---------------- Router ----------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // -- activity logging: write to activity_log table
  if (msg?.type === "SPA_ACTIVITY_LOG") {
    (async () => {
      try {
        const { token } = await readSupabaseConfig();
        if (!token) return void sendResponse({ ok: false, error: "Not paired" });

        const user_id = parseJwtSub(token) || null;
        const payload = msg?.payload || {};
        const row = {
          user_id,
          event: String(payload.event || "profile_view"),
          prospect_url: String(payload.prospect_url || ""),
          prospect_name: String(payload.prospect_name || ""),
          prospect_company: String(payload.prospect_company || ""),
          created_at: new Date().toISOString()
        };

        await supaInsert('activity_log', row);
        return void sendResponse({ ok: true });
      } catch (e) {
        return void sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // keep channel open for async sendResponse
  }


  (async () => {
    try {

      // Gate everything except overlay toggle + cloud TTS until paired
const paired = await new Promise((res) => {
  chrome.storage.sync.get({ supabase_token: "" }, (r) => res(!!r.supabase_token));
});

// Allow overlay toggle and TTS even if not paired,
// but block generation/chat/save routes below.
const ALLOW_UNPAIRED = new Set(["SPA_DEVICE_LOGIN", "SPA_TTS_REQUEST", "SPA_GET_SETTINGS"]);

if (!paired && !ALLOW_UNPAIRED.has(msg?.type)) {
  return void sendResponse({ ok: false, error: "Not paired. Open the web app → Pair Extension to connect." });
}

      // 1) Overlay toggle – relay to content script in this tab
      if (msg?.type === "SPA_TOGGLE_OVERLAY") {
        try {
          const tabId =
            (_sender && _sender.tab && _sender.tab.id)
              ? _sender.tab.id
              : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

          if (tabId) {
            await chrome.tabs.sendMessage(tabId, { type: "SPA_TOGGLE_OVERLAY" });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: "No active tab" });
          }
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      // 2) Cloud TTS
      if (msg?.type === "SPA_TTS_REQUEST") {
        try {
          const text = (msg?.payload?.text || "").slice(0, 4000);
          const audioB64 = await openaiTTS(text);
          sendResponse({ ok: true, audioB64 });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      // 3) Start a chat session / greet
      if (msg?.type === "SPA_CHATBOT_INIT") {
        const tabId = (_sender && _sender.tab && _sender.tab.id) || Math.random();
        const ctx = msg?.payload?.ctx || {};
          const vendor = await readVendorFromStorage();
          // --- Minimal vendor guard (needs at least company name)
if (!vendor?.name || !String(vendor.name).trim()) {
  const ai = {
    reply: "No vendor profile found — please set at least your company in Vendor Profile.",
    followups: ["Open Vendor Profile", "What info do you need from me?"],
    updates: {}
  };
  sendResponse({ ok: true, result: ai });
  return;
}

        chatSessions.set(tabId, { ctx, history: [], collected: {} });

        const target = (ctx && typeof ctx.name === "string" && ctx.name.trim())
          ? ctx.name.trim()
          : "this person";

          const ai = {
    reply: `Hey Boss — I’m Robin. Ask me anything about ${target} or ${ctx.company || "their company"} — I’ll answer directly using the profile and our vendor context.`,
    followups: [
      "Yes, quick brief",
      "Recent company news",
      "Likely responsibilities",
      "What are their current challenges?"
    ],
    updates: {}
  };
    // Remove the intro "I’ll tailor everything ..." from first reply
  if (ai && typeof ai.reply === "string") {
    ai.reply = ai.reply.replace(/I’ll tailor everything[^?]*\?\s*/i, "");
  }

  // Replace "How could ... help them?" with "What are their current challenges?"
  if (Array.isArray(ai.followups)) {
    const i = ai.followups.findIndex(x => /How could .* help them\?/i.test(x));
    if (i !== -1) ai.followups[i] = "What are their current challenges?";
  }



        const s = chatSessions.get(tabId);
        s.history.push({ role: "assistant", content: ai.reply });
        sendResponse({ ok: true, result: ai });
        return;
      }

      // 4) Continue a chat
      if (msg?.type === "SPA_CHATBOT_TALK") {
        const tabId = (_sender && _sender.tab && _sender.tab.id) || Math.random();
        const sess = chatSessions.get(tabId) || { ctx: {}, history: [], collected: {} };
        const text = (msg?.payload?.text || "").trim();
        if (text) sess.history.push({ role: "user", content: text });

        const ai = await gptChatbotReply({
          ctx: sess.ctx,
          history: sess.history.slice(-14),
          collected: sess.collected
        });

        if (ai.updates && Object.keys(ai.updates).length) {
          Object.assign(sess.collected, ai.updates);
        }
        sess.history.push({ role: "assistant", content: ai.reply });
        chatSessions.set(tabId, sess);

        sendResponse({ ok: true, result: ai });
        return;
      }


// Device login: user pastes a long one-time code from the web app
if (msg?.type === "SPA_DEVICE_LOGIN") {
  (async () => {
    try {
      const deviceCode = String(msg?.payload?.token || "").trim();
      if (!deviceCode) throw new Error("Empty device token.");

      // Lookup the pairing row via Supabase REST (code can be long; not just 6 digits)
      const { url, anon } = await readSupabaseConfig();
      const headers = { 'apikey': anon, 'Content-Type': 'application/json', 'Authorization': `Bearer ${anon}` };
      const api = `${url}/rest/v1/pairing_codes?code=eq.${encodeURIComponent(deviceCode)}&select=access_token,refresh_token,claimed,expires_at&limit=1`;

      const res = await fetch(api, { headers });
      if (!res.ok) throw new Error("Device code not found or expired.");
      const rows = await res.json();
      const row = rows && rows[0];
      if (!row || row.claimed) throw new Error("Device code invalid or already claimed.");

      const access = row.access_token || "";
      const refresh = row.refresh_token || "";
      if (!access) throw new Error("Missing access_token in device row.");

      await chrome.storage.sync.set({ supabase_token: access, supabase_refresh: refresh });

      return void sendResponse({ ok: true });
    } catch (e) {
      return void sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keep the message channel open for async sendResponse
}


      // 0) Settings probe from content script
if (msg?.type === "SPA_GET_SETTINGS") {
  await ensureSettingsLoaded();

    // Vendor hint for news focus (used if caller didn't pass an instruction)
  const vendor = await readVendorFromStorage();

  return void sendResponse({
    ok: true,
    result: {
      hasKey: paired,
      model: userOptions.model,
      source: userOptions.source
    }
  });
}

// Enrich the profile (news, financial, responsibilities, insights, fit)
if (msg?.type === "SPA_ENRICH_PROFILE") {
  try {

  const vendor = await readVendorFromStorage();
if (DEBUG_LOGS) console.log("[DBG] ENRICH vendor hint:", vendor.industryHint);

    const out = await enrichProfile(msg.payload || {});

    // Save to Supabase (prospect + enrichment)
try {
  await saveProspectAndEnrichment(msg.payload?.profile || {}, (out && out.result) || {});
} catch (e) {
  if (DEBUG_LOGS) console.warn('[CRM] saveProspectAndEnrichment failed:', e);
}





    
    return void sendResponse(out); // {ok:true, result:{...}}
  } catch (e) {
    return void sendResponse({ ok: false, error: String(e) });
  }
}


// Find relevant peers (top 5) for same team & adjacent teams
// Find relevant peers (top 5) for same team & adjacent teams
if (msg?.type === "SPA_FIND_PEERS") {
  (async () => {
    try {
      const { company = "", role = "", prospect_name = "", limit: reqLimit } = msg.payload || {};
      const limit = Math.max(2, Math.min(5, Number(reqLimit) || 5));
      // --- New: Vendor personas x Company -> direct LinkedIn profiles (no search links)
const vendor = await readVendorFromStorage();
const personas =
  (Array.isArray(vendor?.personas) && vendor.personas.length
    ? vendor.personas
    : (Array.isArray(vendor?.vendor_personas) ? vendor.vendor_personas : []))
  .map(s => String(s || '').trim())
  .filter(Boolean);


const companyName = String(company || "").trim();
const avoid = String(prospect_name || "").trim();

if (companyName && personas.length) {
  // Build people-search URLs for each persona+company, then resolve to /in/ profiles
  const searches = personas.map(p =>
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${companyName} ${p}`)}`
  );

  const collected = [];
  const seen = new Set();

  for (const persona of personas) {
  const u = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${companyName} ${persona}`)}`;
  console.log("[PEERS:bg] persona query:", persona, "company:", companyName);

  const r = await Promise.race([
    resolveLinkedInPeopleSearch(u, { company: companyName, titleHint: persona, avoidName: avoid }),
    new Promise(res => setTimeout(() => res(null), 9000))
  ]);

  if (r && r.url && /\/in\//.test(r.url)) {
    const key = r.url.split("?")[0].toLowerCase();
    if (!seen.has(key) && (!avoid || !new RegExp(avoid, "i").test(r.name || ""))) {
      seen.add(key);
      collected.push({ name: r.name || "—", title: r.title || persona, url: r.url });
    }
  }

  if (collected.length >= limit) break;
  console.log("[PEERS:bg] resolver count:", collected.length, "of", limit);
}


  if (collected.length >= 2) {
    console.log("[PEERS:bg] persona resolver finished with", collected.length, "profiles");

    // Ensure 2–5 items only
    const out = collected.slice(0, limit);
    return void sendResponse({ ok: true, result: out });
  }
}

return void sendResponse({ ok: true, result: [] });


console.warn("[PEERS:bg] falling back to AI peers: personas?", personas.length, "company?", !!companyName);

// If we get here, personas/company were missing or resolution <2; fall back to the old AI path below.

      const prompt = [
        `Company: ${company}`,
        `Prospect: ${prospect_name}`,
        `Role: ${role}`,
        "",
          "Use the vendor’s target personas (roles) and the prospect’s company to find relevant people.\n\nRules:\n- Only return people who appear to work at the same company.\n- Prioritize senior roles first (C-level, VP, Director, Head).\n- Use vendor personas as role seeds (e.g., “CIO, CTO, Head of IT, Procurement Manager”).\n- Return between 2 and 5 items only.\n- Links must be direct LinkedIn profile URLs (https://www.linkedin.com/in/...); never return search links.\n\nOutput:\nReturn ONLY strict JSON (the word JSON appears here) as an array of:\n[{ \"name\": \"...\", \"title\": \"...\", \"url\": \"https://www.linkedin.com/in/...\" }]\nNo prose, no markdown—just JSON.",

      ].join("\n");

      console.log("[PEERS:bg] prompt\n" + prompt);

let arr = [];


      // --- Resolve LinkedIn people-search URLs to the first sensible /in/ profile (time-boxed) ---
try {
  const resolved = await Promise.all((arr || []).map(async (p) => {
    try {
      let candidate = p?.url || `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([company, (p.name || p.title || "").trim()].filter(Boolean).join(" "))}`;
if (_isLinkedInPeopleSearch(candidate)) {
        const r = await Promise.race([
              resolveLinkedInPeopleSearch(candidate, { company, titleHint: p.title, avoidName: prospect_name }),
          new Promise(res => setTimeout(() => res(null), 9000)) // hard 9.0s cap per item
        ]);
        if (r && r.url) {
          return { ...p, url: r.url, name: r.name || p.name, title: r.title || p.title };
        }
      }
    } catch {}
    return p;
  }));
  arr = resolved;
} catch {}

      // --- Hard fallback: if after all steps we still have <2 peers, synthesize deterministic peers
      if (!Array.isArray(arr) || arr.length < 2) {
        const fb = makePeerFallback(role, company);
        if (Array.isArray(fb) && fb.length) {
          return void sendResponse({ ok: true, result: fb.slice(0, limit) });
        }
      }


      return void sendResponse({ ok: true, result: arr });
    } catch (e) {
      return void sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
}



// Generate prospecting email
if (msg?.type === "SPA_GENERATE_EMAIL") {
  try {
    
const base = msg.payload || {};
const payload = { ...base, inputs: { ...(base.inputs || {}) } };
try {
  const v = await readVendorFromStorage();
  payload.inputs.vendor = { ...v, ...(payload.inputs.vendor || {}) };
  if (DEBUG_LOGS) console.log("[DBG] EMAIL vendor:", payload.inputs.vendor, "profile:", payload.profile || {});

} catch {}
const email = await gptEmail(payload);

// Save to Supabase (email linked to prospect)
try {
  const tone = (payload?.inputs && payload.inputs.tone) || 'Professional';
  await saveEmailForProspect(msg.payload?.profile || {}, email, tone);
} catch (e) {
  if (DEBUG_LOGS) console.warn('[CRM] saveEmailForProspect failed:', e);
}


    return void sendResponse({ ok: true, result: { email } });
  } catch (e) {
    return void sendResponse({ ok: false, error: String(e) });
  }
}

// Summarize background items into <=100 char company blurbs (max 3)
if (msg?.type === "SPA_SUMMARIZE_BACKGROUND") {
  (async () => {
    try {
      const { company, items } = msg.payload || {};
      const text = Array.isArray(items) ? items.join("\n") : String(items || "");
      const system = "You write extremely concise one-sentence company blurbs. Each item <= 100 characters. No numbering.";
      const user = `Current company: ${company || "(unknown)"}\nBackground lines:\n${text}\n\nReturn up to 3 distinct company blurbs.`;
      const out = await callOpenAIJSON({
        system, user,
        parseFallback: { blurbs: [] },
        schema: { type: "object", properties: { blurbs: { type: "array", items: { type: "string" } } } }
      });
      const arr = (out?.blurbs || []).map(s => String(s).slice(0, 100));
      sendResponse({ ok: true, result: arr.slice(0,3) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
}

// Return latest saved email draft for a prospect (by LinkedIn URL when possible)
if (msg?.type === "SPA_GET_EMAIL_DRAFT") {
  (async () => {
    try {
      const { prospect_url, prospect_name, company } = msg.payload || {};
      let prospectId = null;

      // Prefer unique profile URL
      if (prospect_url) {
        const p = await supaSelectOne('prospects', { linkedin_url: prospect_url });
        prospectId = p?.id || null;
      }
      // Fallback to (name + company)
      if (!prospectId && prospect_name && company) {
        const p = await supaSelectOne('prospects', { name: prospect_name, company });
        prospectId = p?.id || null;
      }

      let draft = "";
      if (prospectId) {
        const row = await supaSelectOne('emails', { prospect_id: prospectId }, { order: 'created_at.desc' });
        draft = row?.draft || "";
      }
      sendResponse({ ok: true, result: { draft } });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
}



// Generate the 2-page prospect/account brief used for "Generate Sales Files"
if (msg?.type === "SPA_GENERATE_SALES_FILES") {
  try {
    
const base = msg.payload || {};
const payload = { ...base, inputs: { ...(base.inputs || {}) } };
try {
  const v = await readVendorFromStorage();
  payload.inputs.vendor = { ...v, ...(payload.inputs.vendor || {}) };
  if (DEBUG_LOGS) console.log("[DBG] EMAIL vendor:", payload.inputs.vendor, "profile:", payload.profile || {});

} catch {}
const brief = await gptProspectAccountBrief(payload);


    return void sendResponse({ ok: true, result: brief });
  } catch (e) {
    return void sendResponse({ ok: false, error: String(e) });
  }
}

// Legacy support for older mini overlay
if (msg?.type === "GENERATE_EMAIL") {
  try {
    const email = await gptEmail({ inputs: { insights: msg.insights || [] } });
    return void sendResponse({ ok: true, result: { email }, email });
  } catch (e) {
    return void sendResponse({ ok: false, error: String(e) });
  }
}


      sendResponse({ ok: false, error: "Unknown message" });
    } catch (e) {
      console.error("[BG] router error:", e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// Clicking the icon toggles the overlay
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "SPA_TOGGLE_OVERLAY" }); } catch {}
});
