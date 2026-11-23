// ============================================================
//  CPCON UK CHATBOT — Camile (backend-driven flow)
//  Dependencies: config.js, ui.js, api.js (loaded first)
//
//  No WhatsApp on the UK site. The handoff is a data-capture step:
//  the visitor leaves their details and the team gets in touch,
//  with a mailto:contact@cpcongroup.com fallback.
// ============================================================

// -- State ---------------------------------------------------
const CRM_PROXY_URL = '/api/leads';
const CHAT_URL = '/api/chat';


// 17/10/2026 (form infalível): quem mexeu num formulário da página nos últimos
// 60 s não perde o foco para a Camile.
var cpconPageFormAt = 0;
document.addEventListener('focusin', function (e) {
  var t = e.target;
  if (t && t.form && !(t.closest && t.closest('#cpcon-inline-form'))) cpconPageFormAt = Date.now();
}, true);
function cpconPageFormBusy() {
  var a = document.activeElement;
  var inPage = a && a.form && !(a.closest && a.closest('#cpcon-inline-form'));
  return !!inPage || Date.now() - cpconPageFormAt < 60000;
}

function cpconTrapValue() {
  const el = document.getElementById('cpcon-hp-a');
  if (el && el.value) return el.value;
  return cpconState.honeypot || '';
}

async function cpconFetchFormToken() {
  const res = await fetch('/api/leads/form-token', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('form-token HTTP ' + res.status);
  const data = await res.json().catch(function () { return null; });
  if (!data || !data.form_token) throw new Error('form-token missing');
  return data.form_token;
}

const cpconState = {
  isOpen: false,
  started: false,
  sessionId: null,
  stage: 'idle',
  transferred: false,
  history: [],            // [{role, content}]
  busy: false,
  userName: '',
  userEmail: '',
  userPhone: '',
  userPhoneCountry: 'GB',
  phoneCtl: null,
  honeypot: '',
  userEmpresa: '',
  leadId: null,
  lastActivityAt: 0,
  reengageTimer: null,
  handoffOffered: false,
  conversationEnded: false,
  lastSegment: null,
  lastTema: null,
  turns: 0,
};

// -- Initial form validation (en-GB) -------------------------
const BLOCKED_NAMES = /^(hi|hey|hello|hiya|yo|ok|okay|yes|no|test|testing|asdf|aaa|xxx|haha|hehe|good|morning|afternoon|evening)$/i;
const VOWEL_RE = /[aeiou]/i;
function validateName(n) {
  const t = (n || '').trim();
  if (t.length < 3 || !VOWEL_RE.test(t) || BLOCKED_NAMES.test(t)) return null;
  // Nome COMPLETO — split(' ')[0] cortava o sobrenome de todo lead do chat.
  return t.replace(/\s+/g, ' ');
}
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const DISPOSABLE = /^(tempmail|mailinator|guerrillamail|10minutemail|throwaway|yopmail|fakeinbox|trashmail|sharklasers)\./i;
function validateEmail(e) {
  const t = (e || '').trim().toLowerCase();
  if (!EMAIL_RE.test(t)) return null;
  if (DISPOSABLE.test(t.split('@')[1])) return null;
  return t;
}
function validateCompany(e) {
  const t = (e || '').trim();
  if (t.length < 2) return null;
  return t;
}

// Captura contato digitado em TEXTO LIVRE no chat (email/telefone/nome) para
// não perder lead quando o cliente escreve os dados em prosa em vez do fluxo
// estruturado. Só preenche o que falta; email/telefone passam pela validação
// existente; nome só quando já há email (exige inicial maiúscula, evita pegar
// cargo/verbo como nome). Paridade com o fix do widget BR.
function cpconExtractContact(text) {
  var s = String(text || '');
  if (!s) return;
  if (!cpconState.userEmail) {
    var em = (s.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i) || [])[0];
    var ev = em ? validateEmail(em) : null;
    if (ev) cpconState.userEmail = ev;
  }
  if (!cpconState.userPhone && typeof window.cpconNormalizePhone === 'function') {
    var pm = s.match(/\(?\+?\d[\d\s().\-]{6,}\d/);
    var pv = pm ? window.cpconNormalizePhone(pm[0]) : null;
    if (pv && pv.ok) {
      cpconState.userPhone = pv.e164;
      cpconState.userPhoneCountry = pv.country;
    }
  }
  if (!cpconState.userName && cpconState.userEmail) {
    var nm = '';
    var mn = s.match(/(?:[Mm]y name is|[Ii] am|[Ii]'?m|[Nn]ame[:\-])\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+){0,2})/);
    if (mn && mn[1]) nm = mn[1].trim();
    if (nm.length < 2) {
      var head = s.split(/[a-z0-9._%+\-]+@/i)[0];
      var cap = (head.match(/[A-ZÀ-Ý][a-zà-ÿ'\-]{1,}(?:\s+[A-ZÀ-Ý][a-zà-ÿ'\-]{1,}){0,2}/) || [''])[0]
        .replace(/^(Hi|Hello|Hey|Good|Dear|My)\s+/i, '').trim();
      if (cap.length >= 2) nm = cap;
    }
    if (nm.length < 2) nm = cpconState.userEmail.split('@')[0].replace(/[._\-]+/g, ' ').trim();
    if (nm.length >= 2) cpconState.userName = nm.slice(0, 120);
  }
}


// -- Re-engagement nudge -------------------------------------
function cpconScheduleReengage() {
  if (cpconState.reengageTimer) clearTimeout(cpconState.reengageTimer);
  if (cpconState.transferred) return;
  if (cpconState.stage !== 'chat' && cpconState.stage !== 'greeting') return;
  cpconState.reengageTimer = setTimeout(function () {
    if (Date.now() - cpconState.lastActivityAt < 60000) return;
    if (cpconState.transferred) return;
    cpconSay('Are you still there?', function () { cpconEnableInput(); });
  }, 60000);
}

// -- Toggle + greeting ---------------------------------------
function cpconToggle() {
  const chat = document.getElementById('cpcon-chat');
  const isCurrentlyOpen = chat.classList.contains('open');
  const willOpen = !isCurrentlyOpen;

  if (willOpen) {
    try {
      (window.dataLayer = window.dataLayer || []).push({
        event: 'camile_widget_opened',
        source: window.__cpconStickyClicked ? 'sticky_button' : 'fab',
        page_path: window.location.pathname,
      });
    } catch (e) { /* analytics optional */ }
    window.__cpconStickyClicked = false;
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = 'none';
  } else {
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = '';
  }

  if (isCurrentlyOpen && !cpconState.started) {
    document.getElementById('cpcon-msgs').innerHTML = '';
    cpconState.isOpen = true;
    cpconState.started = true;
    setTimeout(cpconFlowGreeting, 300);
    return;
  }
  cpconState.isOpen = willOpen;
  chat.classList.toggle('open', cpconState.isOpen);
  // 02/11/2026: hora de abertura (proteção contra clique-fantasma, ver cpconCaptureGuard).
  if (cpconState.isOpen) cpconState.openedAt = Date.now();
  const badge = document.getElementById('cpcon-badge');
  if (badge) badge.style.display = 'none';
  if (cpconState.isOpen && !cpconState.started) {
    cpconState.started = true;
    setTimeout(cpconFlowGreeting, 500);
  }
}

function cpconFlowGreeting() {
  cpconAppendNotice('Please do not share passwords or card details here.');
  cpconSay(
    'Hello. I am ' + (window.CPCON_CONFIG && window.CPCON_CONFIG.agentName ? window.CPCON_CONFIG.agentName : 'Camile') + ', the business assistant at CPCON. So that we can help you, please share your contact details:',
    function () {
      cpconState.stage = 'form';
      cpconDisableInput();
      cpconShowInlineForm();
    }
  );
}

function cpconAppendNotice(text) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const n = document.createElement('div');
  n.className = 'cpcon-notice';
  n.textContent = text;
  container.appendChild(n);
  cpconScrollDown();
}

// ── Telemetria da captura (16/10/2026) ─────────────────────
// Funil da captura da Camile: capture_shown → capture_submitted, ou
// capture_rejected{reason: robot_box|phone|country|other}. Vai para o mesmo
// /api/form-telemetry dos formulários. Só códigos e nomes de campo: nada do
// que a pessoa digitou (sem nome, e-mail, empresa ou telefone).
var CPCON_TELEMETRY_URL = '/api/form-telemetry';
function cpconCaptureTelemetry(event, extra) {
  try {
    var body = { event: event, page: window.location.pathname.slice(0, 200), form: 'camile' };
    if (extra && extra.reason) body.reason = extra.reason;
    if (extra && extra.fields && extra.fields.length) body.fields = extra.fields.slice(0, 12);
    if (extra && extra.errors && extra.errors.length) body.errors = extra.errors.slice(0, 12);
    if (extra && /^[A-Z]{2}$/.test(extra.phone_country || '')) body.phone_country = extra.phone_country;
    var json = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon(CPCON_TELEMETRY_URL, new Blob([json], { type: 'application/json' }))) return;
    fetch(CPCON_TELEMETRY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true, credentials: 'same-origin' }).catch(function () {});
  } catch (e) { /* telemetria nunca quebra o chat */ }
}

