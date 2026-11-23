// ============================================================
//  CPCON UK CHATBOT — UI / message rendering
//  Dependencies: config.js
// ============================================================

// -- Main chat ------------------------------------------------

// Adds a bot message with a typing animation.
function cpconSay(txt, cb) {
  const tid = 'cpcon-typ-' + Date.now();
  const container = document.getElementById('cpcon-msgs');

  const typingRow = document.createElement('div');
  typingRow.className = 'cpcon-row';
  typingRow.id = tid;
  typingRow.innerHTML = `
    <div class="cpcon-av"><img src="/cpcon-previa-uk-gsc-20261123/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div>
    <div class="cpcon-bbl">
      <div class="cpcon-typing"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(typingRow);
  cpconScrollDown();

  // Delay proportional to text length (min 600ms, max 1800ms)
  const delay = Math.min(Math.max(txt.length * 20, 600), 1800);
  setTimeout(() => {
    document.getElementById(tid)?.remove();
    cpconAddBot(txt);
    if (cb) cb();
  }, delay);
}

// Bot message (no typing animation)
function cpconAddBot(txt) {
  const container = document.getElementById('cpcon-msgs');
  const row = document.createElement('div');
  row.className = 'cpcon-row';
  row.innerHTML = `
    <div class="cpcon-av"><img src="/cpcon-previa-uk-gsc-20261123/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div>
    <div class="cpcon-bbl">${cpconNl2br(cpconEsc(txt))}</div>`;
  container.appendChild(row);
  cpconScrollDown();
}

// Client message
function cpconMeMsg(txt) {
  const container = document.getElementById('cpcon-msgs');
  const row = document.createElement('div');
  row.className = 'cpcon-row me';
  row.innerHTML = `
    <div class="cpcon-av me"></div>
    <div class="cpcon-bbl">${cpconEsc(txt)}</div>`;
  container.appendChild(row);
  cpconScrollDown();
}

// Typing indicator for the AI
function cpconShowTyping(id) {
  const container = document.getElementById('cpcon-msgs');
  const t = document.createElement('div');
  t.className = 'cpcon-row';
  t.id = id;
  t.innerHTML = `
    <div class="cpcon-av"><img src="/cpcon-previa-uk-gsc-20261123/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div>
    <div class="cpcon-bbl">
      <div class="cpcon-typing"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(t);
  cpconScrollDown();
}
function cpconRemoveTyping(id) { document.getElementById(id)?.remove(); }
