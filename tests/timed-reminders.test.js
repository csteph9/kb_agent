import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRelativeReminder, saveTimedReminder, deliverDueReminders } from '../timed-reminders.js';

test('relative reminder survives a scheduler restart and is delivered when due', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timed-reminder-test-'));
  try {
    const reminder = parseRelativeReminder('remind me in 10 minutes to check the water');
    assert.deepEqual(reminder, { minutes: 10, message: 'check the water' });
    await saveTimedReminder(directory, 'telegram-123', 571577792, reminder, 1000);
    const sent = [];
    const send = async (...args) => sent.push(args);
    await deliverDueReminders(directory, send, 600999);
    assert.deepEqual(sent, []);
    await deliverDueReminders(directory, send, 601000);
    assert.deepEqual(sent, [[571577792, 'Reminder: check the water']]);
    await deliverDueReminders(directory, send, 601001);
    assert.equal(sent.length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('duplicate Telegram update does not move due time; failed delivery is retried', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timed-reminder-test-'));
  try {
    const reminder = parseRelativeReminder('Remind me in 1 hour to call home.');
    await saveTimedReminder(directory, 'telegram-123', 42, reminder, 1000);
    await saveTimedReminder(directory, 'telegram-123', 42, reminder, 2000);
    const failures = [];
    await deliverDueReminders(directory, async () => { throw new Error('offline'); }, 3601000,
      error => failures.push(error.message));
    assert.deepEqual(failures, ['offline']);
    const sent = [];
    await deliverDueReminders(directory, async (...args) => sent.push(args), 3601000);
    assert.deepEqual(sent, [[42, 'Reminder: call home']]);
    assert.equal(parseRelativeReminder('remind me tomorrow to call home'), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