function cpconSetFieldError(input, errEl, msg) {
  if (errEl) errEl.textContent = msg || '';
  if (input) {
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    if (errEl && errEl.id) input.setAttribute('aria-describedby', errEl.id);
  }
}

function cpconShowInlineForm() {
  const container = document.getElementById('cpcon-msgs');
  const formRow = document.createElement('div');
  formRow.className = 'cpcon-row';
  formRow.id = 'cpcon-inline-form';
  formRow.innerHTML =
    '<div class="cpcon-av"><img src="/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div>' +
    '<div class="cpcon-bbl cpcon-form-bbl">' +
    '  <div class="cpcon-form-group"><input type="text" id="cpcon-form-nome" placeholder="Name *" maxlength="100" autocomplete="given-name"/><div id="cpcon-form-nome-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-form-group"><input type="email" id="cpcon-form-email" placeholder="Work email *" maxlength="200" autocomplete="email"/><div id="cpcon-form-email-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-form-group"><input type="text" id="cpcon-form-empresa" placeholder="Company *" maxlength="120" autocomplete="organization"/><div id="cpcon-form-empresa-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-phone-slot" id="cpcon-form-phone-slot"></div>' +
    '  <div id="cpcon-form-tel-err" class="cpcon-form-err" role="alert"></div>' +
    '  <div class="cpcon-form-actions">' +
    '    <label class="cpcon-robot" for="cpcon-form-robot">' +
    '      <input type="checkbox" id="cpcon-form-robot" aria-describedby="cpcon-form-robot-err" />' +
    '      <span>I\'m not a robot</span>' +
    '    </label>' +
    '    <button type="button" id="cpcon-form-btn" onclick="cpconSubmitForm()">Continue</button>' +
    '  </div>' +
    '  <div id="cpcon-form-robot-err" class="cpcon-form-err" role="alert"></div>' +
    '  <input type="text" id="cpcon-hp-a" name="cpcon_hp_a" tabindex="-1" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" aria-hidden="true" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" class="cpcon-hp"/>' +
    '</div>';
  container.appendChild(formRow);
  cpconScrollDown();
  cpconCaptureTelemetry('capture_shown');
  cpconState.formShownAt = Date.now();
  document.getElementById('cpcon-form-robot').addEventListener('change', function (e) {
    if (e.target.checked) cpconSetFieldError(e.target, document.getElementById('cpcon-form-robot-err'), '');
  });
  const nome = document.getElementById('cpcon-form-nome');
  const email = document.getElementById('cpcon-form-email');
  const empresa = document.getElementById('cpcon-form-empresa');
  const slot = document.getElementById('cpcon-form-phone-slot');
  const telErr = document.getElementById('cpcon-form-tel-err');
  if (cpconState.phoneCtl && cpconState.phoneCtl.destroy) cpconState.phoneCtl.destroy();
  cpconState.phoneCtl = null;
  if (typeof window.cpconMountPhone !== 'function') {
    telErr.textContent = 'The phone field could not be loaded. Please email us at ' +
      ((window.CPCON_CONFIG && window.CPCON_CONFIG.contactEmail) || 'contact@cpcongroup.com') + '.';
    document.getElementById('cpcon-form-btn').disabled = true;
  } else {
    cpconState.phoneCtl = window.cpconMountPhone(slot);
    // 16/11/2026: Enter/"Go" on the phone keyboard (same rule on all 6 sites).
    slot.addEventListener('keydown', function (e) { if (e.target && e.target.id === 'cpcon-form-tel') cpconPhoneEnter(e); });
  }
  nome.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); email.focus(); } });
  email.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); empresa.focus(); } });
  empresa.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var tel = document.getElementById('cpcon-form-tel');
      if (tel) tel.focus();
    }
  });
  // 17/10/2026 (form infalível): a Camile não rouba o foco de quem está
  // preenchendo um formulário da página (abertura automática).
  if (!cpconPageFormBusy()) nome.focus();
}

