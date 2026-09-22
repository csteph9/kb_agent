const writePatterns = [
  /^(?:please\s+)?remember(?:\s+(?:that|this|my|the)\b|\s*:)/,
  /^(?:please\s+)?(?:record|save|store|note down)\b/,
  /^(?:please\s+)?(?:add|update|change|correct|delete|remove|forget|edit|modify|organize|move|rename)\b/,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:record|save|store|add|update|change|correct|delete|remove|forget|edit|modify|organize|move|rename)\b/,
  /^(?:please\s+)?remind\b/,
  /^(?:please\s+)?set (?:a|an) reminder\b/,
  /^(?:please\s+)?process (?:my|the) inbox\b/,
];

const readPatterns = [
  /^(?:what|who|when|where|why|how|which|whose|is|are|am|was|were|do|does|did|can|could|would|should|will|have|has|had)\b/,
  /^(?:please\s+)?(?:answer|summarize|explain|tell|show|list|find|search|look up|compare|describe|review|check)\b/,
];

// Return null when wording is ambiguous so the model classifier remains the
// conservative fallback. Attachments without instructions retain WRITE-by-default.
export function classifyIntentLocally(userText, hasAttachment = false) {
  const text = String(userText || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return hasAttachment ? 'WRITE' : 'READ';
  if (/^(?:do not|don't|dont|never)\b/.test(text)) return null;
  if (writePatterns.some(pattern => pattern.test(text))) return 'WRITE';
  if (text.endsWith('?') || readPatterns.some(pattern => pattern.test(text))) return 'READ';
  return null;
}
