import ICAL from 'ical.js';
import { hash } from './state.js';
import { assertWritableCalendar, createGoogleCalendarClient, idempotentEventId } from '../connectors/google-calendar/google.js';

export function sameCalendarStart(actual, desired) {
  if (desired.date) return actual?.date === desired.date;
  if (!actual?.dateTime || !desired.dateTime) return false;
  const offset = value => /(Z|[+-]\d{2}:\d{2})$/.test(value);
  if (offset(desired.dateTime)) return Date.parse(actual.dateTime) === Date.parse(desired.dateTime);
  if (!offset(actual.dateTime)) return actual.dateTime === desired.dateTime && actual.timeZone === desired.timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: desired.timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(actual.dateTime));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === desired.dateTime;
}

// Conversion is deliberately deterministic. Unsupported recurrence needs review,
// rather than silently flattening a series or guessing dates.
export function calendarEvent(item, rule) {
  const data = item.content?.structured;
  if (item._extractedCalendarEvent) {
    if (data?.cancelled === true) return null;
    if (!data?.googleEvent?.start || !data.googleEvent.end) throw new Error('Missing extracted event time');
    return data.googleEvent;
  }
  if (!Array.isArray(data?.event)) throw new Error('Event requires structured ICS');
  const component = new ICAL.Component(data.event);
  if (component.getFirstPropertyValue('status')?.toUpperCase() === 'CANCELLED') return null;
  if (['rrule', 'rdate', 'exdate', 'recurrence-id'].some(p => component.hasProperty(p))) {
    throw new Error('Recurring event requires review');
  }
  const event = new ICAL.Event(component);
  const convert = (value, property) => {
    if (!value) throw new Error('Missing event time');
    if (value.isDate) return { date: value.toString() };
    const tz = component.getFirstProperty(property)?.getParameter('tzid') || component.getFirstProperty('dtstart')?.getParameter('tzid') || rule.timeZone;
    if (value.zone?.tzid === 'UTC') return { dateTime: value.toString() };
    if (!tz) throw new Error('Floating event requires timeZone');
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new Error('Unsupported event timeZone'); }
    return { dateTime: value.toString(), timeZone: tz };
  };
  if (!component.hasProperty('dtstart') || (!component.hasProperty('dtend') && !component.hasProperty('duration') && !event.startDate.isDate)) {
    throw new Error('Event requires start and end');
  }
  if (event.endDate.compare(event.startDate) <= 0) throw new Error('Invalid event date range');
  if (!(event.summary || item.title)?.trim()) throw new Error('Event requires title');
  return { summary: event.summary || item.title || '', description: event.description || '', location: event.location || '',
    start: convert(event.startDate, 'dtstart'), end: convert(event.endDate, 'dtend') };
}