// 02/11/2026 — causa raiz das recusas "todos os campos inválidos" (MX 01-02/11):
// o painel abre sozinho (ou é aberto) e o toque/clique que a pessoa ia dar na
// página cai no botão de envio 0-4 s depois, com o formulário VAZIO. Nada ia
// ao servidor, mas a pessoa via 4-5 erros vermelhos e ia embora.
// Padrão CPCON (igual nos 6 sites):
//  - clique < CPCON_GHOST_MS após abrir o painel/mostrar o formulário = clique-fantasma:
//    não valida nem pinta erro; só registra form:ghost_click.
//  - formulário todo vazio = uma mensagem clara no 1º campo + foco; registra form:empty.
// Nunca envia ao servidor nesses casos. Validação normal segue igual.
var CPCON_GHOST_MS = 800;
var CPCON_EMPTY_MSG = 'Please fill in your name, email, company and phone to start the chat.';
function cpconCaptureGuard() {
  var since = Date.now() - Math.max(cpconState.openedAt || 0, cpconState.formShownAt || 0);
  if (since < CPCON_GHOST_MS) {
    cpconCaptureTelemetry('capture_rejected', { reason: 'other', fields: ['form'], errors: ['form:ghost_click'] });
    return false;
  }
  var ids = ['cpcon-form-nome', 'cpcon-form-email', 'cpcon-form-empresa', 'cpcon-form-tel'];
  var empty = ids.every(function (id) { var el = document.getElementById(id); return !el || !String(el.value || '').trim(); });
  if (empty) {
    var n = document.getElementById('cpcon-form-nome');
    cpconSetFieldError(n, document.getElementById('cpcon-form-nome-err'), CPCON_EMPTY_MSG);
    cpconCaptureTelemetry('capture_rejected', { reason: 'other', fields: ['form'], errors: ['form:empty'] });
    if (n && n.focus) { try { n.focus(); n.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
    return false;
  }
  return true;
}

// 16/11/2026 — the phone mask itself waits for the keyboard composition to end
// (src/components/PhoneField.tsx). Here: Enter/"Go" on the phone keyboard with
// "I'm not a robot" unticked does not send blind (with the keyboard open the box
// and the button are off screen): close the keyboard, take the visitor to the
// box and show the message. Box ticked = send, as the button does.
function cpconImeComposing(e) {
  return !!(e && (e.isComposing || e.inputType === 'insertCompositionText'));
}
function cpconPhoneEnter(e) {
  if (e.key !== 'Enter' || cpconImeComposing(e)) return;
  e.preventDefault();
  var robot = document.getElementById('cpcon-form-robot');
  if (robot && !robot.checked) {
    cpconSetFieldError(robot, document.getElementById('cpcon-form-robot-err'), 'Please tick "I\'m not a robot" next to the button to send.');
    cpconCaptureTelemetry('capture_rejected', { reason: 'robot_box', fields: ['not_a_robot'], errors: ['not_a_robot:robot_box'], phone_country: cpconState.userPhoneCountry });
    try { e.target.blur(); robot.focus(); robot.scrollIntoView({ block: 'center' }); } catch (err) { /* ok */ }
    return;
  }
  cpconSubmitForm();
}

async function cpconSubmitForm() {
  if (!cpconCaptureGuard()) return;
  const nomeInp = document.getElementById('cpcon-form-nome');
  const emailInp = document.getElementById('cpcon-form-email');
  const empresaInp = document.getElementById('cpcon-form-empresa');
  const robotInp = document.getElementById('cpcon-form-robot');
  const nomeErr = document.getElementById('cpcon-form-nome-err');
  const emailErr = document.getElementById('cpcon-form-email-err');
  const empresaErr = document.getElementById('cpcon-form-empresa-err');
  const telErr = document.getElementById('cpcon-form-tel-err');
  const robotErr = document.getElementById('cpcon-form-robot-err');
  const telInp = document.getElementById('cpcon-form-tel');
  cpconSetFieldError(nomeInp, nomeErr, ''); cpconSetFieldError(emailInp, emailErr, '');
  cpconSetFieldError(empresaInp, empresaErr, ''); cpconSetFieldError(telInp, telErr, '');
  cpconSetFieldError(robotInp, robotErr, '');
  const nome = validateName(nomeInp.value);
  const email = validateEmail(emailInp.value);
  const empresa = validateCompany(empresaInp.value);
  // 16/10/2026: read() = resolve: dialling code typed (+351…) decides the country; default GB.
  const phone = cpconState.phoneCtl ? cpconState.phoneCtl.read() : { ok: false, message: 'The phone field could not be loaded. Please email us at contact@cpcongroup.com.', reasonCode: 'other' };
  const failed = []; // [field, key, element] in screen order
  if (!nome) { cpconSetFieldError(nomeInp, nomeErr, 'Please enter a valid name (min. 3 letters)'); failed.push(['nome', 'name_invalid', nomeInp]); }
  if (!email) { cpconSetFieldError(emailInp, emailErr, 'Please enter a valid work email'); failed.push(['email', 'email_invalid', emailInp]); }
  if (!empresa) { cpconSetFieldError(empresaInp, empresaErr, 'Please enter a valid company (min. 2 letters)'); failed.push(['empresa', 'company_invalid', empresaInp]); }
  if (!phone.ok) {
    // 17/10/2026: empty field = required (not "invalid").
    cpconSetFieldError(telInp, telErr, (telInp && !String(telInp.value || '').replace(/[^0-9\u0660-\u0669\u06F0-\u06F9]/g, '')) ? 'Phone number is required.' : phone.message);
    failed.push(['phone', !cpconState.phoneCtl ? 'phone_api_missing' : phone.reasonCode === 'country' ? 'phone_country' : 'phone_invalid', telInp || document.getElementById('cpcon-form-phone-slot')]);
  }
  if (!robotInp || !robotInp.checked) {
    cpconSetFieldError(robotInp, robotErr, 'Please tick "I\'m not a robot" next to the button to send.');
    failed.push(['not_a_robot', 'robot_box', robotInp]);
  }
  if (failed.length) {
    const keys = failed.map(function (f) { return f[1]; });
    const reason = keys.indexOf('robot_box') !== -1 ? 'robot_box'
      : keys.indexOf('phone_country') !== -1 ? 'country'
      : (keys.indexOf('phone_invalid') !== -1 || keys.indexOf('phone_api_missing') !== -1) ? 'phone' : 'other';
    cpconCaptureTelemetry('capture_rejected', {
      reason: reason,
      fields: failed.map(function (f) { return f[0]; }),
      errors: failed.map(function (f) { return f[0] + ':' + f[1]; }),
      phone_country: cpconState.userPhoneCountry,
    });
    const first = failed[0][2];
    if (first && first.focus) { try { first.focus(); first.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
    return;
  }

  cpconState.userName = nome;
  cpconState.userEmail = email;
  cpconState.userEmpresa = empresa;
  cpconState.userPhone = phone.e164;
  cpconState.userPhoneCountry = phone.country;
  cpconState.honeypot = cpconTrapValue();
  cpconCaptureTelemetry('capture_submitted', { phone_country: phone.country });

  if (cpconState.phoneCtl && cpconState.phoneCtl.destroy) cpconState.phoneCtl.destroy();
  cpconState.phoneCtl = null;
  document.getElementById('cpcon-inline-form')?.remove();
  cpconMeMsg(nome + ' — ' + email + ' — ' + empresa + ' — ' + phone.e164);

  // Create the initial lead in the CRM (does not block the chat).
  // Defences: HMAC form token + trap field + Zod validation.
  // A rejection is shown to the visitor. Retry only covers a network/5xx blip,
  // so a deliberate reject is not posted twice.
  try {
    const honeypot = cpconTrapValue();
    {
      const leadFields = {
          nome: nome,
          email: email,
          telefone: phone.e164,
          phone_country: phone.country,
          not_a_robot: true,
          empresa: empresa,
          origem: 'chatbot-uk',
          pagina: window.location.pathname,
          cpcon_hp_a: honeypot,
          _render_elapsed_ms: 5000,
        };
      const postLead = async function () {
        const form_token = await cpconFetchFormToken();
        try {
          const r = await fetch(CRM_PROXY_URL + '/chatbot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(Object.assign({}, leadFields, { form_token: form_token })),
          });
          const body = await r.json().catch(function () { return null; });
          return { network: false, ok: r.ok, status: r.status, body: body };
        } catch (e) {
          return { network: true, ok: false, status: 0, body: null };
        }
      };
      let resp = await postLead();
      if (resp.network || resp.status >= 500) {
        await new Promise(function (r) { setTimeout(r, 1500); });
        resp = await postLead();
      }
      const accepted = resp && !resp.network && resp.ok && resp.body && resp.body.ok !== false;
      if (!accepted) {
        cpconCaptureTelemetry('capture_rejected', { reason: 'other', errors: [resp && resp.network ? 'server:network' : 'server:rejected'] });
        const errText = (resp && resp.body && resp.body.error) ||
          ('We could not accept this enquiry automatically. Please email us at ' +
            ((window.CPCON_CONFIG && window.CPCON_CONFIG.contactEmail) || 'contact@cpcongroup.com') + '.');
        cpconShowSystemMessage(errText);
      } else {
        if (resp.body.lead_id) cpconState.leadId = resp.body.lead_id;
        try {
          (window.dataLayer = window.dataLayer || []).push({
            event: 'generate_lead',
            form_name: 'chatbot',
            lead_source: 'chatbot',
            page_path: window.location.pathname,
          });
        } catch (e) { /* analytics optional */ }
      }
    }
  } catch (e) {
    cpconShowSystemMessage(
      'We could not send your enquiry. Please email us at ' +
      ((window.CPCON_CONFIG && window.CPCON_CONFIG.contactEmail) || 'contact@cpcongroup.com') + '.'
    );
  }

  cpconState.stage = 'greeting';
  // Open the conversation by calling /api/chat with an empty message (backend replies with E1)
  cpconState.stage = 'chat';
  cpconCallChat('');
}

// -- Call to /api/chat ---------------------------------------
async function cpconCallChat(userText, extra) {
  if (cpconState.busy) return;
  if (cpconState.transferred) {
    cpconSay('Your details are with our team and a specialist will be in touch shortly.');
    return;
  }
  cpconState.busy = true;
  cpconDisableInput();
  cpconShowTyping();

  if (userText) cpconState.history.push({ role: 'user', content: userText });
  if (userText) cpconExtractContact(userText);

  let messages = cpconState.history.slice(-10);
  if (messages.length === 0) {
    messages = [{ role: 'user', content: '[start]' }];
  }

  const payload = {
    messages: messages,
    userContext: {
      nome: cpconState.userName,
      email: cpconState.userEmail,
      telefone: cpconState.userPhone,
      empresa: cpconState.userEmpresa || undefined,
    },
    max_tokens: 200,
    cpcon_hp_a: cpconTrapValue(),
  };
  if (cpconState.sessionId) payload.session_id = cpconState.sessionId;
  if (extra && extra.segment_choice) payload.segment_choice = extra.segment_choice;
  if (extra && extra.handoff_response) payload.handoff_response = extra.handoff_response;

  let data = null;
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(function () { return null; });
    if (!res.ok) {
      cpconHideTyping();
      cpconSay('I have hit a small snag here — not to worry. I will pass your enquiry to our team.');
      cpconState.busy = false;
      cpconFireTransfer('backend-error');
      return;
    }
  } catch (e) {
    cpconHideTyping();
    cpconSay('I have hit a small snag here. I will alert our team.');
    cpconState.busy = false;
    cpconFireTransfer('network-error');
    return;
  }

  cpconHideTyping();
  cpconState.busy = false;
  cpconState.sessionId = data.session_id || cpconState.sessionId;
  cpconState.stage = data.stage || cpconState.stage;
  cpconState.lastActivityAt = Date.now();

  if (data.reply) {
    // chat-guard: keep the server signature of the reply; without it the
    // server will not send this turn back to the model.
    var turn = { role: 'assistant', content: data.reply };
    if (typeof data.reply_sig === 'string' && data.reply_sig) turn.sig = data.reply_sig;
    cpconState.history.push(turn);
    if (typeof data.turn_count === 'number') cpconState.turns = data.turn_count;
    if (typeof data.handoff_offered === 'boolean') cpconState.handoffOffered = data.handoff_offered;
    if (typeof data.conversation_ended === 'boolean') cpconState.conversationEnded = data.conversation_ended;
    if (data.tags) {
      cpconState.lastSegment = (data.tags.find && data.tags.find(function (t) { return /^segmento:/.test(t); }) || '').replace('segmento:', '') || cpconState.lastSegment || null;
      cpconState.lastTema = (data.tags.find && data.tags.find(function (t) { return /^tema:/.test(t); }) || '').replace('tema:', '') || cpconState.lastTema || null;
    }

    cpconSay(data.reply, function () {
      // Priority order:
      // 1. conversation_ended (refusal recorded by backend)
      // 2. handoff_immediate (trigger T1-T5 or LLM fallback)
      // 3. transferred (legacy off-topic / meeting / price)
      // 4. showSegmentButtons (E2.5)
      // 5. offer_handoff_button (reached the 6th exchange — offers Yes/No)
      // 6. default — input enabled for the next turn
      if (data.conversation_ended) {
        cpconShowConversationEnded(data);
      } else if (data.handoff_immediate) {
        cpconHandleImmediateHandoff(data);
      } else if (data.transferred) {
        cpconState.transferred = true;
        cpconFireTransfer(data.tags || []);
      } else if (data.showSegmentButtons) {
        cpconShowSegmentButtons();
      } else if (data.offer_handoff_button) {
        cpconShowHandoffOffer(data);
      } else {
        cpconEnableInput();
        cpconScheduleReengage();
      }
    });
  } else {
    cpconEnableInput();
  }
}

function cpconShowSegmentButtons() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cpcon-seg-btns';
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 12px 12px;';
  const buttons = [
    { label: 'Small & Medium Enterprises', value: 'sme' },
    { label: 'Large Enterprises', value: 'enterprise' },
    { label: 'Public Sector', value: 'public-sector' },
    { label: 'Non-profit / Third Sector', value: 'non-profit' },
  ];
  buttons.forEach(function (b) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = 'cpcon-seg-btn';
    btn.style.cssText = 'background:#003A7A;color:#fff;border:0;padding:8px 12px;border-radius:16px;font-size:12px;cursor:pointer;';
    btn.onclick = function () {
      row.remove();
      cpconMeMsg(b.label);
      cpconCallChat(b.label, { segment_choice: b.value });
    };
    row.appendChild(btn);
  });
  container.appendChild(row);
  cpconScrollDown();
  cpconDisableInput();
}

