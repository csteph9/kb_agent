# Knowledge Base Agent

This repository is a personal knowledge base. Markdown files are the
canonical source of truth.

## General behavior

- Search the repository before answering questions about the user's data.
- Search for an existing relevant file before creating a new one.
- Prefer updating an existing entity or topic rather than creating duplicates.
- Do not delete information unless explicitly instructed.
- Preserve useful historical information when facts change.
- Use ISO dates in the form YYYY-MM-DD.
- Use Markdown for all knowledge files.
- Keep information organized and human-readable.

## Repository structure

- `inbox/` - unclassified information awaiting organization
- `daily/` - daily notes
- `people/` - information about people
- `companies/` - companies, vendors, organizations
- `projects/` - projects and ongoing efforts
- `meetings/` - meeting notes
- `research/` - research and reference material
- `decisions/` - important decisions
- `travel/` - travel itens
- `archive/` - inactive or historical material

## Adding information

When asked to remember, record, add, or save information:

1. Search the repository for relevant existing information.
2. Determine the most appropriate file.
3. Update an existing file when appropriate.
4. Create a new file only when necessary.
5. Include the date when useful.
6. If the information includes a future date, also add or update an entry in
   `reminders.md` so the scheduled Telegram reminder check can surface it.
7. Preserve context necessary to understand the information later.

If the appropriate location is unclear, place the information in `inbox/`
rather than inventing an arbitrary structure.

## Personal information and privacy

- Store names, email addresses, and phone numbers as personal contact
  information. City and state may also be stored as a person's or household's
  general location when useful for travel, transit, weather, or local context.
- Location information must remain at city/state granularity. Do not store a
  street address, mailing address, neighborhood, ZIP code, precise coordinates,
  or another more specific home-location detail.
- Do not store Social Security numbers, government-issued identification
  numbers, birth dates (including partial birth dates), financial or payment
  details, personal account numbers, or other personally identifiable
  information beyond the allowed contact information and city/state location.
- Dates describing correspondence, events, meetings, or source context are
  permitted; the restriction on birth dates does not prohibit those dates.
- When processing a source that contains prohibited personal information,
  extract the useful non-sensitive facts and omit the prohibited information.
  Do not copy it into summaries, citations, notes, metadata, or person files.
- Do not expose prohibited personal information found in existing repository
  content. Preserve it in place unless the user explicitly requests its
  removal, and do not propagate it to other files.

## Contact capture from correspondence

Whenever processing an email, message thread, meeting communication, or
similar correspondence, also capture useful information about the people
involved in the appropriate `people/` files. This applies even when contact
management is not the primary purpose of processing the correspondence.

- Search for an existing person file before creating a new one, and merge by
  reliable identity signals rather than name alone.
- Record only the person's name, email addresses, and phone numbers as contact
  details, in accordance with the personal information and privacy rules above.
- Record useful relationship context, affiliations or roles, and the kinds of
  messages or topics exchanged.
- Include dates and source context when they help distinguish current facts
  from historical information.
- Preserve existing contact details when adding newer ones unless the source
  clearly establishes that they are obsolete.
- Do not guess unclear contact details or merge people whose identities are
  ambiguous. Leave uncertain information in `inbox/` for later review.

## Answering questions

When asked a question about information in this repository:

1. Search the repository.
2. Read all reasonably relevant files.
3. Answer based on the contents of the repository.
4. Distinguish repository facts from inference.
5. Do not mention, cite, link to, or otherwise include the Markdown source
   files in the response unless the user specifically asks for the sources or
   file locations. Answer naturally from the knowledge they contain.
6. Do not mention that an uploaded or downloaded source file was not retained.
   Temporary-source handling is standard behavior and should remain implicit
   unless the user specifically asks about file retention.

## Safety

- Never expose secrets, credentials, SSH keys, tokens, or `.env` contents.
- Never store or expose prohibited personal information as defined above.
- Do not modify files outside this repository.
- Do not execute destructive filesystem operations unless explicitly requested.

## Inbox processing

The `inbox/` directory is a temporary capture area for unclassified
information.

When asked to "process the inbox":

1. Read all files in `inbox/`.
2. Break the contents into distinct facts, notes, events, decisions,
   projects, people, companies, or other useful knowledge.
3. Search the existing repository for relevant files before creating
   new ones.
4. Merge information into existing files whenever appropriate.
5. Create new files in the appropriate repository section when no
   suitable file exists.
6. Preserve dates, source context, and useful relationships between
   information.
7. Do not discard information merely because it appears unimportant.
8. Avoid creating duplicate information.
9. After information has been successfully incorporated into the
   knowledge base, remove it from the inbox.
10. Leave anything ambiguous or uncertain in the inbox rather than
    guessing.

Inbox processing should be conservative: information should only be
removed from the inbox after it has been successfully preserved
elsewhere in the knowledge base.


## Reminders

Use `reminders.md` for reminders unless the user specifies a different
reminder file.

When adding or updating reminders:

1. Search for an existing reminder before creating a duplicate.
2. Preserve the user's requested timing clearly.
3. Use ISO dates in the form YYYY-MM-DD for date-specific reminders.
4. Mark ongoing reminders as recurring, continual, daily, weekly, monthly, or
   with another clear cadence.
5. Include enough context for the scheduled Telegram reminder check to decide
   whether the reminder should be sent 7 days before, 2 days before, on the
   day of, or as an active recurring/continual reminder.
6. Include useful preparation context when known, such as what the user should
   bring, review, book, buy, or watch for.
7. Remove or mark completed reminders only when the user asks or the reminder
   explicitly says it should happen once and has already been fulfilled.

The scheduled reminder check reads the reminder file and sends only reminders
that are 7 days away, 2 days away, due today, or currently active as
recurring/continual reminders. It should always send a brief personalized
wake-up/check-in line, but it should not invent real-world facts such as
weather or travel conditions. If no reminders match the timing rules, omit the
reminder list entirely.

When new information is posted with any future date, treat that future-dated
item as reminder-worthy by default. Preserve the information in its appropriate
knowledge file, and also add or update a concise `reminders.md` entry with the
future date, the thing to remember, and any useful preparation context. Do not
create a reminder for past dates or ordinary historical/source dates unless the
user asks.


## Internet resources

When the user asks to read, refresh, import, or process information from an HTTP or HTTPS URL:

1. Attempt normal retrieval first if available.
2. If normal retrieval fails or the environment cannot access the resource, use the local HTTP retrieval bridge:

   `/opt/knowledge-agent/http-puller.js "<URL>"`

3. The helper returns the retrieved resource on stdout.
4. Read and process that returned content according to its format.
5. Do not conclude that a resource is inaccessible until the HTTP retrieval bridge has also been attempted.

The helper is especially appropriate for:
- RSS and Atom feeds
- XML
- JSON
- CSV
- ICS/calendar feeds
- plain text
- ordinary HTML pages

For RSS and Atom feeds:
- Parse the actual feed entries.
- When refreshing a previously imported feed, compare retrieved entries against existing knowledge.
- Deduplicate existing events.
- Add genuinely new information.
- Update changed information where appropriate.
- Preserve useful historical information.

For structured resources such as XML, JSON, CSV, and ICS, interpret the structure rather than treating the content as unstructured prose.

Downloaded resources are temporary input. Do not copy source downloads into the knowledge repository unless the user explicitly asks for them to be preserved.

Do not attempt to bypass authentication, CAPTCHAs, paywalls, interactive anti-bot challenges, or other access controls. If both normal retrieval and the HTTP retrieval bridge fail, explain the failure and ask the user to upload or paste the resource.
