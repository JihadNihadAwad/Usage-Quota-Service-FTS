// Vanilla-JS demo page: scenario and check buttons, result cards with
// the exact API request per step, and a live-state side panel. The heavy
// lifting (auth, orchestration, assertions) is server-side in client/core -
// this file only renders.

const $buttons = document.getElementById('buttons');
const $checkButtons = document.getElementById('check-buttons');
const $cards = document.getElementById('cards');
const $status = document.getElementById('status');
const $panelBody = document.getElementById('panel-body');

async function loadScenarios() {
  const res = await fetch('/api/scenarios');
  const data = await res.json();

  $buttons.innerHTML = '';
  $checkButtons.innerHTML = '';
  for (const s of data.scenarios) {
    const btn = document.createElement('button');
    btn.textContent = `${s.number}. ${s.title}`;
    if (s.needsSetup && !data.setup) {
      btn.disabled = true;
      btn.title = 'run Setup (or Run all) first';
    }
    btn.addEventListener('click', () => runScenario(s.number));
    (s.category === 'check' ? $checkButtons : $buttons).appendChild(btn);
  }

  $status.textContent = data.setup
    ? `Run ${data.runId} ready — account bootstrapped, key held server-side.`
    : 'No account yet — click 1 (Setup) or 7 (Run all).';
}

async function loadPanel() {
  const res = await fetch('/api/state');
  const data = await res.json();
  renderPanel(data);
}

async function runScenario(n) {
  $status.textContent = `Running ${n}…`;
  let result;
  try {
    const res = await fetch(`/api/scenario/${n}`, { method: 'POST' });
    result = await res.json();
  } catch (err) {
    $status.textContent = `Scenario ${n} could not run — is the usage API up? (${err})`;
    return;
  }
  renderCard(result);
  await Promise.all([loadScenarios(), loadPanel()]);
}

/* ------------------------------- cards ------------------------------- */