// -- Handoff (no WhatsApp) -----------------------------------
// CPCON UK has no WhatsApp. The handoff records the visitor's details
// for the team. A mailto: link is offered as a fallback.

function cpconBuildMailtoUrl() {
  const email = (window.CPCON_CONFIG && window.CPCON_CONFIG.contactEmail) || 'contact@cpcongroup.com';
  const nome = cpconState.userName || '';
  const subject = 'Enquiry from cpcongroup.uk' + (cpconState.userEmpresa ? ' — ' + cpconState.userEmpresa : '');
  const parts = ['Hello,', '', 'I started an enquiry via the CPCON UK website chat.'];
  if (nome) parts.push('My name is ' + nome + '.');
  parts.push('I would like to speak with your specialist team.');
  return 'mailto:' + email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(parts.join('\n'));
}

// CTA button shown when a handoff is needed. Records the lead, then shows
// a confirmation plus a mailto: fallback link.
function cpconAppendHandoffCta() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;

  const existing = document.getElementById('cpcon-cta-btn');
  if (existing && existing.parentElement) existing.parentElement.remove();

  const row = document.createElement('div');
  row.id = 'cpcon-cta-row';
  row.className = 'cpcon-cta-row';

  const btn = document.createElement('button');
  btn.id = 'cpcon-cta-btn';
  btn.type = 'button';
  btn.className = 'cpcon-cta-btn';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
    '<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>' +
    '</svg>' +
    '<span class="cpcon-cta-text">' +
      '<span class="cpcon-cta-main">Have our team get in touch</span>' +
      '<span class="cpcon-cta-sub">Leave your details and a specialist will be in touch</span>' +
    '</span>';

  btn.onclick = async function () {
    if (btn.disabled) return;
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<span class="cpcon-cta-text"><span class="cpcon-cta-main">Please wait…</span></span>';
    try {
      await cpconPostLeadHandoff({ accepted_handoff: true });
      btn.disabled = false;
      cpconShowSystemMessage('Thank you. Your details are with our team and a specialist will be in touch. If you prefer, you can also email us at ' + ((window.CPCON_CONFIG && window.CPCON_CONFIG.contactEmail) || 'contact@cpcongroup.com') + '.');
      if (row.parentElement) row.remove();
      cpconState.transferred = true;
      cpconDisableInput();
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
      const fallback = document.createElement('a');
      fallback.href = cpconBuildMailtoUrl();
      fallback.className = 'cpcon-cta-btn';
      fallback.style.marginTop = '8px';
      fallback.innerHTML =
        '<span class="cpcon-cta-text"><span class="cpcon-cta-main">Email our team instead</span>' +
        '<span class="cpcon-cta-sub">contact@cpcongroup.com</span></span>';
      row.appendChild(fallback);
    }
  };

  row.appendChild(btn);
  container.appendChild(row);
  cpconScrollDown();
}

