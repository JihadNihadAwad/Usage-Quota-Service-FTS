// Vanilla-JS demo page: one button per scenario, one card per result. The
// heavy lifting (auth, orchestration, assertions) is server-side in
// client/core - this file only renders.

const $buttons = document.getElementById('buttons');
const $cards = document.getElementById('cards');
const $status = document.getElementById('status');

let apiUrl = '';

async function loadScenarios() {
  const res = await fetch('/api/scenarios');
  const data = await res.json();
  apiUrl = data.apiUrl;

  $buttons.innerHTML = '';
  for (const s of data.scenarios) {
    const btn = document.createElement('button');
    btn.textContent = `${s.number}. ${s.title}`;
    if (s.needsSetup && !data.setup) {
      btn.disabled = true;
      btn.title = 'run Setup (or Run all) first';
    }
    btn.addEventListener('click', () => runScenario(s.number));
    $buttons.appendChild(btn);
  }

  $status.textContent = data.setup
    ? `Run ${data.runId} ready — account bootstrapped, key held server-side.`
    : 'No account yet — click 1 (Setup) or 7 (Run all).';
}

async function runScenario(n) {
  $status.textContent = `Running scenario ${n}…`;
  let result;
  try {
    const res = await fetch(`/api/scenario/${n}`, { method: 'POST' });
    result = await res.json();
  } catch (err) {
    $status.textContent = `Scenario ${n} could not run — is the usage API up? (${err})`;
    return;
  }
  renderCard(result);
  await loadScenarios();
}

function renderCard(result) {
  const card = document.createElement('article');
  card.className = `card ${result.passed ? 'pass' : 'fail'}`;

  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = `
    <span class="badge ${result.passed ? 'ok' : 'bad'}">${result.passed ? 'PASS' : 'FAIL'}</span>
    <strong>${result.number}. ${escapeHtml(result.title)}</strong>`;
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
    // Highlight the outcome inside the label line.
    if (step.label.includes('ACCEPTED')) label.classList.add('accepted');
    if (step.label.includes('REJECTED')) label.classList.add('rejected');
    div.appendChild(label);
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

function fmtRemaining(remaining) {
  return remaining === null ? 'no allowance configured' : remaining.toLocaleString('en-US');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

loadScenarios();