export async function reconcileCalendars(configured, state, { connect = createGoogleCalendarClient, now = Date.now } = {}) {
  let ok = true;
  const rows = state.db.prepare("SELECT * FROM calendar_deliveries WHERE (status IN ('pending','retry') AND next_attempt<=?) OR (status='synced' AND verified_at<?) ORDER BY CASE status WHEN 'synced' THEN 1 ELSE 0 END,rowid LIMIT 100").all(now(), now() - 86400000);
  for (const row of rows) {
    const source = configured.find(s => s.id === row.source);
    const target = configured.find(s => s.id === row.target);
    const rule = source?.calendarSync;
    if (!source?.enabled || !rule?.enabled || rule.targetSourceId !== row.target || rule.calendarId !== row.calendar) continue;
    let connection;
    const key = [row.source, row.external_id, row.target, row.calendar];
    try {
      if (!target?.enabled || target.connector !== 'google-calendar') throw new Error('Calendar target unavailable');
      assertWritableCalendar(target, row.calendar);
      const desired = calendarEvent(JSON.parse(row.payload), rule);
      connection = await connect(target);
      const api = connection.api;
      const eventId = row.event_id || idempotentEventId(row.target, row.calendar, hash(JSON.stringify([row.source, row.external_id])));
      const args = { calendarId: row.calendar, eventId };
      let current;
      try { current = (await api.events.get(args, { timeout: 30000 })).data; }
      catch (error) { if (![404, 410].includes(Number(error.code))) throw error; }
      const ownership = hash(JSON.stringify(key));
      const owned = current?.extendedProperties?.private?.knowledgeSync === ownership;
      if (current && current.status !== 'cancelled' && !owned) throw new Error('Calendar ownership conflict');
      let result;
      if (!desired) {
        if (current && current.status !== 'cancelled') {
          if (!target.config.allowDelete) throw new Error('Calendar deletion disabled');
          if (!current.etag) throw new Error('Missing calendar ETag');
          await api.events.delete({ ...args, sendUpdates: 'none' }, { timeout: 30000, headers: { 'If-Match': current.etag } });
        }
      } else {
        const body = { ...desired, extendedProperties: { private: { knowledgeSync: ownership } } };
        if (!current) {
          const matches = (await api.events.list({ calendarId: row.calendar, q: desired.summary, maxResults: 100,
            timeMin: new Date(Date.parse((desired.start.date || desired.start.dateTime).slice(0, 10) + 'T00:00:00Z') - 86400000).toISOString(),
            timeMax: new Date(Date.parse((desired.start.date || desired.start.dateTime).slice(0, 10) + 'T00:00:00Z') + 2 * 86400000).toISOString(),
            singleEvents: true }, { timeout: 30000 })).data;
          if (matches.nextPageToken || matches.items?.some(e => e.status !== 'cancelled' && e.summary === desired.summary && sameCalendarStart(e.start, desired.start))) {
            throw new Error('Potential existing calendar duplicate requires review');
          }
          result = (await api.events.insert({ calendarId: row.calendar, sendUpdates: 'none', requestBody: { ...body, id: eventId } }, { timeout: 30000 })).data;
        } else {
          if (current.status === 'cancelled') throw new Error('Deleted destination event requires review');
          if (!current.etag) throw new Error('Missing calendar ETag');
          result = (await api.events.patch({ ...args, sendUpdates: 'none', requestBody: body }, { timeout: 30000, headers: { 'If-Match': current.etag } })).data;
        }
        if (result?.id !== eventId || result.status === 'cancelled') throw new Error('Calendar did not confirm event');
      }
      state.db.prepare("UPDATE calendar_deliveries SET status='synced',attempts=0,next_attempt=0,event_id=?,etag=?,error=NULL,verified_at=? WHERE source=? AND external_id=? AND target=? AND calendar=?")
        .run(eventId, result?.etag || null, now(), ...key);
      console.log(JSON.stringify({ component: 'calendar-sync', source: row.source, eventId, status: 'synced', action: desired ? 'upsert' : 'cancel' }));
    } catch (error) {
      ok = false;
      const attempts = row.attempts + 1;
      state.db.prepare("UPDATE calendar_deliveries SET status=?,attempts=?,next_attempt=?,error=? WHERE source=? AND external_id=? AND target=? AND calendar=?")
        .run(attempts >= 5 ? 'failed' : 'retry', attempts, now() + Math.min(86400000, 60000 * 2 ** attempts),
          ['Recurring event requires review', 'Floating event requires timeZone', 'Potential existing calendar duplicate requires review', 'Calendar ownership conflict', 'Deleted destination event requires review'].includes(error.message)
            ? error.message : 'Calendar delivery failed; check rule, event structure, credentials and destination permissions.', ...key);
      console.error(JSON.stringify({ component: 'calendar-sync', source: row.source, status: attempts >= 5 ? 'failed' : 'retry', attempts }));
    } finally { try { await connection?.flush(); } catch { ok = false; } }
  }
  return ok;
}