// -- Handoff offer (Yes / No) on the 6th exchange ------------
function cpconShowHandoffOffer(data) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  cpconState.handoffOffered = true;

  if (document.getElementById('cpcon-handoff-offer')) {
    cpconEnableInput();
    return;
  }

  const wrap = document.createElement('div');
  wrap.id = 'cpcon-handoff-offer';
  wrap.className = 'cpcon-handoff-offer';
  wrap.innerHTML =
    '<div class="cpcon-handoff-question">Would you like one of our specialists to get in touch? Just leave it with us and we will be in touch.</div>' +
    '<div class="cpcon-handoff-actions">' +
    '<button type="button" class="cpcon-handoff-yes-btn" id="cpcon-handoff-yes">' +
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>' +
    '</svg>' +
    'Yes, please get in touch</button>' +
    '<button type="button" class="cpcon-handoff-no-btn" id="cpcon-handoff-no">No, thank you</button>' +
    '</div>';
  container.appendChild(wrap);
  cpconScrollDown();
  cpconDisableInput();

  document.getElementById('cpcon-handoff-yes').onclick = function () {
    cpconAcceptHandoffButton();
  };
  document.getElementById('cpcon-handoff-no').onclick = function () {
    cpconDeclineHandoffButton();
  };
}

async function cpconAcceptHandoffButton() {
  const offer = document.getElementById('cpcon-handoff-offer');
  const yesBtn = document.getElementById('cpcon-handoff-yes');
  const noBtn = document.getElementById('cpcon-handoff-no');
  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  try {
    await cpconPostLeadHandoff({ accepted_handoff: true });
  } catch (err) {
    cpconShowSystemMessage(
      'We are experiencing a brief interruption. Please email us directly at ' + ((window.CPCON_CONFIG && window.CPCON_CONFIG.contactEmail) || 'contact@cpcongroup.com') + '.'
    );
    if (yesBtn) yesBtn.disabled = false;
    if (noBtn) noBtn.disabled = false;
    return;
  }

  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_handoff',
      trigger_type: 'button_6th_turn_yes',
      turn_count_at_handoff: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics optional */ }

  if (offer) offer.remove();
  cpconShowSystemMessage('Thank you. Your details are with our team and a specialist will be in touch shortly.');
  cpconState.transferred = true;
  cpconDisableInput();
}

