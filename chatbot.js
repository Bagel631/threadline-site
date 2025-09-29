// chatbot.js — Robin (Jarvis/FRIDAY-class) for LinkedIn
// Big central ARC REACTOR hero + heavy animations, chat beneath. Corner drift, drag/pin, SPA-safe re-greet.
// Uses robust LinkedIn profile scraping so greeting always includes the target name.
(() => {
  if (window.__spaChatBooted) return;
  window.__spaChatBooted = true;

  const HOST_ID = "spa-chatbot-host";
  const WIDTH_PX = "100%"; // embed mode: fill parent container (e.g. 360px sidebar)
  const DRIFT_INTERVAL_MS = 0; // embed mode: no drift


  // ---- Audio (autoplay-safe) ----
  let __ac = null;
  let __audioArmed = false;

  function getAudioCtx() {
    if (!__ac) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      __ac = new Ctx();
    }
    if (__ac.state === "suspended") {
      try { __ac.resume(); } catch (_) {}
    }
    return __ac;
  }
  function armAudioOnce(rootNode) {
    if (__audioArmed) return;
    __audioArmed = true;
    const resume = () => { try { getAudioCtx(); } catch (_) {} };
    rootNode.addEventListener("click", resume, { once: true, capture: true });
    rootNode.addEventListener("keydown", resume, { once: true, capture: true });
  }
  // optional soft beep — call only after a user gesture
  function playBeep(ms = 90, freq = 880) {
    try {
      const ac = getAudioCtx();
      if (!ac) return;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ac.destination);
      const now = ac.currentTime;
      gain.gain.linearRampToValueAtTime(0.16, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);
      osc.start();
      osc.stop(now + ms / 1000 + 0.02);
    } catch {}
  }

  // Always boot. If an older build set chatbot_enabled:false, reset it.
chrome.storage.sync.get({ chatbot_enabled: true }, (r) => {
  
  
  chrome.storage.sync.get({ supabase_token: "" }, (s) => {
  if (s.supabase_token) {
    boot();
  // do nothing here, let content.js mount Robin into overlay
} else {
  console.warn("[Chatbot] blocked: extension not paired yet");
  boot();


  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.supabase_token && changes.supabase_token.newValue) {
      // do nothing, Robin will be mounted by content.js
    }
  });
}

});

});

  function boot() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.all = "initial";
    host.style.fontFamily = "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    host.style.userSelect = "none";
    

  

    
    
    // embed mode: do not append to document
    // In embed mode we don't append to document directly.
// We expose a mount API so the overlay can place Robin.
window.Robin = window.Robin || {};
window.Robin.mountInto = function(container) {
  try {
    if (!container) return;
    // Ensure styles work in embed: avoid fixed positioning
    host.style.position = "static";
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.width = "100%";
host.style.maxWidth = "none"; // let container (360px column) control size

host.style.boxSizing = "border-box";
host.style.width = "100%";
host.style.maxWidth = "100%";



// --- EMBED MODE FLAGS ---
host.dataset.embedded = "1";
host.setAttribute("embedded", "");

  
    container.appendChild(host);
    host.style.width = "100%";
host.style.maxWidth = "100%";

  } catch (e) {
    console.error('[Chatbot] mountInto failed:', e);
  }
};



    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        :host{ all:initial; font-family: inherit; }

        /* ------- Embedded in overlay's right column ------- */