function renderCard(result) {
  const card = document.createElement('article');
  card.className = `card ${result.passed ? 'pass' : 'fail'} ${result.category}`;

  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = `
    <span class="badge ${result.passed ? 'ok' : 'bad'}">${result.passed ? 'PASS' : 'FAIL'}</span>
    <strong>${result.number}. ${escapeHtml(result.title)}</strong>
    <span class="kind">${result.category === 'check' ? 'check' : 'scenario'}</span>`;
  card.appendChild(head);

  if (result.failure) {
    const fail = document.createElement('p');
    fail.className = 'failure';
    fail.textContent = result.failure;
    card.appendChild(fail);
  }

  for (const step of result.steps) {
    card.appendChild(renderStep(step));
  }

  $cards.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderStep(step) {
  const div = document.createElement('div');
  div.className = 'step';

  if (step.label !== undefined) {
    const label = document.createElement('p');
    label.className = 'step-label';
    label.textContent = step.label;
    if (
      step.label.includes('-> 404') ||
      step.label.includes('-> 403') ||
      step.label.includes('-> 409') ||
      step.label.includes('-> 400')
    ) {
      label.classList.add('expected-error');
    }
    if (step.label.includes('ACCEPTED')) label.classList.add('accepted');
    if (step.label.includes('REJECTED')) label.classList.add('rejected');
    div.appendChild(label);
  }

  if (step.request !== undefined) {
    div.appendChild(requestChip(step.request));
  }

  if (step.status !== undefined) {
    const status = document.createElement('span');
    status.className = 'chip status-chip';
    status.textContent = `HTTP ${step.status}`;
    div.appendChild(status);
  }

  if (step.note !== undefined) {
    const note = document.createElement('p');
    note.className = 'step-note';
    note.textContent = step.note;
    div.appendChild(note);
  }

  if (step.response !== undefined) {
    const isDecision =
      typeof step.response === 'object' &&
      step.response !== null &&
      'accepted' in step.response &&
      'units_consumed' in step.response;

    if (isDecision) {
      div.appendChild(decisionChips(step.response));
    }

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'raw response';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(step.response, null, 2);
    details.appendChild(summary);
    details.appendChild(pre);
    div.appendChild(details);
  }

  return div;
}

/** The exact API call a step made: method, path, body. */
function requestChip(request) {
  const chip = document.createElement('p');
  chip.className = 'req-chip';
  const method = document.createElement('span');
  method.className = 'req-method';
  method.textContent = request.method;
  chip.appendChild(method);

  const path = document.createElement('span');
  path.className = 'req-path';
  path.textContent = `/v1${request.path}`;
  chip.appendChild(path);

  if (request.body !== undefined) {
    const body = document.createElement('span');
    body.className = 'req-body';
    body.textContent = JSON.stringify(request.body);
    chip.appendChild(body);
  }

  return chip;
}

function decisionChips(d) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';

  const outcome = document.createElement('span');
  outcome.className = `chip ${d.accepted ? 'ok' : 'bad'}`;
  outcome.textContent = d.accepted
    ? `ACCEPTED — ${d.units} units (consumed ${d.units_consumed})`
    : `REJECTED — consumed ${d.units_consumed}`;
  wrap.appendChild(outcome);

  if (!d.accepted && d.reason) {
    const reason = document.createElement('span');
    reason.className = 'chip warn';
    reason.textContent = `${d.reason.level} · ${d.reason.rule} — ${d.reason.message}`;
    wrap.appendChild(reason);
  }

  for (const level of ['user', 'account']) {
    const s = d[level];
    if (!s) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${level}: ${s.used_units} used · ${fmtRemaining(s.remaining)} remaining`;
    wrap.appendChild(chip);
  }

  return wrap;
}

/* ----------------------------- side panel ----------------------------- */

function renderPanel(data) {
  if (!data.setup) {
    $panelBody.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent =
      'No account yet. Run Setup or Run all to bootstrap one; this panel then shows the live plan and usage state.';
    $panelBody.appendChild(p);
    return;
  }

  if (data.error !== undefined) {
    $panelBody.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `usage api unreachable: ${data.error}`;
    $panelBody.appendChild(p);
    return;
  }

  $panelBody.innerHTML = '';

  $panelBody.appendChild(kv('run', data.runId));
  $panelBody.appendChild(kv('api', data.apiUrl));

  const acctTitle = document.createElement('h3');
  acctTitle.textContent = `Account · ${data.account.name}`;
  $panelBody.appendChild(acctTitle);
  $panelBody.appendChild(planLine(data.account.plan));
  $panelBody.appendChild(usageBar('shared usage', data.usage));

  $panelBody.appendChild(document.createElement('hr'));
  const usersTitle = document.createElement('h3');
  usersTitle.textContent = 'Users (individual plans)';
  $panelBody.appendChild(usersTitle);

  for (const u of data.users) {
    const block = document.createElement('div');
    block.className = 'panel-user';
    const name = document.createElement('p');
    name.className = 'panel-user-name';
    name.textContent = u.external_id;
    block.appendChild(name);
    block.appendChild(planLine(u.plan));
    block.appendChild(usageBar('usage', u.usage));
    $panelBody.appendChild(block);
  }

  $panelBody.appendChild(document.createElement('hr'));
  const plansTitle = document.createElement('h3');
  plansTitle.textContent = 'Plans visible to this account';
  $panelBody.appendChild(plansTitle);

  for (const plan of data.plans) {
    const row = document.createElement('div');
    row.className = 'panel-plan';
    const label = document.createElement('span');
    label.textContent = plan.name;
    row.appendChild(label);
    const meta = document.createElement('span');
    meta.className = 'panel-plan-meta';
    meta.textContent = `${plan.predefined ? 'predefined' : 'custom'} · ${plan.scope} · ${rulesText(plan.rules)}`;
    row.appendChild(meta);
    $panelBody.appendChild(row);
  }
}

function kv(k, v) {
  const p = document.createElement('p');
  p.className = 'panel-kv';
  const key = document.createElement('span');
  key.textContent = k;
  const val = document.createElement('code');
  val.textContent = v;
  p.appendChild(key);
  p.appendChild(val);
  return p;
}

function planLine(plan) {
  const p = document.createElement('p');
  p.className = 'panel-plan-line';
  p.textContent = `${plan.name} (${rulesText(plan.rules)})`;
  return p;
}

function rulesText(rules) {
  const parts = [];
  if (rules.monthly_allowance !== undefined) parts.push(`${fmt(rules.monthly_allowance)}/mo`);
  if (rules.max_per_request !== undefined) parts.push(`${fmt(rules.max_per_request)}/req`);
  if (rules.monthly_request_cap !== undefined)
    parts.push(`${fmt(rules.monthly_request_cap)} calls/mo`);
  return parts.join(', ');
}

function usageBar(label, usage) {
  const wrap = document.createElement('div');
  wrap.className = 'usage';

  const head = document.createElement('div');
  head.className = 'usage-head';
  const used = usage.used_units;
  const allowance = usage.allowance;
  const remaining = usage.remaining;
  head.textContent =
    allowance === null
      ? `${label}: ${fmt(used)} used (no allowance configured)`
      : `${label}: ${fmt(used)} / ${fmt(allowance)} used · ${fmt(remaining ?? 0)} left`;
  wrap.appendChild(head);

  if (allowance !== null && allowance > 0) {
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = `bar-fill ${used >= allowance ? 'maxed' : ''}`;
    fill.style.width = `${Math.min(100, (used / allowance) * 100)}%`;
    track.appendChild(fill);
    wrap.appendChild(track);
  }

  return wrap;
}

/* ------------------------------- misc ------------------------------- */

function fmtRemaining(remaining) {
  return remaining === null ? 'no allowance configured' : remaining.toLocaleString('en-US');
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

loadScenarios();
loadPanel();