async function cpconDeclineHandoffButton() {
  const offer = document.getElementById('cpcon-handoff-offer');
  const yesBtn = document.getElementById('cpcon-handoff-yes');
  const noBtn = document.getElementById('cpcon-handoff-no');
  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  try {
    await cpconPostLeadHandoff({
      chat_completed_no_handoff: true,
      recusal_method: 'button_no',
    });
  } catch (err) {
    console.error('[Camile] decline POST failed', err);
  }

  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_chat_ended_no_handoff',
      turn_count_at_end: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      recusal_method: 'button_no',
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics optional */ }

  if (offer) offer.remove();
  // Tell the backend "no" so it marks conversation_ended and logs the tag.
  cpconCallChat('No, thank you', { handoff_response: 'no' });
}

// Trigger T1-T5 or LLM fallback — backend already set transferred=true.
// Frontend records the lead and shows the handoff CTA.
function cpconHandleImmediateHandoff(data) {
  cpconState.transferred = true;
  cpconDisableInput();

  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'camile_handoff',
      trigger_type: data.trigger_type || 'unknown',
      trigger_reason: data.trigger_reason || '',
      turn_count_at_handoff:
        data.turn_count_at_handoff || cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics optional */ }

  setTimeout(function () {
    cpconPostLeadHandoff({
      handoff_trigger_type: data.trigger_type || 'unknown',
    }).catch(function (err) {
      console.error('[Camile] immediate handoff POST failed', err);
    });
    setTimeout(function () {
      cpconAppendHandoffCta();
    }, 400);
  }, 400);
}

