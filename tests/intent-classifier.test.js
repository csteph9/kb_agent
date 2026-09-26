import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntentLocally, isCalendarActionLocally } from '../intent-classifier.js';

test('classifies high-confidence reads locally', () => {
  for (const text of [
    'What time is practice?',
    'Summarize what you know about the project',
    'Tell me about Alex',
    'Is the appointment tomorrow?',
  ]) assert.equal(classifyIntentLocally(text), 'READ', text);
});

test('classifies explicit writes locally', () => {
  for (const text of [
    'Remember that practice moved to Friday',
    'Please save this in my notes',
    'Can you update the appointment to Tuesday?',
    'Delete the old reminder',
    'Remind me to call tomorrow',
    'Remind Alice to call tomorrow',
    'Set a reminder for my wife next Friday',
    'Schedule a dentist appointment next Tuesday',
    'Reschedule the team meeting to 3 PM',
    'Cancel the calendar event tomorrow',
    'Process my inbox',
  ]) assert.equal(classifyIntentLocally(text), 'WRITE', text);
});

test('falls back for ambiguous wording and handles empty attachments safely', () => {
  assert.equal(classifyIntentLocally('Practice moved to Friday'), null);
  assert.equal(classifyIntentLocally("Don't save this; explain it"), null);
  assert.equal(classifyIntentLocally('', false), 'READ');
  assert.equal(classifyIntentLocally('', true), 'WRITE');
});

test('enables calendar tools only for explicit calendar mutations', () => {
  for (const text of [
    'Schedule dinner next Friday at 6',
    'Put the dentist appointment on my calendar',
    'Move tomorrow\'s meeting to 3 PM',
    'Cancel the calendar event tomorrow',
  ]) assert.equal(isCalendarActionLocally(text), true, text);
  for (const text of [
    'What is on my calendar tomorrow?',
    'Tell me about the meeting',
    'Remember that dinner is next Friday',
  ]) assert.equal(isCalendarActionLocally(text), false, text);
});
