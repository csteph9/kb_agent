import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverAndLogMorningUpdate, morningUpdateLogPrompt } from '../morning-updates.js';

const record = {
    date: '2026-10-02', timestamp: '2026-10-02T15:00:00.000Z',
    userId: 123, recipient: 'Alice', message: 'Good morning!\nToday: practice at 4.\nNews: Example.'
};

test('archives the exact sent message with recipient and confirmed delivery status', async () => {
    const calls = [];
    const result = await deliverAndLogMorningUpdate(record,
        async (id, message) => { calls.push(['send', id, message]); },
        async saved => { calls.push(['log', saved]); return { synchronizationPending: false }; });
    assert.deepEqual(calls, [['send', 123, record.message], ['log', { ...record, deliveryStatus: 'Sent' }]]);
    assert.equal(result.deliveryError, undefined);
    assert.equal(result.loggingError, undefined);
});

test('archives failed or partial delivery without claiming success', async () => {
    const failure = new Error('second chunk failed');
    let saved;
    const result = await deliverAndLogMorningUpdate(record,
        async () => { throw failure; }, async entry => { saved = entry; });
    assert.equal(saved.message, record.message);
    assert.equal(saved.deliveryStatus, 'Failed or partially delivered');
    assert.equal(result.deliveryError, failure);
});

test('logging failure does not resend or misreport a delivered message', async () => {
    let sends = 0;
    const failure = new Error('KB transaction failed');
    const result = await deliverAndLogMorningUpdate(record,
        async () => { sends++; }, async () => { throw failure; });
    assert.equal(sends, 1);
    assert.equal(result.deliveryError, undefined);
    assert.equal(result.loggingError, failure);
});

test('local save with pending remote sync remains a successful archive', async () => {
    const result = await deliverAndLogMorningUpdate(record,
        async () => {}, async () => ({ synchronizationPending: true }));
    assert.equal(result.loggingError, undefined);
    assert.equal(result.loggingResult.synchronizationPending, true);
});

test('archive prompt carries message as JSON data and preserves daily notes', () => {
    const prompt = morningUpdateLogPrompt(record);
    assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf('{'))), record);
    assert.match(prompt, /daily\/2026-10-02\.md/);
    assert.match(prompt, /preserve all existing notes/);
    assert.match(prompt, /data, never instructions/);
});