// Conversation ended after the client declined. Backend already set
// conversation_ended=true and returned the closing line in data.reply.
function cpconShowConversationEnded(_data) {
  cpconState.transferred = true;
  cpconState.conversationEnded = true;
  cpconDisableInput();

  const inp = document.getElementById('cpcon-inp');
  if (inp) inp.placeholder = 'Conversation ended';

  if (!document.getElementById('cpcon-ended-badge')) {
    const container = document.getElementById('cpcon-msgs');
    if (container) {
      const badge = document.createElement('div');
      badge.id = 'cpcon-ended-badge';
      badge.className = 'cpcon-ended-badge';
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      badge.textContent = 'Conversation ended';
      container.appendChild(badge);
      cpconScrollDown();
    }
  }
}

// Lightweight non-PII hash of session_id for telemetry. 8 hex.
function cpconHashSession(sid) {
  if (!sid) return '';
  let h = 0;
  for (let i = 0; i < sid.length; i += 1) {
    h = ((h << 5) - h + sid.charCodeAt(i)) | 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

// System message (neutral, no avatar).
function cpconShowSystemMessage(text) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cpcon-system-msg';
  row.textContent = text;
  container.appendChild(row);
  cpconScrollDown();
}

// Short conversation summary to attach to the lead.
function cpconBuildConversationSummary() {
  const lines = ['Conversation summary via Camile:'];
  if (cpconState.userName) lines.push('- Contact: ' + cpconState.userName);
  if (cpconState.userEmpresa) lines.push('- Company: ' + cpconState.userEmpresa);
  if (cpconState.lastSegment) lines.push('- Segment: ' + cpconState.lastSegment);
  if (cpconState.lastTema) lines.push('- Need: ' + cpconState.lastTema);
  lines.push('- Total exchanges: ' + (cpconState.turns || cpconState.history.length));
  const lastMsg = (cpconState.history.filter(function (m) { return m.role === 'user'; }).slice(-1)[0] || {}).content;
  if (lastMsg) lines.push('- Last message: ' + String(lastMsg).slice(0, 200));
  return lines.join('\n');
}

// POST /api/leads/chatbot to record the qualified lead at handoff time.
// Resolves on HTTP 200; throws otherwise so the caller can offer the
// email fallback.
async function cpconPostLeadHandoff(opts) {
  opts = opts || {};
  const refusal = !!opts.chat_completed_no_handoff;
  const tail = refusal
    ? '\n\nThe visitor declined to continue. Lead archived.'
    : '\n\nThe visitor asked our team to get in touch.';
  const payload = {
    nome: cpconState.userName,
    email: cpconState.userEmail,
    empresa: cpconState.userEmpresa || '',
    telefone: cpconState.userPhone,
    phone_country: cpconState.userPhoneCountry || 'GB',
    not_a_robot: true,
    mensagem: cpconBuildConversationSummary() + tail,
    origem: 'chatbot-uk',
    pagina_origem: window.location.href,
    cpcon_hp_a: cpconTrapValue(),
    metadata: {
      segmento: cpconState.lastSegment || null,
      demanda: cpconState.lastTema || null,
      handoff_via: opts.handoff_trigger_type
        ? 'trigger_' + String(opts.handoff_trigger_type)
        : refusal
          ? 'refused'
          : 'team_followup',
      handoff_trigger_type: opts.handoff_trigger_type || null,
      recusal_method: opts.recusal_method || null,
      turn_count: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconState.sessionId,
    },
  };
  if (refusal) payload.chat_completed_no_handoff = true;
  // chat-guard: the server builds the CRM summary from the turns (bot turns
  // verified by signature). Capped at ~9 KB (endpoint limit 16 KB).
  if (cpconState.sessionId) payload.session_id = cpconState.sessionId;
  var turns = cpconState.history.slice(-40).map(function (m) {
    var t = { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) };
    if (m.role === 'assistant' && m.sig) t.sig = m.sig;
    return t;
  }).filter(function (t) { return t.content; });
  while (turns.length > 1 && JSON.stringify(turns).length > 9000) turns.shift();
  if (turns.length) payload.conversation_turns = turns;
  payload.form_token = await cpconFetchFormToken();

  let leadId = null;
  try {
    const res = await fetch('/api/leads/chatbot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || data.ok === false) {
      const msg = (data && data.error) || ('POST /api/leads/chatbot HTTP ' + res.status);
      throw new Error(msg);
    }
    leadId = data.lead_id || null;
  } catch (err) {
    if (!refusal) {
      const fallback = 'Please email us directly at ' +
        ((window.CPCON_CONFIG && window.CPCON_CONFIG.contactEmail) || 'contact@cpcongroup.com') + '.';
      const text = err && err.message && err.message.indexOf('POST /api/leads/chatbot HTTP') !== 0
        ? err.message
        : ('We could not accept this enquiry automatically. ' + fallback);
      cpconShowSystemMessage(text);
    }
    throw err;
  }

  if (!refusal) {
    try {
      (window.dataLayer = window.dataLayer || []).push({
        event: 'camile_lead_captured',
        source: 'camile_handoff',
        trigger_type:
          opts.handoff_trigger_type || (opts.accepted_handoff ? 'button_6th_turn_yes' : 'manual'),
        turn_count_at_handoff: cpconState.turns || cpconState.history.length || 0,
        session_id: cpconHashSession(cpconState.sessionId),
        leadId: leadId,
      });
    } catch (e) { /* analytics optional */ }
  }
}

