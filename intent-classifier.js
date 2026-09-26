const writePatterns = [
  /^(?:please\s+)?remember(?:\s+(?:that|this|my|the)\b|\s*:)/,
  /^(?:please\s+)?(?:record|save|store|note down)\b/,
  /^(?:please\s+)?(?:add|update|change|correct|delete|remove|forget|edit|modify|organize|move|rename)\b/,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:record|save|store|add|update|change|correct|delete|remove|forget|edit|modify|organize|move|rename)\b/,
  /^(?:please\s+)?remind\b/,
  /^(?:please\s+)?set (?:a|an) reminder\b/,
  /^(?:please\s+)?(?:schedule|reschedule|cancel)\b/,
  /^(?:please\s+)?(?:create|add|update|move|change|delete|remove)\b.{0,80}\b(?:calendar|event|appointment|meeting)\b/,
  /^(?:please\s+)?(?:sync|import|copy|mirror|publish|post|push|write|populate|enrich)\b.{0,160}\b(?:gcal|google calendar|calendars?|events?|appointments?|meetings?)\b/,
  /^(?:please\s+)?process (?:my|the) inbox\b/,
];

const readPatterns = [
  /^(?:what|who|when|where|why|how|which|whose|is|are|am|was|were|do|does|did|can|could|would|should|will|have|has|had)\b/,
  /^(?:please\s+)?(?:answer|summarize|explain|tell|show|list|find|search|look up|compare|describe|review|check)\b/,
];

const calendarActionPatterns = [
  /^(?:please\s+)?(?:schedule|reschedule|cancel)\b/,
  /\b(?:add|create|put|schedule|reschedule|move|update|change|cancel|delete|remove|sync|import|copy|mirror|publish|post|push|write|populate|enrich)\b.{0,160}\b(?:gcal|google calendar|calendars?|events?|appointments?|meetings?)\b/,
  /\b(?:gcal|google calendar|calendars?|events?|appointments?|meetings?)\b.{0,160}\b(?:add|create|schedule|reschedule|move|update|change|cancel|delete|remove|sync|import|copy|mirror|publish|post|push|write|populate|enrich)\b/,
];

const calendarFollowupPatterns = [
  /\b(?:gcal|google calendar|calendars?)\b/,
  /^(?:yes|confirmed|confirm|do it|go ahead|proceed)(?:\b|[.!])/,
  /\b(?:also|instead|actually|make sure)\b.{0,160}\b(?:add|include|post|push|put|write|populate|enrich|update|change|remove|delete|details?|location|description|reservation|flight|hotel|rental)\b/,
];

export function isCalendarActionLocally(userText) {
  const text = String(userText || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return calendarActionPatterns.some(pattern => pattern.test(text));
}

export function isCalendarFollowupLocally(userText) {
  const text = String(userText || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return isCalendarActionLocally(text) ||
    calendarFollowupPatterns.some(pattern => pattern.test(text));
}

// Return null when wording is ambiguous so the model classifier remains the
// conservative fallback. Attachments without instructions retain WRITE-by-default.
export function classifyIntentLocally(userText, hasAttachment = false) {
  const text = String(userText || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return hasAttachment ? 'WRITE' : 'READ';
  if (/^(?:do not|don't|dont|never)\b/.test(text)) return null;
  if (!text.endsWith('?') && calendarActionPatterns.some(pattern => pattern.test(text))) {
    return 'WRITE';
  }
  if (writePatterns.some(pattern => pattern.test(text))) return 'WRITE';
  if (text.endsWith('?') || readPatterns.some(pattern => pattern.test(text))) return 'READ';
  return null;
}
