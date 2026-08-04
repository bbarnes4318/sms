'use strict';

const test = require('node:test');
const assert = require('node:assert');
const AreaCodes = require('../../public/lib/area_codes');

test('extractAreaCode extracts 3-digit code correctly', () => {
  assert.strictEqual(AreaCodes.extractAreaCode('2015550123'), '201');
  assert.strictEqual(AreaCodes.extractAreaCode('+12015550123'), '201');
  assert.strictEqual(AreaCodes.extractAreaCode('1-201-555-0123'), '201');
  assert.strictEqual(AreaCodes.extractAreaCode('(212) 555-0199'), '212');
  assert.strictEqual(AreaCodes.extractAreaCode(null), null);
});

test('getStateFromPhone maps phone to state abbreviation', () => {
  assert.strictEqual(AreaCodes.getStateFromPhone('+12015550123'), 'NJ');
  assert.strictEqual(AreaCodes.getStateFromPhone('212-555-0123'), 'NY');
  assert.strictEqual(AreaCodes.getStateFromPhone('202-555-0100'), 'DC');
  assert.strictEqual(AreaCodes.getStateFromPhone('000-000-0000'), null);
});