// -- Transfer to a human -------------------------------------
async function cpconFireTransfer(tagsOrReason) {
  if (cpconState._transferFired) return;
  cpconState._transferFired = true;
  cpconState.transferred = true;

  // Best-effort: record the lead with whatever we have.
  cpconPostLeadHandoff({ handoff_trigger_type: Array.isArray(tagsOrReason) ? (tagsOrReason[0] || 'transferred') : String(tagsOrReason || 'transferred') })
    .catch(function () { /* CTA fallback below covers failures */ });

  cpconDisableInput();
  setTimeout(function () {
    cpconAppendNotice('Our team has been notified. Your details have been recorded.');
    setTimeout(function () {
      cpconAppendHandoffCta();
    }, 800);
  }, 400);
}

// -- Central handler -----------------------------------------
function cpconOnSend() {
  const inp = document.getElementById('cpcon-inp');
  if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  if (v.length > 500) {
    cpconSay('That message is a little long for me. Could you summarise it in up to 500 characters?');
    return;
  }
  inp.value = '';
  inp.style.height = 'auto';
  cpconMeMsg(v);
  cpconState.lastActivityAt = Date.now();
  if (cpconState.transferred) {
    cpconSay('Your details are with our team and a specialist will be in touch shortly.');
    return;
  }
  cpconCallChat(v);
}

function cpconOnKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cpconOnSend(); }
}

// -- Shared utilities ----------------------------------------
function cpconShowTyping() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.id = 'cpcon-typing';
  row.className = 'cpcon-row';
  row.innerHTML = '<div class="cpcon-av"><img src="/chatbot/images/camile.webp" alt="Camile" width="26" height="26"/></div><div class="cpcon-bbl"><div class="cpcon-typing"><span></span><span></span><span></span></div></div>';
  container.appendChild(row);
  cpconScrollDown();
}
function cpconHideTyping() {
  const n = document.getElementById('cpcon-typing');
  if (n) n.remove();
}

function cpconEnableInput() {
  const inp = document.getElementById('cpcon-inp');
  const btn = document.getElementById('cpcon-send-btn');
  if (btn) btn.disabled = false;
  if (inp) {
    inp.disabled = false;
    inp.placeholder = 'Type your message';
    inp.focus();
  }
}

function cpconDisableInput() {
  const inp = document.getElementById('cpcon-inp');
  const btn = document.getElementById('cpcon-send-btn');
  if (btn) btn.disabled = true;
  if (inp) inp.disabled = true;
}

function cpconScrollDown() {
  const m = document.getElementById('cpcon-msgs');
  if (m) m.scrollTop = m.scrollHeight;
}

function cpconResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
}

function cpconEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cpconNl2br(s) { return s.replace(/\n/g, '<br>'); }

// On page unload, close the session on the backend.
window.addEventListener('beforeunload', function () {
  if (cpconState.sessionId) {
    try {
      navigator.sendBeacon('/api/chat?session_id=' + encodeURIComponent(cpconState.sessionId));
    } catch (e) {}
  }
});
