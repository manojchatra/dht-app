// tests/helpers/fixtures.js — shared request bodies/helpers for route tests.
'use strict';
const request = require('supertest');

/** Logs in against the seeded default user and returns a cookie-carrying agent. */
function loginAgent(app, { username = 'sales', password = 'sales123' } = {}) {
  const agent = request.agent(app);
  return agent.post('/auth/login').send({ username, password }).then(() => agent);
}

/** Minimal valid create-contract payload; override fields per test via deep-ish merge. */
function contractFormData(overrides = {}) {
  const base = {
    store: 'Phoenix',
    date: '2026-09-20',
    deliveryDate: '2026-10-05',
    salesman: 'Michael Ioli',
    customer: {
      name: 'Jane Test',
      email: 'jane.test@example.com',
      zip: '85001',
      phone: { cell: '602-555-0100' },
      address: '123 Test St',
      city: 'Phoenix',
      state: 'AZ',
    },
    product: {
      status: 'instock',
      serialNumber: 'ZZTEST-SERIAL-100',
      make: 'TestMake',
      model: 'TestModel',
      year: '2026',
      shellColor: 'Grey',
      cabinetColor: 'Espresso',
    },
    payment: {
      cheque: { selected: true, number: '1001', amount: '5000' },
    },
    costing: { grandTotal: '5000' },
    details: {},
  };
  return { ...base, ...overrides };
}

/** Creates a contract via the API and returns the parsed response body ({ contractId, contractNumber, ... }). */
async function createContract(agent, formDataOverrides = {}) {
  const formData = contractFormData(formDataOverrides);
  const res = await agent.post('/api/contracts').send({ data: JSON.stringify(formData) });
  if (!res.body.success) throw new Error('createContract fixture failed: ' + JSON.stringify(res.body));
  return res.body;
}

module.exports = { loginAgent, contractFormData, createContract };