:host([embedded]) .controls { display: none !important; }  /* hide all buttons */
:host([embedded]) .hero { cursor: default; }               /* no drag affordance */
:host([embedded]) .frame {
  height: 720px;        /* ≈ 2× your card body (360px) */
  max-height: 72vh;     /* keep it reasonable on laptops */
}


        /* ————— THEME ————— */
        
  .frame{
  position:relative; border-radius:20px; overflow:hidden;
  background:
    radial-gradient(1200px 800px at -10% -30%, rgba(110,140,255,.18), transparent 40%),
    radial-gradient(800px 600px at 110% 130%, rgba(155,108,255,.16), transparent 45%),
    linear-gradient(180deg,#0b1228,#0a1024 70%, #070c1d);
  color:#eaf0ff; border:1px solid rgba(255,255,255,.12);
  box-shadow:0 24px 64px rgba(0,0,0,.55);
  display:flex;               /* NEW: flex layout */
  flex-direction:column;      /* NEW */
  padding-top:28px;           /* was 45px */
  padding-bottom:10px;        /* was 15px */
     height: min(78vh, 720px);   /* small bump in vertical room */

}



        /* Scanline gloss */
        .frame::after{
          content:""; position:absolute; inset:0; pointer-events:none;
          background:linear-gradient(0deg, rgba(255,255,255,.05), rgba(255,255,255,0));
          mix-blend-mode:screen; opacity:.35; animation: scan 6s linear infinite;
        }
        @keyframes scan { 0%{transform:translateY(-110%)} 100%{transform:translateY(110%)} }

        /* Particle grid canvas behind everything */
        canvas.bg { position:absolute; inset:0; z-index:0; opacity:.35; filter:contrast(135%) saturate(115%); pointer-events:none }

        /* ————— HERO (REACTOR) ————— */
        .hero{
          padding-top: 56px;           /* room for the HUD row */
  position:relative; z-index:2;
  padding:20px 12px 6px;      /* was ~44px top padding */
  display:flex; flex-direction:column; align-items:center;
  border-bottom:1px solid rgba(255,255,255,.08);
  cursor:default; /* embed mode: no dragging */
 overflow:visible;
}




        .controls{
  position:absolute; right:14px; top:12px;
  display:flex; gap:8px;
  z-index:100; pointer-events:auto;
}

        .btn{
  border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.08);
  color:#e8ecff; border-radius:10px; padding:5px 8px; /* was 6px 8px */
  font-weight:700; cursor:pointer; font-size:12px;
  transition: transform .12s ease, background-color .2s ease, opacity .2s ease;
}

        .btn:hover{ transform:translateY(-1px); background:rgba(255,255,255,.14) }
        .btn--primary{ background:linear-gradient(90deg,#8B5DB5,#6f6cff); color:#0b1431; border-color:transparent }

        .pin.on{ background:rgba(255,255,255,.22) }

        /* Large reactor container */
        .reactor{
          pointer-events: none;        /* reactor can't steal clicks */

  position:relative; width:168px; height:168px;   /* was 198px */
    margin-top: 18px;          /* gives the top-right controls breathing room */
  border-radius:50%;
  display:grid; place-items:center; margin:6px 0 4px;
  filter: drop-shadow(0 18px 42px rgba(111,108,255,.45));
}


        /* Core pulse */
        .core{
  position:absolute; width:82px; height:82px;     /* was 96px */
  border-radius:50%;
  background: radial-gradient(circle at 50% 50%, #e2d7f0, #8B5DB5 55%, #6f6cff 70%, rgba(139,93,181,.45) 72%, transparent 73%);

  box-shadow: inset 0 0 22px rgba(141,146,255,.85), 0 0 54px rgba(111,108,255,.75);
  animation: corePulse 1.3s ease-in-out infinite;
}

        @keyframes corePulse {
          0%{ transform:scale(1); box-shadow: inset 0 0 18px rgba(141,146,255,.7), 0 0 36px rgba(111,108,255,.55); }
          50%{ transform:scale(1.06); box-shadow: inset 0 0 28px rgba(141,146,255,1), 0 0 72px rgba(111,108,255,.95); }
          100%{ transform:scale(1); box-shadow: inset 0 0 18px rgba(141,146,255,.7), 0 0 36px rgba(111,108,255,.55); }
        }
          @keyframes speakPulse { 0%{ transform:scale(1) } 50%{ transform:scale(1.08) } 100%{ transform:scale(1) } }

        /* Rotating energy rings (three speeds) */
        .ring{ position:absolute; inset:0; border-radius:50%; }
        .ring.one{
          background: conic-gradient(from 0deg, rgba(153,191,255,.0), rgba(153,191,255,.6) 20%, rgba(153,191,255,.0) 40%, rgba(153,191,255,.8) 60%, rgba(153,191,255,.0) 80%, rgba(153,191,255,.6));
          mask: radial-gradient(circle, transparent 46%, black 47% 53%, transparent 54%);
          animation: spinSlow 8.5s linear infinite;
          filter: blur(.2px);
        }
        .ring.two{
          background: conic-gradient(from 0deg, rgba(125,214,255,.0), rgba(125,214,255,.7) 18%, rgba(125,214,255,.0) 36%, rgba(125,214,255,.9) 58%, rgba(125,214,255,.0) 78%, rgba(125,214,255,.7));
          mask: radial-gradient(circle, transparent 38%, black 39% 44%, transparent 45%);
          animation: spinMed 5.2s linear infinite reverse;
          filter: blur(.3px);
        }
        .ring.three{
          background: conic-gradient(from 0deg, rgba(255,252,200,.0), rgba(255,252,200,.55) 14%, rgba(255,252,200,.0) 34%, rgba(255,252,200,.65) 52%, rgba(255,252,200,.0) 70%, rgba(255,252,200,.55));
          mask: radial-gradient(circle, transparent 58%, black 59% 63%, transparent 64%);
          animation: spinFast 2.6s linear infinite;
          filter: blur(.2px);
        }
        @keyframes spinSlow{ to{ transform: rotate(360deg) } }
        @keyframes spinMed{ to{ transform: rotate(360deg) } }
        @keyframes spinFast{ to{ transform: rotate(360deg) } }

        /* Energy arc sweeps */
        .arcs{
          position:absolute; inset:0; border-radius:50%;
          background:
            conic-gradient(from 0deg, rgba(111,108,255,0) 0 16%, rgba(111,108,255,.2) 17% 18%, rgba(111,108,255,0) 19% 49%, rgba(111,108,255,.25) 50% 52%, rgba(111,108,255,0) 53% 70%, rgba(111,108,255,.18) 71% 72%, rgba(111,108,255,0) 73% 100%),
            conic-gradient(from 120deg, rgba(255,255,255,0) 0 24%, rgba(255,255,255,.25) 25% 28%, rgba(255,255,255,0) 29% 60%, rgba(255,255,255,.2) 61% 63%, rgba(255,255,255,0) 64% 100%);
          animation: arcs 3.2s linear infinite;
          filter: blur(.7px);
        }
        @keyframes arcs{ to{ transform: rotate(360deg) } }

        /* Talking halo */
        .halo{
          position:absolute; inset:-18px; border-radius:50%;
          background: radial-gradient(circle at 50% 50%, rgba(111,108,255,.45), rgba(111,108,255,.0) 60%);
          opacity:0; transition: opacity .2s ease;
        }
        .hero.talking .halo{ opacity:.9; }
        .hero.talking #reactor{ animation: speakPulse .9s ease-in-out infinite; }

        /* Name + protocol */
        .brand{ display:flex; flex-direction:column; align-items:center; gap:3px; margin-top:4px; }
        .brand .name{ font-weight:900; letter-spacing:.02em; font-size:14px; }
.brand .sub{ display:none; }      /* hide tagline to save vertical space */


        /* Equalizer below the core when talking */
        .eq{ position:absolute; bottom:18px; display:flex; gap:3px; }
        .eq i{ width:4px; height:11px; background:#99a8ff; border-radius:2px; opacity:.9; }
        .hero.talking .eq i:nth-child(1){ animation:eq 700ms ease-in-out infinite }
        .hero.talking .eq i:nth-child(2){ animation:eq 700ms ease-in-out .12s infinite }
        .hero.talking .eq i:nth-child(3){ animation:eq 700ms ease-in-out .24s infinite }
        @keyframes eq{ 0%{transform:scaleY(.6)} 50%{transform:scaleY(1.55)} 100%{transform:scaleY(.6)} }

        /* ————— Chat area ————— */
        .body{
  position:relative; z-index:1;
  padding:12px 14px;
  display:flex; flex-direction:column; gap:12px;  /* tighter gap */
  flex:1 1 auto;                                  /* NEW: grow to fill space */
  height:auto; max-height:none;                   /* remove fixed cap */
  overflow:auto; overscroll-behavior:contain;
}

        .msg{ display:flex; gap:30px; }
        .msg .bubble{
          line-height: 1.45;
          padding:12px 14px; border-radius:13px; line-height:1.42; font-size:14px; max-width:88%;
          border:1px solid rgba(255,255,255,.12); box-shadow:0 8px 22px rgba(0,0,0,.28)
        }
          .msg::before{
  content: attr(data-who);
  display:block;
  font-size:11px;
  opacity:.6;
  margin: 0 0 4px 2px;
}

        .msg.bot .bubble{ background:rgba(255,255,255,.08); backdrop-filter:blur(2px) }
        .msg.user{ justify-content:flex-end }
        .msg.user .bubble{ background:linear-gradient(90deg,#6f6cff,#9b6cff); color:#0b1431; font-weight:800; border-color:transparent }

        .quick{
  display:grid; grid-template-columns: 1fr 1fr;   /* two columns */
  gap:8px; margin-top:6px;
}
@media (max-width: 460px){
  .quick{ grid-template-columns: 1fr; }          /* stack on very narrow */
}


        .chip{
  background: rgba(255,255,255,.10);
  border: 1px solid rgba(142,162,255,.35);
  color: #EAF0FF;
  font-weight: 600;
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 14px;
  cursor: pointer;
  line-height: 1.25;
  white-space: normal;           /* allow wrapping */
  text-align: left;
  transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
}
.chip:hover{
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(111,108,255,.25);
  background: rgba(111,108,255,.18);
}


        .foot{
  border-top:1px solid rgba(255,255,255,.08);
  padding:10px; display:flex; gap:8px; align-items:center;
  pointer-events:auto; z-index:3;
}

.foot{ backdrop-filter: saturate(120%) blur(2px); }


        input[type="text"]{
  flex:1; border-radius:12px; border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.08); color:#fff; padding:12px; outline:none; font-size:14px;
  pointer-events:auto; user-select:text; -webkit-user-select:text;
}
          #mic{ background:rgba(255,255,255,.08); }
#mic.on{ background:rgba(99,193,255,.22); box-shadow:0 0 0 2px rgba(99,193,255,.25) inset; }

        .mini{
          position:absolute; right:12px; bottom:12px; display:none; height:38px; width:260px;
          align-items:center; justify-content:space-between; padding:6px 10px;
          background:linear-gradient(90deg,#6f6cff,#9b6cff); color:#0b1431; font-weight:900;
          border:1px solid rgba(255,255,255,.12); border-radius:20px; box-shadow:0 10px 30px rgba(111,108,255,.35)
        }
        .hidden{ display:none !important }
      </style>

      <div class="frame" id="frame">
        <canvas class="bg" id="bg"></canvas>

 


        <div class="hero" id="dragbar" title="Drag to move">
          <div class="controls">
            <button class="btn pin" id="pin" title="Pin / Unpin">📌</button>
            <button class="btn" id="min" title="Minimize">—</button>
            <button class="btn btn--primary" id="dig">Let's dig deeper</button>
            <button class="btn" id="off" title="Close">×</button>
            <button id="voice" class="btn" title="Voice on/off">🔈</button>
          </div>

          <div class="reactor" id="reactor">
            <div class="halo" id="halo"></div>
            <div class="ring one"></div>
            <div class="ring two"></div>
            <div class="ring three"></div>
            <div class="core" id="core"></div>
            <div class="eq" id="eq"><i></i><i></i><i></i></div>
          </div>

          <div class="brand">
            <div class="name">Robin</div>
            <div class="sub">Threadline Industries Protocol</div>
          </div>
        </div>

        <div class="body" id="log"></div>

        <div class="foot">
          <input id="in" type="text" placeholder="Type a message to Robin…" />
          <button class="btn" id="mic" title="Voice input">🎤</button>
          <button class="btn btn--primary" id="send">Send</button>
        </div>

        <div class="mini" id="mini">
          <span>Robin</span>
          <button class="btn" id="restore">Open</button>
        </div>
      </div>
    `;

    // Autoplay-safe: arm audio only after the user touches the bot
    armAudioOnce(root);

    // --- refs
    // --- refs
const $   = (s) => root.querySelector(s);
const frame = $("#frame");
const bg   = $("#bg");
const drag = $("#dragbar");
const pin  = $("#pin");
const min  = $("#min");
const off  = $("#off");
const mini = $("#mini");
const reactor = $("#reactor");
const halo  = $("#halo");
const log   = $("#log");
const input = $("#in");
// Keep typing inside the Shadow DOM; defeat LinkedIn’s global listeners
["mousedown","click","keydown","keypress","keyup"].forEach(ev => {
  input.addEventListener(ev, (e) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true); // capture
});
input.removeAttribute("readonly");
input.disabled = false;
input.tabIndex = 0;
setTimeout(() => input.focus(), 0);

    const send  = $("#send");
    const voiceBtn = $("#voice");
    const digBtn = $("#dig");
    digBtn?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SPA_TOGGLE_OVERLAY" });
});

let voiceOn = true;           // default ON for Robin
let ttsUnlocked = false;      // becomes true after first user gesture
let pendingTTS = "";          // buffer first line(s) until unlock

chrome.storage.sync.get({ chatbot_tts: true }, (r) => {
  voiceOn = !!r.chatbot_tts;
  voiceBtn?.classList.toggle("on", voiceOn);
});

// unlock on first user gesture; speak anything queued
document.addEventListener("pointerdown", () => {
  ttsUnlocked = true;
  if (pendingTTS && voiceOn) {
    ttsSpeak(pendingTTS);
    pendingTTS = "";
  }
}, { once: true });

voiceBtn?.addEventListener("click", () => {
  voiceOn = !voiceOn;
  voiceBtn.classList.toggle("on", voiceOn);
  chrome.storage.sync.set({ chatbot_tts: voiceOn });
});

// ensure voices are loaded; if something is queued and we’re unlocked, speak it
try {
  speechSynthesis.onvoiceschanged = () => {
    if (ttsUnlocked && pendingTTS && voiceOn) {
      ttsSpeak(pendingTTS);
      pendingTTS = "";
    }
  };
} catch {}

    // --- Particle grid background
    const g = bg.getContext("2d");
    let gw=0, gh=0, pts=[];
    function resizeBG(){
      const r = frame.getBoundingClientRect();
      bg.width  = gw = Math.max(1, Math.floor(r.width * devicePixelRatio));
      bg.height = gh = Math.max(1, Math.floor(r.height * devicePixelRatio));
      pts = makePts(Math.floor(r.width/28), Math.floor(r.height/26));
    }
    function makePts(nx, ny){
      const a=[]; for (let y=0;y<=ny;y++){ for(let x=0;x<=nx;x++){ a.push({x:x/nx, y:y/ny, o:Math.random()*Math.PI*2, s:.55+.8*Math.random()}); } }
      return a;
    }
    function drawBG(t){
      g.clearRect(0,0,gw,gh); g.globalAlpha=.85;
      const hue=236;
      for (const p of pts){
        const px=(p.x + Math.sin(t*.00025+p.o)*.004)*gw;
        const py=(p.y + Math.cos(t*.00021+p.o)*.004)*gh;
        g.fillStyle=`hsla(${hue + Math.sin(t*.0004+p.o)*6},95%,70%,${.09 + .09*Math.sin(t*.001+p.o)})`;
        g.beginPath(); g.arc(px,py,1.7*devicePixelRatio*p.s,0,Math.PI*2); g.fill();
      }
      g.globalAlpha=.28; g.strokeStyle="rgba(142,162,255,.35)"; g.lineWidth=.6*devicePixelRatio;
      const stride=8;
      for (let i=0;i<pts.length;i+=stride){
        const a=pts[i], ax=a.x*gw, ay=a.y*gh;
        for (let j=i+1;j<Math.min(i+stride*2, pts.length); j+=stride){
          const b=pts[j]; g.beginPath(); g.moveTo(ax,ay); g.lineTo(b.x*gw,b.y*gh); g.stroke();
        }
      }
      requestAnimationFrame(drawBG);
    }
    resizeBG(); requestAnimationFrame(drawBG); new ResizeObserver(resizeBG).observe(frame);

    // --- speaking visuals
    function beginTalking(){ reactor.classList.add("talking"); halo.style.opacity="1"; }
    function endTalking(){ reactor.classList.remove("talking"); setTimeout(()=> halo.style.opacity="0", 260); }
    
    // Natural TTS: sentence chunking + slight variability + male/low pitch
// Cloud-first TTS (OpenAI) with en-GB fallback
let ttsQueue = [];
let ttsSpeaking = false;

function ttsSpeak(text = "") {
  if (!voiceOn) return;

  const line = String(text || "").trim();
  if (!line) return;

  // If audio is not yet unlocked (Chrome policy), buffer and bail.
  if (!ttsUnlocked) {
    pendingTTS = pendingTTS ? (pendingTTS + " " + line) : line;
    return;
  }

  // Queue the line and start if idle
  ttsQueue.push(line);
  if (!ttsSpeaking) speakNextCloud();
}

function speakNextCloud() {
  if (!voiceOn || !ttsUnlocked) { ttsSpeaking = false; return; }
  const next = ttsQueue.shift();
  if (!next) { ttsSpeaking = false; return; }
  ttsSpeaking = true;

  // Ask background for OpenAI neural TTS (British tone will be enforced in fallback)
  chrome.runtime.sendMessage({ type: "SPA_TTS_REQUEST", payload: { text: next } }, (resp) => {
    if (resp && resp.ok && resp.audioB64) {
      try {
        const audio = new Audio("data:audio/mp3;base64," + resp.audioB64);
        audio.volume = 0.95;
        audio.onended = () => { ttsSpeaking = false; setTimeout(speakNextCloud, 80); };
        audio.onerror = () => { ttsSpeaking = false; fallbackTTS(next); setTimeout(speakNextCloud, 80); };
        audio.play().catch(() => { ttsSpeaking = false; fallbackTTS(next); setTimeout(speakNextCloud, 80); });
      } catch {
        ttsSpeaking = false; fallbackTTS(next); setTimeout(speakNextCloud, 80);
      }
    } else {
      // Background failed — fallback to Web Speech API (force en-GB if available)
      fallbackTTS(next);
      ttsSpeaking = false;
      setTimeout(speakNextCloud, 80);
    }
  });
}

function fallbackTTS(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(String(text));
const vs = speechSynthesis.getVoices();

// 1) British + male-y names first
let pick = vs.find(v => /en-GB/i.test(v.lang) && /(Male|Daniel|Brian|Ryan|James|George|Matthew|David|Alex)/i.test(v.name));
// 2) Any British
if (!pick) pick = vs.find(v => /en-GB/i.test(v.lang) || /British/i.test(v.name));
// 3) Any English
if (!pick) pick = vs.find(v => /en[-_]/i.test(v.lang));
// 4) Fallback to first
if (!pick) pick = vs[0] || null;

if (pick) u.voice = pick;
u.lang = (pick && pick.lang) || "en-GB";
u.rate = 0.96;   // a hair slower for clarity
u.pitch = 0.85;  // slightly lower pitch
u.volume = 0.95;
    try { speechSynthesis.cancel(); } catch {}
    speechSynthesis.speak(u);
  } catch {}
}



// Prefer a low-pitched male English voice; pick “Natural/Neural/Online” if available
function pickNaturalMaleVoice() {
  const list = speechSynthesis.getVoices() || [];
  if (!list.length) return null;

  const isEnglish = v => /en[-_]/i.test(v.lang) || /english/i.test(v.name);
  const maleName  = /(Male|Alex|Daniel|David|Ryan|Brian|Matthew|Guy|Barry|George|James)/i;
  const naturalTag = /(Natural|Neural|Online)/i;

  // 1) male + natural tag + English
  let v = list.filter(isEnglish).find(v => naturalTag.test(v.name) && maleName.test(v.name));
  // 2) any male English
  if (!v) v = list.filter(isEnglish).find(v => maleName.test(v.name));
  // 3) any English
  if (!v) v = list.find(isEnglish);
  // 4) fallback to first
  return v || list[0] || null;
}


// Refresh voices list when the browser loads them
try {
  speechSynthesis.onvoiceschanged = () => {
    // If a first line was waiting and we’re unlocked, speak it now
    if (ttsUnlocked && pendingTTS && voiceOn) {
      ttsSpeak(pendingTTS);
      pendingTTS = "";
    }
  };
} catch {}


    // --- say() with type-on for bot
    function say(who, text, { typing=false } = {}){
      const row = document.createElement("div");
      row.className = "msg " + (who === "bot" ? "bot" : "user");
      row.dataset.who = (who === "bot" ? "Robin" : "You");
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      row.appendChild(bubble);
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;

      if (who === "bot") beginTalking();

      if (!typing){
        bubble.innerHTML = escapeHtml(text);
        bubble.textContent = mdToPlain(text);   // overwrite with clean plain text
        if (who === "bot") ttsSpeak(text);
        if (who === "bot") endTalking();
        return;
      }
      const s = String(text||""); let i=0;
      const tick=()=>{ bubble.textContent += s.slice(i,i+3); i+=3; log.scrollTop = log.scrollHeight;
        if (i < s.length) {
  setTimeout(tick, 11);
} else {
  if (who === "bot") {
        text = mdToPlain(text);       // ← sanitize Robin replies
        bubble.textContent = mdToPlain(s);      // replace the typed text with cleaned version

  endTalking();
  setTimeout(() => ttsSpeak(s), 120); // small pause feels more “alive”
}
}
      }; tick();
    }

    // --- quick chips
    function renderFollowups(items=[]){
      root.querySelectorAll(".quick").forEach(n => n.remove());
      if (!Array.isArray(items) || !items.length) return;
      const wrap = document.createElement("div"); wrap.className="quick";
      items.slice(0,4).forEach(t => {
        const chip = document.createElement("button");
chip.className = "chip";
chip.textContent = t.replace(/^Ask\s+Robin:\s*/i, "");

        chip.addEventListener("click", ()=>{
          input.value = t;
          playBeep(55, 980);     // only on user action
          sendMsg();
        });
        wrap.appendChild(chip);
      });
      log.appendChild(wrap); log.scrollTop = log.scrollHeight;
    }

    // --- controls
    let pinned=false, driftTimer=null, bobRaf=0, cornerIndex=3;
    pin.addEventListener("click", ()=>{ pinned=!pinned; pin.classList.toggle("on", pinned); if (pinned) stopDrift(); else startDrift(); });
    min.addEventListener("click", ()=>{ frame.classList.add("hidden"); mini.style.display="flex"; stopDrift(); });
    $("#restore").addEventListener("click", ()=>{ mini.style.display="none"; frame.classList.remove("hidden"); if (!pinned) startDrift(); });
    off.addEventListener("click", ()=>{
  frame.classList.add("hidden");
  mini.style.display = "flex";
  stopDrift();
});

    // --- drag (pin while dragging)
    (function enableDrag(){
      let dragOn=false, sx=0, sy=0, start={top:0,left:0};
      const pos = ()=>{ const cs=getComputedStyle(host); return { top:parseFloat(cs.top)||null, left:parseFloat(cs.left)||null, right:parseFloat(cs.right)||null, bottom:parseFloat(cs.bottom)||null }; };
      drag.addEventListener("mousedown", (e)=>{
        e.preventDefault(); dragOn=true; pinned=true; pin.classList.add("on"); stopDrift();
        sx=e.clientX; sy=e.clientY; const p=pos();
        host.style.right="auto"; host.style.bottom="auto";
        if (p.left==null) host.style.left=(window.innerWidth - host.getBoundingClientRect().right - 18) + "px";
        host.style.top =(window.innerHeight - host.getBoundingClientRect().bottom - 28) + "px";
        if (p.top==null)  host.style.top =(window.innerHeight - host.getBoundingClientRect().bottom - 18) + "px";
        host.style.top =(window.innerHeight - host.getBoundingClientRect().bottom - 28) + "px";
        start = { top: parseFloat(host.style.top||"0"), left: parseFloat(host.style.left||"0") };
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      });
      function move(e){ if (!dragOn) return; host.style.top=(start.top + (e.clientY - sy))+"px"; host.style.left=(start.left + (e.clientX - sx))+"px"; }
      function up(){ dragOn=false; document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); }
    })();

    // --- drift + gentle bob
    // --- Smooth corner drifting (bezier glide + subtle bob) ---
const CORNERS = ["tr","br"];            // top-right <-> bottom-right (vertical only)
let cornerIdx = 0, driftRAF = 0, bobRAF = 0, drifting = false;

function cornerXY(which){
  const m = 18; // margin
  const w = host.offsetWidth;
  const h = host.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  switch(which){
    case "br": return { x: vw - w - m, y: vh - h - m };
    case "bl": return { x: m,          y: vh - h - m };
    case "tl": return { x: m,          y: m };
    case "tr": return { x: vw - w - m, y: m };
  }
  return { x: vw - w - m, y: vh - h - m };
}

function easeInOutCubic(t){ return t<.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }

function animateTo(to, ms = 14000){ // slower 14s glide

  const from = { x: parseFloat(host.style.left||"0"), y: parseFloat(host.style.top||"0") };
  const start = performance.now();
  cancelAnimationFrame(driftRAF);
  drifting = true;

  // little orbital "alive" wobble while traveling
  function step(now){
    const t = Math.min(1, (now - start)/ms);
    const k = easeInOutCubic(t);
    const cx = from.x + (to.x - from.x) * k;
    const cy = from.y + (to.y - from.y) * k;

    // micro-hover around path
    const wob = 2;
    const wobX = Math.sin(now*0.0035) * wob;
    const wobY = Math.cos(now*0.0030) * wob;

    let nx = cx + wobX, ny = cy + wobY;
// clamp to viewport
const r = host.getBoundingClientRect();
const pad = 12;
const maxX = window.innerWidth  - r.width  - pad;
const maxY = window.innerHeight - r.height - pad;
if (nx < pad) nx = pad; if (ny < pad) ny = pad;
if (nx > maxX) nx = maxX; if (ny > maxY) ny = maxY;
host.style.left = nx + "px";
host.style.top  = ny + "px";

    if (t < 1 && drifting) { driftRAF = requestAnimationFrame(step); }
    else { drifting = false; setTimeout(nextCorner, 600); } // pause a hair then continue
  }
  driftRAF = requestAnimationFrame(step);
}

function nextCorner(){
  cornerIdx = (cornerIdx + 1) % CORNERS.length;
  animateTo(cornerXY(CORNERS[cornerIdx]));
}

function startDrift(){
  if (drifting) return;
  // ensure we're positioned using left/top
  host.style.right = "auto"; host.style.bottom = "auto";
  if (!host.style.left || !host.style.top){
    const start = cornerXY(CORNERS[cornerIdx]);
    host.style.left = start.x + "px";
    host.style.top  = start.y + "px";
  }
  // gentle bob when idle/in panel hover
  cancelAnimationFrame(bobRAF);
  function bob(now){
    const dx = Math.sin(now*0.0020) * 0.6;
    const dy = Math.cos(now*0.0016) * 0.6;
    host.style.transform = `translate(${dx}px, ${dy}px)`;
    bobRAF = requestAnimationFrame(bob);
  }
  bobRAF = requestAnimationFrame(bob);
  nextCorner();
}

function stopDrift(){
  drifting = false;
  cancelAnimationFrame(driftRAF);
  cancelAnimationFrame(bobRAF);
  host.style.transform = "";
}

const isEmbedded = host.dataset.embedded === "1";
if (!isEmbedded) {
frame.addEventListener("mouseenter", ()=>!pinned && stopDrift());

frame.addEventListener("mouseleave", ()=>!pinned && startDrift());
input.addEventListener("focus", ()=>!pinned && stopDrift());
input.addEventListener("blur",  ()=>!pinned && startDrift());
startDrift();
}


    // --- initial greet
    init();
    async function init(){
      const ctx = await scrapeContextLinkedIn();
      chrome.runtime.sendMessage({ type: "SPA_CHATBOT_INIT", payload: { ctx } }, (resp)=>{
        const out = resp?.result || {};
        const target = (ctx?.name && ctx.name.trim()) ? ctx.name.trim() : "this person";
        const first = (out.reply && String(out.reply).trim()) ? out.reply : `Hello Boss, do you want me to tell you more about ${target}?`;
        say("bot", first, { typing:true });
        renderFollowups(Array.isArray(out.followups) ? out.followups : ["Yes, quick brief","Recent company news","Likely responsibilities"]);
      });
    }

    // --- send
    send.addEventListener("click", sendMsg);
    input.addEventListener("keydown", (e)=>{ if (e.key==="Enter") sendMsg(); });
    function sendMsg(){
      const text=(input.value||"").trim(); if (!text) return;
      input.value=""; say("user", text);
      playBeep(70, 740); // only on user action
      chrome.runtime.sendMessage({ type:"SPA_CHATBOT_TALK", payload:{ text }}, (resp)=>{
        const out=resp?.result || {}; const reply=(out.reply && String(out.reply).trim()) || "(No response)";
        say("bot", reply, { typing:true });
        renderFollowups(out.followups || []);
      });
    }

// --- voice input (push-to-talk)
const mic = $("#mic");
let rec = null, recOn = false;

function ensureRecognizer(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  if (!rec){
    rec = new SR();
    rec.lang = "en-GB";             // British English
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const t = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript) || "";
      input.value = t;
      sendMsg();
    };
    rec.onend = () => { recOn = false; mic.classList.remove("on"); };
    rec.onerror = () => { recOn = false; mic.classList.remove("on"); };
  }
  return rec;
}

mic?.addEventListener("click", () => {
  const r = ensureRecognizer();
  if (!r){ say("bot","Sorry, voice input isn’t supported in this browser."); return; }
  if (recOn){ r.stop(); return; }
  recOn = true; mic.classList.add("on"); r.start();
});


    // --- SPA re-greet
    host.addEventListener("spa-reinit", async ()=>{
      const ctx = await scrapeContextLinkedIn();
      chrome.runtime.sendMessage({ type:"SPA_CHATBOT_INIT", payload:{ ctx }}, (resp)=>{
        const out = resp?.result || {};
        const target = (ctx?.name && ctx.name.trim()) ? ctx.name.trim() : "this person";
        const first = (out.reply && String(out.reply).trim()) ? out.reply : `Hello Boss, do you want me to tell you more about ${target}?`;
        say("bot", first, { typing:true });
        renderFollowups(Array.isArray(out.followups) ? out.followups : ["Yes, quick brief","Recent company news","Likely responsibilities"]);
      });
    });
  } 
  
  // boot()

  // ---------------- helpers & scraping (same strategy as overlay) ----------------

  // Markdown → plain text (keeps line breaks)
function mdToPlain(s = "") {
  let t = String(s);

  // normalize line endings
  t = t.replace(/\r\n/g, "\n");

  // strip fenced code blocks ```...```
  t = t.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g,""));

  // bold/italic (**text**, *text*)
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*]+)\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/_([^_]+)_/g, "$1");

  // headings like "## Title" → "Title"
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");

  // bullet points "- " or "* " at start of line → "• "
  t = t.replace(/^\s*[-*]\s+/gm, "• ");

  // collapse > quotes indicator
  t = t.replace(/^\s*>\s?/gm, "");

  // collapse excessive blank lines
  t = t.replace(/\n{3,}/g, "\n\n");

  // trim
  return t.trim();
}

  function escapeHtml(s=""){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
  const q  = (s, r=document) => r.querySelector(s);
  const qa = (s, r=document) => Array.from(r.querySelectorAll(s));
  const tx = (el) => (el?.textContent || "").trim();
  const norm = (s="") => s.replace(/\s+/g," ").trim();
  const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

  async function waitForLinkedInReady(){
    const list=["main","section.pv-top-card","section[id*='experience']"]; const start=Date.now();
    while (Date.now()-start < 3500){ for(const sel of list){ if(q(sel)) return; } await sleep(120); }
    await sleep(250);
  }

  const BAD_COMPANY_TOKENS=["full-time","part-time","intern","internship","contract","self-employed","freelance","remote","hybrid","on-site","onsite","present","current","today","months","month","years","year"];
  const MONTHS_RX=/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i;

  function looksLikeCompany(s="",role=""){ const t=norm(s).toLowerCase(); if(!t) return false; if(t===norm(role).toLowerCase()) return false;
    if(t.length<2||t.length>70) return false; if(/\d{3,}/.test(t)) return false; if(MONTHS_RX.test(t)) return false; if(BAD_COMPANY_TOKENS.some(k=>t.includes(k))) return false; return true; }
  function cleanCompanyCandidate(s="",role=""){ if(!s) return ""; const raw=norm(s); const parts=raw.split(/[·•|—–-]/).map(p=>norm(p)).filter(Boolean);
    for(const seg of parts) if(looksLikeCompany(seg,role)) return seg; return looksLikeCompany(raw,role)?raw:""; }
  function guessCompanyFromLi(li, role=""){ const cands=["a[href*='/company/']",".pvs-entity__path-node span[aria-hidden='true']",".pv-entity__secondary-title",".t-14.t-normal","div.inline-show-more-text","h3 a[href*='/company/']","h3"];
    for (const sel of cands){ const cleaned=cleanCompanyCandidate(tx(q(sel,li)),role); if(cleaned) return cleaned; }
    const block=norm(tx(li)); if(block){ const bp=block.split(/[·•]/).map(norm).filter(Boolean); if(bp.length>=2){ const cand=cleanCompanyCandidate(bp[1],role); if(cand) return cand; }
      const m=/(.*?)(?:\s+at\s+|\s+@+\s+)(.*)/i.exec(block); if(m){ const cand=cleanCompanyCandidate(m[2],role); if(cand) return cand; } }
    return ""; }
  function getFromJsonLD(){ try{ const scripts=qa('script[type="application/ld+json"]'); for(const s of scripts){ const txt=s.textContent||""; if(!txt||txt.length<20) continue;
      let obj; try{ obj=JSON.parse(txt); }catch{ continue; } const nodes=Array.isArray(obj)?obj:[obj,...(obj["@graph"]||[])];
      for(const node of nodes){ if(!node||typeof node!=="object") continue; if(node["@type"]==="Person"&&(node.jobTitle||node.worksFor)){ const role=norm(node.jobTitle||""); const company=norm(node?.worksFor?.name||""); if(role||company) return {role,company}; } } } }
    catch{} return {role:"",company:""}; }

  // SAFE (no regex) role/company from headline
  function parseHeadlineRoleCompany(headline) {
    const h = norm(headline);
    if (!h) return { role: "", company: "" };
    const tests = [" at ", " @ ", " na ", " no ", " em ", " para ", " chez ", " bei ", " en ", " a ", " presso "];
    const lower = h.toLowerCase();
    for (const sep of tests) {
      const needle = sep;                       // keep spaces to avoid word-in-word matches
      const i = lower.indexOf(needle);
      if (i > 0) {
        const before = h.slice(0, i).trim();
        const after  = h.slice(i + needle.length).trim();
        if (before || after) return { role: before, company: after };
      }
    }
    return { role: "", company: "" };
  }

  function getFromHeadline(){ const sels=[".pv-text-details__left-panel div.inline-show-more-text",".pv-text-details__left-panel .text-body-medium",".pv-text-details__left-panel span","div.text-body-medium.break-words","[data-anonymize='headline']"];
    for(const sel of sels){ const headline=tx(q(sel)); if(!headline) continue; const parsed=parseHeadlineRoleCompany(headline); if(parsed.role||parsed.company) return parsed; } return {role:"",company:""}; }
  function getFromTopCardChips(){ const top=q("section.pv-top-card")||q(".pv-top-card")||q(".scaffold-layout__main"); if(!top) return {role:"",company:""}; const link=q("a[href*='/company/']",top)||q(".pv-top-card__experience-list a[href*='/company/']",top)||q(".pv-text-details__right-panel a[href*='/company/']",top)||q(".pv-top-card--experience-list a[href*='/company/']",top);
    const company=norm(tx(link)); const role=norm(tx(q(".pv-text-details__left-panel .text-body-medium",top)))||norm(tx(q(".pv-text-details__left-panel span",top)))||""; return {role,company}; }
  function getFromTitle(){ const t=document.title||""; const stripped=t.replace(/\s*\|\s*LinkedIn.*$/i,""); const parts=stripped.split(" - ").map(norm); if(parts.length>=3) return {role:parts[1]||"",company:parts[2]||""}; return {role:"",company:""}; }
  function getFromMeta(){ const meta=q('meta[property="og:description"]')||q('meta[name="description"]')||q('meta[name="twitter:description"]'); const d=norm(meta?.getAttribute("content")||""); if(!d) return {role:"",company:""}; const m=/(.*?)\s+(?:at|@)\s+(.*?)(?:\s*\||$)/i.exec(d); if(m) return {role:norm(m[1]),company:norm(m[2])}; return {role:"",company:""}; }

  function scanExperienceNodes(root){
    const items=qa("li, .pvs-list__item, .pv-entity__position-group-pager", root); let role="", company="";
    for(const li of items){ const block=(tx(li)||"").toLowerCase(); const isCurrent=/(present|presente|atual|current|heute)/i.test(block); if(!isCurrent) continue;
      const rGuess=tx(q("span[aria-hidden='true']",li))||tx(q(".t-bold",li))||tx(q(".mr1.t-bold",li))||tx(q("div.inline-show-more-text",li))||"";
      const cGuess=guessCompanyFromLi(li,rGuess); if(rGuess||cGuess){ role=norm(rGuess||role); company=norm(cGuess||company); break; } }
    if(!role&&!company&&items[0]){ const first=items[0]; role=norm(tx(q("span[aria-hidden='true']",first))||tx(q(".t-bold",first))||tx(q(".mr1.t-bold",first))||tx(q("div.inline-show-more-text",first))||""); company=norm(guessCompanyFromLi(first,role)); }
    return {role,company};
  }
  function getFromExperience(){ const cs=qa("section[id*='experience'], #experience, .pvs-profile-section"); let role="",company=""; for(const r of cs){ const o=scanExperienceNodes(r); role=role||o.role; company=company||o.company; if(role||company) break; } return {role,company}; }
  function getFromExperienceFirst(){ const section=q("section[id*='experience']")||Array.from(qa("section")).find(s=>/experience/i.test(tx(q("h2",s))||tx(q("div",s)))); if(!section) return {role:"",company:""};
    const liCurrent=Array.from(section.querySelectorAll("li")).find(li=>/(present|presente|atual|current|heute)/i.test(li.textContent||"")); const li=liCurrent||section.querySelector("li"); if(!li) return {role:"",company:""};
    let role=norm(tx(li.querySelector(".t-bold span[aria-hidden='true']")))||norm(tx(li.querySelector("span[aria-hidden='true']")))||norm(tx(li.querySelector(".mr1.t-bold")))||"";
    let company=guessCompanyFromLi(li,role); if(!company){ const header=tx(section.querySelector("a[href*='/company/']"))||tx(section.querySelector(".pvs-entity__path-node span[aria-hidden='true']"))||tx(section.querySelector("h3")); company=cleanCompanyCandidate(header,role); }
    return {role,company}; }

  async function extractWithRetries(){
    const sources=[getFromExperienceFirst, getFromJsonLD, getFromHeadline, getFromTopCardChips, getFromExperience, getFromMeta, getFromTitle];
    let out={role:"",company:""}; const tryOnce=()=>{ for(const fn of sources){ const r=fn(); if(r.role) out.role=out.role||r.role; if(r.company) out.company=out.company||r.company; if(out.role&&out.company) break; } };
    tryOnce(); const start=Date.now(); while((!out.role||!out.company)&&Date.now()-start<2500){ await sleep(250); tryOnce(); } return out;
  }

  async function scrapeContextLinkedIn(){
    await waitForLinkedInReady();

    const name = norm(
      tx(q("h1")) ||
      tx(q("[data-testid='profile-about'] h1")) ||
      tx(q("div.text-heading-xlarge")) || ""
    );

    const rc = await extractWithRetries();
    let role = rc.role, company = rc.company;

    // headline fallback "Role - Company"
    if(!role || !company){
      const headline = tx(q(".pv-text-details__left-panel span")) || tx(q("div.text-body-medium.break-words")) || "";
      if (headline.includes(" - ")) {
        const parts=headline.split(" - ");
        if (parts.length>=2){ role = role || norm(parts[0]); company = company || norm(parts[1]); }
      }
    }

    const url = location.href;
        // Pick up profile location (same selectors used by the overlay)
    const profileLocation =
      tx(q(".pv-text-details__left-panel .t-normal.t-black--light")) ||
      tx(q("span.text-body-small.inline.t-black--light.break-words")) ||
      "";

    const pageType = /linkedin\.com\/in\//.test(url)
      ? "profile"
      : /linkedin\.com\/company\//.test(url)
        ? "company"
        : "unknown";

        return {
      pageType,
      url,
      name,
      role: norm(role || ""),
      company: norm(company || ""),
      location: norm(profileLocation)
    };

  }

  // ------------- react to LinkedIn SPA URL changes
  let lastUrl = location.href;
  new MutationObserver(()=>{
    if(location.href!==lastUrl){
      lastUrl=location.href;
      setTimeout(()=>{
        const n=document.getElementById(HOST_ID);
        if(n) n.dispatchEvent(new Event("spa-reinit"));
      }, 400);
    }
  }).observe(document, { childList:true, subtree:true });
})();
