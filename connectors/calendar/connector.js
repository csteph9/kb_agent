import ICAL from 'ical.js';
import { fetchResource } from '../../ingest/http.js';
import { hash } from '../../ingest/state.js';
export function parseCalendar(ics) {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  if (calendar.name !== 'vcalendar') throw new Error('Expected VCALENDAR');
  const timezones = calendar.getAllSubcomponents('vtimezone').map(c => c.toJSON());
  return calendar.getAllSubcomponents('vevent').map(component => {
    const value = name => component.getFirstPropertyValue(name)?.toString() || '';
    const uid = value('uid');
    if (!uid) throw new Error('Calendar event lacks UID');
    const item = {
      externalId: uid + (value('recurrence-id') ? '/' + value('recurrence-id') : ''),
      kind: 'event', title: value('summary'), occurredAt: value('dtstart'), updatedAt: value('last-modified'),
      content: {
        text: value('description'),
        // Preserve TZID, all-day values, RRULE, EXDATE, overrides and cancellation status.
        // Do not guess UTC for floating times or expand infinite recurrence rules.
        structured: { event: component.toJSON(), timezones }
      }
    };
    return { ...item, revision: hash(JSON.stringify(item)) };
  });
}
export async function createConnector(source) {
  if (typeof source.config.url !== 'string') throw new Error('Calendar requires config.url');
  let items;
  async function load() { return items ||= parseCalendar((await fetchResource(source.config.url)).body.toString('utf8')); }
  return {
    async check() { await load(); },
    async fetchPage({ limit, has }) {
      const fresh = (await load()).filter(i => !has(i.externalId, i.revision));
      return { items: fresh.slice(0, limit), cursor: fresh.length > limit ? 'more' : null };
    }
  };
}