import fs from 'node:fs/promises';
import path from 'node:path';

export function parseRelativeReminder(text) {
  const match = /^remind me in (\d{1,4}) (minutes?|hours?) to (.+?)\s*[.!]?$/i.exec(text.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const minutes = amount * (match[2].toLowerCase().startsWith('hour') ? 60 : 1);
  if (minutes < 1 || minutes > 7 * 24 * 60) return null;
  const message = match[3].trim();
  if (!message || message.length > 1000) return null;
  return { minutes, message };
}

export async function saveTimedReminder(directory, id, userId, reminder, now = Date.now()) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid reminder ID');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${id}.json`);
  const job = { userId, message: reminder.message, dueAt: now + reminder.minutes * 60000 };
  try {
    await fs.writeFile(file, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return file;
}

export async function deliverDueReminders(directory, send, now = Date.now(), onError = () => {}) {
  let files;
  try { files = await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const job = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(job.dueAt) || job.dueAt > now) continue;
      if (!Number.isSafeInteger(job.userId) || typeof job.message !== 'string') continue;
      await send(job.userId, `Reminder: ${job.message}`);
      await fs.unlink(file);
    } catch (error) {
      onError(error, name);
    }
  }
}
