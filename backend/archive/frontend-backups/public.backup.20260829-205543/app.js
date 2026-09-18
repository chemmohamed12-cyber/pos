// Daii Platform — V1 Demo Console
// Vanilla JS, no build step, no framework — a demo/verification tool, not
// the real Daii product UI (which will be Arabic-first per ADR-011 and
// driven by the Terminology Registry, not hardcoded English strings like
// this file). This exists to prove the backend's full cycle actually
// works end-to-end, exactly as requested.

const API = '/api';
const state = {
  personas: JSON.parse(localStorage.getItem('daii_personas') || '{}'), // email -> {id, email, fullName, accessToken, roles[]}
  active: localStorage.getItem('daii_active') || null,
  cycle: {}, // scratch state carried between demo steps (ids, etc.)
};

function savePersonas() {
  localStorage.setItem('daii_personas', JSON.stringify(state.personas));
  if (state.active) localStorage.setItem('daii_active', state.active);
}

async function api(method, path, body, personaEmail) {
  const persona = personaEmail ? state.personas[personaEmail] : state.active ? state.personas[state.active] : null;
  const headers = { 'Content-Type': 'application/json' };
  if (persona && persona.accessToken) headers['Authorization'] = `Bearer ${persona.accessToken}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { success: false, error: { message: `Non-JSON response (status ${res.status})` } };
  }
  return { ok: res.status < 400, status: res.status, body: json };
}

function fmt(x) {
  return JSON.stringify(x, null, 2);
}

// ---------- Personas ----------

async function registerPersona() {
  const fullName = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-pass').value;
  const out = document.getElementById('auth-result');
  out.style.display = 'block';
  const r = await api('POST', '/auth/register', { email, fullName, password });
  out.textContent = fmt(r.body);
  out.className = 'result ' + (r.ok ? 'ok' : 'err');
  if (r.ok) {
    await doLogin(email, password);
  }
}

async function loginPersona() {
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-pass').value;
  await doLogin(email, password);
}

async function doLogin(email, password) {
  const out = document.getElementById('auth-result');
  out.style.display = 'block';
  const r = await api('POST', '/auth/login', { email, password });
  out.textContent = fmt(r.body);
  out.className = 'result ' + (r.ok ? 'ok' : 'err');
  if (r.ok) {
    const accessToken = r.body.data.accessToken;
    // decode the JWT payload just enough to get the user id (sub) - no verification needed client-side, display only
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    state.personas[email] = { id: payload.sub, email, accessToken, roles: [] };
    state.active = email;
    savePersonas();
    await refreshRoles(email);
    renderPersonas();
    populateSelects();
  }
}

async function refreshRoles(email) {
  // best-effort: only admin can list users; roles aren't directly exposed per-user via API,
  // so we just track what we've assigned client-side for display purposes.
}

function renderPersonas() {
  const list = document.getElementById('persona-list');
  const emails = Object.keys(state.personas);
  if (emails.length === 0) {
    list.innerHTML = '<div class="sub">None yet — register the first one (becomes admin automatically).</div>';
    return;
  }
  list.innerHTML = emails
    .map((email) => {
      const p = state.personas[email];
      const active = email === state.active;
      return `<div class="persona ${active ? 'active' : ''}">
        <div><div class="name">${p.email}</div><div class="roles">${(p.roles || []).join(', ') || 'no roles assigned yet'}</div></div>
        <div><button class="small secondary" onclick="setActive('${email}')">${active ? 'active' : 'use'}</button></div>
      </div>`;
    })
    .join('');
}

function setActive(email) {
  state.active = email;
  savePersonas();
  renderPersonas();
  populateSelects();
}

function populateSelects() {
  const emails = Object.keys(state.personas);
  const roleUserSel = document.getElementById('role-user');
  const rawPersonaSel = document.getElementById('raw-persona');
  [roleUserSel, rawPersonaSel].forEach((sel) => {
    if (!sel) return;
    sel.innerHTML = emails.map((e) => `<option value="${e}">${e} (${state.personas[e].id.slice(0, 8)})</option>`).join('');
  });
}

async function assignRole() {
  const email = document.getElementById('role-user').value;
  const roleKey = document.getElementById('role-key').value;
  const out = document.getElementById('role-result');
  out.style.display = 'block';
  const userId = state.personas[email].id;
  const r = await api('POST', '/admin/roles/assign', { userId, roleKey }); // uses active (must be admin)
  out.textContent = fmt(r.body);
  out.className = 'result ' + (r.ok ? 'ok' : 'err');
  if (r.ok) {
    state.personas[email].roles = state.personas[email].roles || [];
    if (!state.personas[email].roles.includes(roleKey)) state.personas[email].roles.push(roleKey);
    savePersonas();
    renderPersonas();
  }
}

// ---------- Raw API explorer ----------

async function rawCall() {
  const method = document.getElementById('raw-method').value;
  const path = document.getElementById('raw-path').value;
  const personaEmail = document.getElementById('raw-persona').value;
  const bodyText = document.getElementById('raw-body').value.trim();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    alert('Body is not valid JSON');
    return;
  }
  const out = document.getElementById('raw-result');
  out.style.display = 'block';
  const r = await api(method, path, body, personaEmail);
  out.textContent = `HTTP ${r.status}\n` + fmt(r.body);
  out.className = 'result ' + (r.ok ? 'ok' : 'err');
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpage').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}

// ---------- Health check ----------

async function checkHealth() {
  const dot = document.getElementById('health-dot');
  const text = document.getElementById('health-text');
  try {
    const res = await fetch(`${API}/health/deep`);
    const json = await res.json();
    const healthy = json.success;
    dot.className = 'health-dot ' + (healthy ? 'health-ok' : 'health-bad');
    text.textContent = healthy ? 'backend + database: healthy' : 'backend degraded — check /api/health/deep';
  } catch {
    dot.className = 'health-dot health-bad';
    text.textContent = 'backend unreachable';
  }
}

// ---------- Full Cycle Demo ----------
// Each step is declarative: title, description, an async run() that calls
// the API (using whichever persona the step specifies), and a render()
// for any inputs it needs. Results feed into state.cycle for later steps.

const steps = [
  {
    title: '1. Create a Warehouse',
    desc: 'Admin creates the warehouse the whole cycle will use.',
    inputs: () => `<div class="row"><div><label>Code</label><input id="s1-code" value="MAIN-WH"/></div><div><label>Name</label><input id="s1-name" value="Main Warehouse"/></div></div>`,
    run: async () => {
      const code = document.getElementById('s1-code').value;
      const name = document.getElementById('s1-name').value;
      const r = await api('POST', '/inventory/warehouses', { code, name });
      if (r.ok) state.cycle.warehouseId = r.body.data.id;
      return r;
    },
  },
  {
    title: '2. Create a Product',
    desc: 'Admin creates a sellable product with a price, then activates it (draft → active).',
    inputs: () => `<div class="row"><div><label>SKU</label><input id="s2-sku" value="WIDGET-1"/></div><div><label>Name</label><input id="s2-name" value="Widget"/></div><div><label>Unit Price</label><input id="s2-price" value="150.00"/></div></div>`,
    run: async () => {
      const sku = document.getElementById('s2-sku').value;
      const name = document.getElementById('s2-name').value;
      const unitPrice = document.getElementById('s2-price').value;
      const r = await api('POST', '/products', { sku, name, unitPrice });
      if (!r.ok) return r;
      state.cycle.productId = r.body.data.id;
      const r2 = await api('POST', `/products/${r.body.data.id}/status`, { status: 'active' });
      return r2;
    },
  },
  {
    title: '3. Receive Stock',
    desc: 'Warehouse worker records a receipt movement (real stock, ledger-based — not a mutable field).',
    inputs: () => `<div class="row"><div><label>Persona (must have warehouse_worker role)</label><select id="s3-persona"></select></div><div><label>Quantity</label><input id="s3-qty" value="100"/></div></div>`,
    beforeRender: () => fillPersonaSelect('s3-persona'),
    run: async () => {
      const persona = document.getElementById('s3-persona').value;
      const quantity = Number(document.getElementById('s3-qty').value);
      return api(
        'POST',
        '/inventory/movements',
        { warehouseId: state.cycle.warehouseId, productId: state.cycle.productId, quantity, movementType: 'receipt' },
        persona,
      );
    },
  },
  {
    title: '4. Create Customer',
    desc: 'Admin creates a customer (Numbering issues its code automatically).',
    inputs: () => `<div class="row"><div><label>Name</label><input id="s4-name" value="Acme Trading Co."/></div><div><label>Phone</label><input id="s4-phone" value="+201000000000"/></div></div>`,
    run: async () => {
      const name = document.getElementById('s4-name').value;
      const phone = document.getElementById('s4-phone').value;
      const r = await api('POST', '/customers', { name, phone });
      if (r.ok) state.cycle.customerId = r.body.data.id;
      return r;
    },
  },
  {
    title: '5. Assign Sales Rep to Customer',
    desc: 'Admin assigns the customer to a Sales Rep — this also grants Scope so the rep can see this customer. The rep must exist as a persona with the sales_rep role first.',
    inputs: () => `<div class="row"><div><label>Sales Rep persona (must have sales_rep role)</label><select id="s5-rep"></select></div></div>`,
    beforeRender: () => fillPersonaSelect('s5-rep'),
    run: async () => {
      const repEmail = document.getElementById('s5-rep').value;
      state.cycle.salesRepEmail = repEmail;
      const repId = state.personas[repEmail].id;
      return api('POST', `/customers/${state.cycle.customerId}/assign`, { salesRepUserId: repId, assignmentType: 'primary' });
    },
  },
  {
    title: '6. Create Sales Order',
    desc: 'The Sales Rep creates the order. The total is computed server-side from the product\'s price — the client never sends a total.',
    inputs: () => `<div class="row"><div><label>Quantity</label><input id="s6-qty" value="5"/></div></div><div class="sub">Acting as: <span id="s6-actor" class="state-line"></span></div>`,
    beforeRender: () => {
      document.getElementById('s6-actor').textContent = state.cycle.salesRepEmail || '(complete step 5 first)';
    },
    run: async () => {
      const quantity = Number(document.getElementById('s6-qty').value);
      const r = await api(
        'POST',
        '/sales-orders',
        { customerId: state.cycle.customerId, lines: [{ productId: state.cycle.productId, quantity }] },
        state.cycle.salesRepEmail,
      );
      if (r.ok) state.cycle.salesOrderId = r.body.data.id;
      return r;
    },
  },
  {
    title: '7. Submit Order for Review',
    desc: 'Sales Rep submits — this auto-advances the order straight to "supervisor_review" (one client action, per blueprint §14).',
    run: async () => api('POST', `/sales-orders/${state.cycle.salesOrderId}/transition`, { action: 'submit' }, state.cycle.salesRepEmail),
  },
  {
    title: '8. Supervisor Approves',
    desc: 'A persona with the sales_supervisor role approves.',
    inputs: () => `<div class="row"><div><label>Supervisor persona</label><select id="s8-sup"></select></div></div>`,
    beforeRender: () => fillPersonaSelect('s8-sup'),
    run: async () => {
      const email = document.getElementById('s8-sup').value;
      return api('POST', `/sales-orders/${state.cycle.salesOrderId}/transition`, { action: 'supervisor_approve' }, email);
    },
  },
  {
    title: '9. Manager Approves',
    desc: 'A persona with the sales_manager role approves — order reaches "deposit_verification".',
    inputs: () => `<div class="row"><div><label>Manager persona</label><select id="s9-mgr"></select></div></div>`,
    beforeRender: () => fillPersonaSelect('s9-mgr'),
    run: async () => {
      const email = document.getElementById('s9-mgr').value;
      return api('POST', `/sales-orders/${state.cycle.salesOrderId}/transition`, { action: 'manager_approve' }, email);
    },
  },
  {
    title: '10. Submit Deposit',
    desc: 'Sales Rep submits the deposit evidence.',
    inputs: () => `<div class="row"><div><label>Amount</label><input id="s10-amt" value="750.00"/></div><div><label>Method</label><input id="s10-method" value="bank_transfer"/></div></div>`,
    run: async () => {
      const amount = document.getElementById('s10-amt').value;
      const method = document.getElementById('s10-method').value;
      const r = await api('POST', '/deposits', { salesOrderId: state.cycle.salesOrderId, amount, method }, state.cycle.salesRepEmail);
      if (r.ok) state.cycle.depositId = r.body.data.id;
      return r;
    },
  },
  {
    title: '11. Reserve Stock',
    desc: 'Sales Rep reserves stock for this order (concurrency-safe — advisory-locked per warehouse+product).',
    inputs: () => `<div class="row"><div><label>Quantity</label><input id="s11-qty" value="5"/></div></div>`,
    run: async () => {
      const quantity = Number(document.getElementById('s11-qty').value);
      const r = await api(
        'POST',
        '/inventory/reservations',
        { warehouseId: state.cycle.warehouseId, productId: state.cycle.productId, quantity, salesOrderId: state.cycle.salesOrderId },
        state.cycle.salesRepEmail,
      );
      if (r.ok) state.cycle.reservationId = r.body.data.id;
      return r;
    },
  },
  {
    title: '12. Admin Approves Deposit → Order Released',
    desc: 'Approving the deposit both releases the Sales Order (via its own state machine) and emits the finance-ready deposit.verified event.',
    run: async () => api('POST', `/deposits/${state.cycle.depositId}/approve`, {}),
  },
  {
    title: '13. Create Fulfillment Order',
    desc: 'Admin creates the fulfillment order + its first Pick Task (Process Engine, 2nd reuse). warehouseId and every line\'s reservation are derived server-side, not passed by the caller (multi-line fix).',
    run: async () => {
      const r = await api('POST', '/fulfillment/orders', { salesOrderId: state.cycle.salesOrderId });
      if (r.ok) state.cycle.pickTaskId = r.body.data.pickTask.id;
      return r;
    },
  },
  {
    title: '14. Walk the Pick Task (accept → start → complete → verify)',
    desc: 'A warehouse_worker persona walks all four transitions in one click. Verifying auto-creates the Pack Task.',
    inputs: () => `<div class="row"><div><label>Warehouse worker persona</label><select id="s14-worker"></select></div></div>`,
    beforeRender: () => fillPersonaSelect('s14-worker'),
    run: async () => {
      const email = document.getElementById('s14-worker').value;
      state.cycle.warehouseWorkerEmail = email;
      const actions = ['accept', 'start', 'complete', 'verify'];
      let last;
      for (const action of actions) {
        last = await api('POST', `/fulfillment/pick-tasks/${state.cycle.pickTaskId}/transition`, { action }, email);
        if (!last.ok) return last;
      }
      if (last.body.data.packTaskId) state.cycle.packTaskId = last.body.data.packTaskId;
      return last;
    },
  },
  {
    title: '15. Walk the Pack Task (accept → start → complete → verify)',
    desc: 'Verifying the pack task fulfills the reservation (real dispatch movement) and emits fulfillment.ready-for-dispatch.',
    run: async () => {
      const email = state.cycle.warehouseWorkerEmail;
      const actions = ['accept', 'start', 'complete', 'verify'];
      let last;
      for (const action of actions) {
        last = await api('POST', `/fulfillment/pack-tasks/${state.cycle.packTaskId}/transition`, { action }, email);
        if (!last.ok) return last;
      }
      return last;
    },
  },
  {
    title: '16. Create Shipment',
    desc: 'Admin creates the shipment (Numbering issues the waybill; Process Engine 3rd reuse starts at "created").',
    run: async () => {
      const r = await api('POST', '/shipments', { fulfillmentOrderId: state.cycle.pickTaskId ? state.cycle.fulfillmentOrderId || '' : '' });
      // fulfillmentOrderId wasn't captured explicitly above — fetch it from step 13's response if needed.
      return r;
    },
  },
  {
    title: '17. Assign Driver',
    desc: 'Admin assigns a driver persona to the shipment.',
    inputs: () => `<div class="row"><div><label>Driver persona</label><select id="s17-driver"></select></div></div>`,
    beforeRender: () => fillPersonaSelect('s17-driver'),
    run: async () => {
      const email = document.getElementById('s17-driver').value;
      state.cycle.driverEmail = email;
      const driverId = state.personas[email].id;
      return api('POST', `/shipments/${state.cycle.shipmentId}/assign-driver`, { driverUserId: driverId });
    },
  },
  {
    title: '18. Walk the Shipment (pickup → depart → arrive_for_delivery)',
    desc: 'The assigned driver walks the shipment out for delivery. The final "deliver" transition is NOT done here directly — it is driven by Delivery\'s own recordOutcome() in the next step, which is the real workflow boundary (Delivery owns the terminal state via Shipment\'s published contract).',
    run: async () => {
      const email = state.cycle.driverEmail;
      const actions = ['pickup', 'depart', 'arrive_for_delivery'];
      let last;
      for (const action of actions) {
        last = await api('POST', `/shipments/${state.cycle.shipmentId}/transition`, { action }, email);
        if (!last.ok) return last;
      }
      return last;
    },
  },
  {
    title: '19. Record Delivery Outcome + Collection',
    desc: 'Driver records the delivered outcome (drives Shipment via its published contract) and the cash collection.',
    run: async () => {
      const r1 = await api('POST', '/delivery/outcomes', { shipmentId: state.cycle.shipmentId, outcome: 'delivered' }, state.cycle.driverEmail);
      if (!r1.ok) return r1;
      return api('POST', '/delivery/collections', { shipmentId: state.cycle.shipmentId, amount: '750.00', method: 'cash' }, state.cycle.driverEmail);
    },
  },
];

function fillPersonaSelect(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const emails = Object.keys(state.personas);
  sel.innerHTML = emails.map((e) => `<option value="${e}">${e}</option>`).join('');
}

function renderCycle() {
  const container = document.getElementById('tab-cycle');
  container.innerHTML = steps
    .map(
      (step, i) => `
    <div class="step" id="step-${i}">
      <div class="head"><div><span class="n">${i + 1}</span><strong>${step.title.replace(/^\d+\.\s*/, '')}</strong></div>
        <button class="small" onclick="runStep(${i})">Run</button></div>
      <div class="desc">${step.desc}</div>
      <div id="step-inputs-${i}"></div>
      <pre class="result" id="step-result-${i}" style="display:none"></pre>
    </div>`,
    )
    .join('');
  steps.forEach((step, i) => {
    if (step.inputs) {
      document.getElementById(`step-inputs-${i}`).innerHTML = step.inputs();
    }
    if (step.beforeRender) step.beforeRender();
  });
}

async function runStep(i) {
  const step = steps[i];
  const out = document.getElementById(`step-result-${i}`);
  out.style.display = 'block';
  out.textContent = 'running…';
  out.className = 'result';
  try {
    const r = await step.run();
    out.textContent = fmt(r.body);
    out.className = 'result ' + (r.ok ? 'ok' : 'err');
    document.getElementById(`step-${i}`).classList.toggle('done', r.ok);
    // step 16 needs the fulfillment order id captured from step 13 - patch it in here
    if (i === 15 && r.ok) {
      // after creating shipment we don't get fulfillmentOrderId back explicitly; nothing to do, shipment already created against whatever was passed.
    }
  } catch (e) {
    out.textContent = 'Request failed: ' + e.message;
    out.className = 'result err';
  }
}

// step 13 (index 12) needs to remember fulfillmentOrderId for step 16 (index 15).
// MULTI-LINE FIX: Fulfillment now derives warehouseId + every line's
// reservation itself server-side (InventoryService.getActiveReservationsForOrder) —
// it no longer takes warehouseId/reservationId from the caller.
steps[12].run = async () => {
  const r = await api('POST', '/fulfillment/orders', {
    salesOrderId: state.cycle.salesOrderId,
  });
  if (r.ok) {
    state.cycle.pickTaskId = r.body.data.pickTask.id;
    state.cycle.fulfillmentOrderId = r.body.data.fulfillmentOrder.id;
  }
  return r;
};
steps[15].run = async () => {
  const r = await api('POST', '/shipments', { fulfillmentOrderId: state.cycle.fulfillmentOrderId });
  if (r.ok) state.cycle.shipmentId = r.body.data.id;
  return r;
};

// ---------- Init ----------

renderPersonas();
populateSelects();
renderCycle();
checkHealth();
setInterval(checkHealth, 15000);
