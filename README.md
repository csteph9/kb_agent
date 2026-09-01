# Executive Summary

This system is a **personal, AI-native knowledge system** designed to
create durable memory across a person's work, projects, decisions,
research, relationships, travel, interests, and everyday life.

At its core, the system separates **knowledge** from the **AI used to
interact with it**.

The knowledge itself lives in ordinary Markdown files stored in a
private Git repository. There is no proprietary database, vector
database, or application-specific storage format. The repository can be
opened in VS Code, edited by hand, searched with standard tools, used by
Codex or other AI agents, backed up normally, and moved anywhere.

The AI acts as the interface to that knowledge.

Instead of simply storing notes, the agent can read across the
repository, find existing information before creating something new,
update prior knowledge when circumstances change, preserve useful
history, connect related information, answer questions from accumulated
context, and organize new information into the appropriate place.

> **The repository becomes durable memory while the AI becomes the
> interface to that memory.**

## How It Works

The system combines several simple, replaceable components:

-   **Markdown** provides the permanent, human-readable knowledge
    format.
-   **Git** provides version history, auditability, synchronization,
    conflict management, and recovery.
-   **GitHub** provides private remote storage and synchronization
    between devices.
-   **Codex** provides the reasoning layer that reads, interprets,
    organizes, and modifies the knowledge.
-   **Telegram** provides a convenient conversational interface from a
    phone or other device.
-   **A small Linux server** provides an always-on copy of the
    repository and runs the Telegram agent, synchronization services,
    and supporting tools.

A user can interact with the same knowledge in very different ways.

From a desktop, the repository can be opened directly in VS Code, Codex,
Vim, or another editor. From a phone, the same knowledge can be queried
and updated conversationally through Telegram. Changes made through
either interface ultimately become normal Git commits in the same
repository.

## More Than AI Note-Taking

This system is not designed merely to save conversations or accumulate
disconnected notes.

The agent is expected to maintain the repository as an evolving body of
knowledge.

It can distinguish between a new fact and an update to an existing fact,
search for related material before creating another file, incorporate
information from documents and images, preserve historical context when
something changes, and synthesize information spread across many
different notes.

Over time, this allows the repository to become a longitudinal record
rather than a collection of isolated AI conversations.

The AI can reason across information accumulated over months or years,
while the underlying source material remains directly inspectable and
editable by a human.

## Controlled AI Writes

The system treats AI access to durable knowledge as a controlled
transaction rather than giving an agent unrestricted access to a
directory.

Requests are classified as either **READ** or **WRITE** operations.

READ operations use the local knowledge repository without intentionally
modifying it.

WRITE operations synchronize the repository, allow Codex to make the
requested changes, commit those changes to Git, reconcile upstream
changes when necessary, and push the result back to the private remote
repository.

Shared locking prevents multiple processes from modifying the repository
simultaneously, while Git provides a complete history of what changed
and a straightforward recovery mechanism if a change is ever
undesirable.

This makes the AI powerful without making the underlying knowledge
opaque.

## Shared Knowledge, Individual Context

The same knowledge base can be used by multiple authorized people.

Each person can maintain an independent conversational session with the
AI while contributing to and querying the same durable repository. The
system supplies identity context to the agent so statements such as "my
trip," "my project," or "remember that I..." can be associated with the
person making the request.

Conversational context is temporary.

The Markdown repository is permanent.

This distinction prevents the long-term usefulness of the system from
depending on an indefinitely growing AI conversation.

## Portable by Design

One of the most important architectural principles is:

> **The intelligence is replaceable while the knowledge is not.**

Codex is the reasoning layer used by this implementation, but the
repository does not depend on Codex-specific storage.

A future version could use another hosted model, a local model, multiple
specialized agents, a different mobile interface, or tools that do not
yet exist. The accumulated knowledge would remain usable because its
canonical representation is still ordinary Markdown.

The same principle applies to Telegram. Telegram is a convenient
interface, not the storage layer. GitHub is a convenient synchronization
target, not a proprietary database.

Individual components can therefore evolve without requiring the
knowledge itself to be migrated into another platform.

## Why This Becomes Powerful Over Time

The value of the system increases as durable knowledge accumulates.

A normal AI conversation begins with limited context and eventually
disappears into conversation history. This system instead gives future
AI sessions access to information deliberately accumulated over time.

That creates the possibility of an AI that can understand ongoing
projects, recall previous decisions, connect current research to older
work, identify changes in plans, maintain context about people and
organizations, and synthesize information that no single conversation
ever contained.

The resulting repository is a private, longitudinal dataset of the
user's own knowledge and experiences---with human-readable source
material, version history, portability, and direct ownership.

The system is therefore better thought of not as an AI note-taking
application, but as a:

> **Persistent external memory for people, with AI acting as its
> librarian, researcher, editor, and conversational interface.**

The AI can change.

The interfaces can change.

The infrastructure can change.

**The knowledge remains.**

# Personal Knowledge Base (PKB)

A self-hosted, AI-native personal knowledge base built from **Markdown +
Git + Codex + Telegram**.

The Markdown repository is the durable memory. Codex is the agent that
reads, reasons over, organizes, and updates it. Telegram provides a
convenient mobile interface. GitHub provides synchronization, history,
backup, and a way to edit the same knowledge directly from VS Code,
Codex, or any text editor.

There is no proprietary knowledge database or vector store. The durable
asset is ordinary Markdown that you own.

``` text
                         GitHub
                    private KB repo
                          /   \
                         /     \
                desktop         Linux server
             VS Code/Codex   /home/knowledge/repo
                                  |
                    +-------------+-------------+
                    |             |             |
                 Telegram      Codex CLI    HTTP puller
                    |             |             |
                    +-------------+-------------+
                                  |
                           Markdown knowledge
```

## Hosting

Run the agent continuously on a small Linux VPS/VPC. A GPU is not
required because model inference is remote.

A practical starting point is 1--2 vCPU, 1--2 GB RAM, 10+ GB disk,
Debian 12+ or a current Ubuntu LTS, SSH administration, and outbound
Internet access.

DigitalOcean Droplets are a good fit. The same architecture should also
work on AWS EC2/Lightsail, Hetzner Cloud, Linode/Akamai Cloud, Vultr,
Google Compute Engine, Azure VMs, Oracle Cloud, or a Linux server you
operate yourself.

The PKB application does **not** need a public inbound HTTP endpoint.
Telegram uses long polling.

## Application layout

The application distribution contains:

``` text
.
├── .env-example
├── bot.js
├── gmail-auth.js
├── gmail-ingest.js
├── http-puller-service.js
├── http-puller.js
├── repo/
│   ├── AGENTS.md
│   └── followups.md
├── run-gmail-ingest.sh
├── run-codex.sh
├── sync-repo.sh
├── sync.sh
└── services/
    ├── knowledge-agent.service
    ├── knowledge-gmail-ingest.service
    ├── knowledge-gmail-ingest.timer
    ├── knowledge-http-puller.path
    ├── knowledge-http-puller.service
    ├── knowledge-sync.service
    └── knowledge-sync.timer
```

Install these application files under `/opt/knowledge-agent`.

The actual knowledge base is a **separate Git repository**, cloned to
`/home/knowledge/repo`.

------------------------------------------------------------------------

# 1. Prepare Linux

``` bash
sudo apt update
sudo apt upgrade -y

sudo apt install -y \
  git curl ca-certificates openssh-client \
  util-linux poppler-utils
```

`util-linux` supplies `flock`. `poppler-utils` supplies `pdftotext` for
PDF ingestion.

Verify:

``` bash
git --version
flock --version
pdftotext -v
```

Install a current Node.js release. Node.js 22 LTS is a suitable
baseline.

``` bash
node --version
npm --version
```

# 2. Create the service account

Do not run the agent as root.

``` bash
sudo useradd --create-home --shell /bin/bash knowledge
id knowledge
```

The service account's home should be `/home/knowledge`.

It owns the live KB checkout, Codex credentials, GitHub SSH key,
Telegram session state, and application runtime state.

# 3. Install the application

From the downloaded/cloned application repository:

``` bash
sudo mkdir -p /opt/knowledge-agent

sudo cp bot.js /opt/knowledge-agent/
sudo cp gmail-auth.js /opt/knowledge-agent/
sudo cp gmail-ingest.js /opt/knowledge-agent/
sudo cp http-puller.js /opt/knowledge-agent/
sudo cp http-puller-service.js /opt/knowledge-agent/
sudo cp run-codex.sh /opt/knowledge-agent/
sudo cp run-gmail-ingest.sh /opt/knowledge-agent/
sudo cp sync-repo.sh /opt/knowledge-agent/
sudo cp sync.sh /opt/knowledge-agent/
sudo cp .env-example /opt/knowledge-agent/
sudo cp -r repo /opt/knowledge-agent/
sudo cp -r services /opt/knowledge-agent/
```

Set permissions:

``` bash
sudo chmod 755 \
  /opt/knowledge-agent/gmail-auth.js \
  /opt/knowledge-agent/gmail-ingest.js \
  /opt/knowledge-agent/http-puller.js \
  /opt/knowledge-agent/http-puller-service.js \
  /opt/knowledge-agent/run-codex.sh \
  /opt/knowledge-agent/run-gmail-ingest.sh \
  /opt/knowledge-agent/sync-repo.sh \
  /opt/knowledge-agent/sync.sh

sudo mkdir -p /opt/knowledge-agent/sessions
sudo mkdir -p /opt/knowledge-agent/gmail
sudo chown -R knowledge:knowledge /opt/knowledge-agent
sudo chmod 700 /opt/knowledge-agent/sessions
sudo chmod 700 /opt/knowledge-agent/gmail
```

# 4. Install Node dependencies

``` bash
cd /opt/knowledge-agent
sudo -u knowledge -H npm init -y
sudo -u knowledge -H npm install grammy dotenv googleapis
```

Ensure `package.json` contains:

``` json
{
  "type": "module"
}
```

Keep the dependency entries generated by npm.

Syntax-check the JavaScript:

``` bash
sudo -u knowledge -H node --check /opt/knowledge-agent/bot.js
sudo -u knowledge -H node --check /opt/knowledge-agent/gmail-auth.js
sudo -u knowledge -H node --check /opt/knowledge-agent/gmail-ingest.js
sudo -u knowledge -H node --check /opt/knowledge-agent/http-puller.js
sudo -u knowledge -H node --check /opt/knowledge-agent/http-puller-service.js
```

No output from `node --check` means the syntax passed.

# 5. Create the knowledge repository

Create a new **private GitHub repository** for the knowledge itself.
This is separate from the repository containing the PKB application.

For the cleanest bootstrap, create it **empty**: do not initialize it
with a GitHub-generated README, `.gitignore`, or license. The server
will populate it after GitHub access is configured.

The application ships with:

``` text
/opt/knowledge-agent/repo/AGENTS.md
```

This is the recommended baseline operating policy for the knowledge
agent. It defines the behaviors this PKB architecture expects: search
before creating new knowledge, prefer updates over duplicates, preserve
useful history, handle corrections carefully, avoid deletion unless
explicitly requested, and keep durable knowledge in human-readable
Markdown.

`AGENTS.md` is intended to be customized over time, but starting with
the supplied version is strongly recommended.

The initial KB will ultimately look approximately like:

``` text
AGENTS.md
followups.md
inbox/
daily/
people/
companies/
projects/
meetings/
research/
decisions/
travel/
archive/
```

The next step gives the server write access to the empty repository,
clones it, installs the supplied `AGENTS.md`, creates the initial
directory structure, and pushes the first commit.

# 6. Configure GitHub access from the server

The server needs read/write access because Telegram WRITE requests
create and push commits.

Create a dedicated deploy key as `knowledge`:

``` bash
sudo -u knowledge -H ssh-keygen \
  -t ed25519 \
  -f /home/knowledge/.ssh/id_ed25519
```

For unattended operation, leave the passphrase empty.

Display the public key:

``` bash
sudo cat /home/knowledge/.ssh/id_ed25519.pub
```

In the **knowledge repository** on GitHub:

``` text
Settings → Deploy keys → Add deploy key
```

Paste the public key and select **Allow write access**.

Test:

``` bash
sudo -u knowledge -H ssh -T git@github.com
```

On first connection, verify GitHub's published SSH host fingerprint
before accepting it.

Clone the KB:

``` bash
sudo -u knowledge -H git clone \
  git@github.com:YOUR_GITHUB_USER/YOUR_KB_REPO.git \
  /home/knowledge/repo
```

Configure the automated commit identity:

``` bash
sudo -u knowledge -H git -C /home/knowledge/repo \
  config user.name "Knowledge Agent"

sudo -u knowledge -H git -C /home/knowledge/repo \
  config user.email "knowledge-agent@localhost"
```

Verify:

``` bash
sudo -u knowledge -H git -C /home/knowledge/repo status
sudo -u knowledge -H git -C /home/knowledge/repo remote -v
```

Seed the cloned repository with the supplied agent policy:

``` bash
sudo -u knowledge -H cp \
  /opt/knowledge-agent/repo/AGENTS.md \
  /home/knowledge/repo/AGENTS.md

sudo -u knowledge -H cp \
  /opt/knowledge-agent/repo/followups.md \
  /home/knowledge/repo/followups.md
```

Create the standard knowledge directories:

``` bash
sudo -u knowledge -H mkdir -p \
  /home/knowledge/repo/{inbox,daily,people,companies,projects,meetings,research,decisions,travel,archive}
```

Because Git does not track empty directories, add placeholders:

``` bash
sudo -u knowledge -H bash -c '
for d in inbox daily people companies projects meetings research decisions travel archive; do
  touch "/home/knowledge/repo/$d/.gitkeep"
done
'
```

Create and push the initial KB commit:

``` bash
sudo -u knowledge -H git -C /home/knowledge/repo add -A

sudo -u knowledge -H git -C /home/knowledge/repo \
  commit -m "Initialize personal knowledge base"

sudo -u knowledge -H git -C /home/knowledge/repo push -u origin HEAD
```

Verify:

``` bash
sudo -u knowledge -H git -C /home/knowledge/repo status
sudo -u knowledge -H git -C /home/knowledge/repo remote -v
```

At this point GitHub should contain the supplied `AGENTS.md` and the
starter `followups.md` file and KB directory structure.

The supplied synchronization scripts expect a configured branch. If your
KB uses a different default branch, update the branch setting in the
scripts before continuing.

# 7. Install and authenticate Codex

Install Codex CLI:

``` bash
sudo npm install -g @openai/codex
codex --version
```

Authentication must happen as the **`knowledge` user**, because that is
the account systemd uses.

``` bash
sudo -u knowledge -H bash
codex --login
```

Follow the displayed sign-in flow. Codex supports signing in with a
ChatGPT account; availability and usage limits depend on the
account/workspace.

Test from the KB:

``` bash
cd /home/knowledge/repo
codex
```

Ask something harmless such as:

``` text
Summarize the purpose of this repository without modifying it.
```

Then exit Codex and the `knowledge` shell.

Do not authenticate only as root or your normal SSH user. The
credentials must be available to `/home/knowledge`.

# 8. Create the Telegram bot

In Telegram, open the official **@BotFather** account.

Send:

``` text
/newbot
```

Choose a display name and unique bot username. Telegram bot usernames
normally end in `bot`.

BotFather will return an authentication token. **Treat this token as a
password.** Anyone with it can control the bot. Never commit it to Git.

BotFather can also configure the profile picture, description, and other
bot metadata.

# 9. Configure the environment

Create the live environment file:

``` bash
sudo cp /opt/knowledge-agent/.env-example /opt/knowledge-agent/.env
sudo -u knowledge -H vim /opt/knowledge-agent/.env
```

Telegram configuration uses:

``` text
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_USER_NAMES=123456789:YourName
REMINDER_TIME=08:00
REMINDER_FILE=reminders.md
REMINDER_WEATHER_LOCATION=San Francisco, CA
REMINDER_NEWS_FEEDS=https://feeds.bbci.co.uk/news/rss.xml,https://feeds.npr.org/1001/rss.xml,https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml
GMAIL_ENABLED=false
GMAIL_STATE_DIR=/opt/knowledge-agent/gmail
GMAIL_QUERY=newer_than:14d -category:promotions -category:social
GMAIL_MAX_MESSAGES_PER_RUN=10
GMAIL_MAX_EMAIL_CHARS=20000
```

For multiple people:

``` text
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
TELEGRAM_USER_NAMES=123456789:Alice,987654321:Bob
```

`TELEGRAM_ALLOWED_USER_IDS` is the authorization boundary.
`TELEGRAM_USER_NAMES` gives Codex human identity context so first-person
statements can be attributed correctly.

`REMINDER_TIME` enables the daily reminder check. Use `HH:MM` in the
server's local 24-hour time, for example `08:00`. Set it to `off` to
disable scheduled reminders.

`REMINDER_FILE` tells the scheduled reminder check which Markdown file
to read in the knowledge repository. The default is `reminders.md`.
At the configured time, the agent asks Codex to read that file and send
a brief personalized wake-up/check-in message to every configured
`TELEGRAM_ALLOWED_USER_IDS` user. The message includes daily weather
when a location is available and the top five current news items from
the configured public RSS feeds.

`REMINDER_WEATHER_LOCATION` can be set to a city/state location such as
`San Francisco, CA`. If it is blank, the scheduled check may infer a
city/state location from the knowledge base for the recipient. It should
not use or expose more precise location details.

`REMINDER_NEWS_FEEDS` is a comma-separated list of public RSS feed URLs.
The default uses BBC, NPR, and The New York Times headline feeds.

If reminders are due, the message also includes a reminder list.
Date-specific reminders are included 7 days before, 2 days before, and
on the day of the reminder. Recurring or continual reminders are
included whenever currently active. If no reminders match those rules,
the agent sends the check-in, weather if available, and news only.

`GMAIL_ENABLED` controls the optional Gmail ingestion worker. Leave it
`false` until Gmail OAuth has been configured. `GMAIL_STATE_DIR` stores
OAuth credentials, tokens, and processed-message state outside Git.
`GMAIL_QUERY` is the Gmail search query used to select candidate
messages. `GMAIL_MAX_MESSAGES_PER_RUN` limits work per timer run.
`GMAIL_MAX_EMAIL_CHARS` limits how much text from any one email is
provided to Codex.

Protect the file:

``` bash
sudo chown knowledge:knowledge /opt/knowledge-agent/.env
sudo chmod 600 /opt/knowledge-agent/.env
```

If you do not know your Telegram numeric user ID, start the bot with the
service below and send `/start`. An unauthorized `/start` is allowed to
reveal the sender's numeric ID without granting KB access. Add that ID
to `.env` and restart the service.

# 10. Install the systemd units

Copy the supplied units:

``` bash
sudo cp /opt/knowledge-agent/services/*.service /etc/systemd/system/
sudo cp /opt/knowledge-agent/services/*.timer /etc/systemd/system/
sudo cp /opt/knowledge-agent/services/*.path /etc/systemd/system/

sudo systemctl daemon-reload
```

## `knowledge-agent.service`

Runs `bot.js` as the `knowledge` account and keeps the Telegram
long-polling agent alive.

``` bash
sudo systemctl enable --now knowledge-agent.service
```

## `knowledge-sync.service`

A one-shot Git synchronization job. It runs the synchronization wrapper
and exits.

It is normal for this unit to display `inactive (dead)` after a
successful run.

Manual test:

``` bash
sudo systemctl start knowledge-sync.service
```

## `knowledge-sync.timer`

Periodically launches `knowledge-sync.service`, keeping the server
checkout reconciled with GitHub even when Telegram is idle.

``` bash
sudo systemctl enable --now knowledge-sync.timer
```

## `knowledge-http-puller.path`

Watches the HTTP bridge request queue. When Codex's client helper
submits a request, this path unit triggers the worker service.

``` bash
sudo systemctl enable --now knowledge-http-puller.path
```

## `knowledge-http-puller.service`

Runs `http-puller-service.js`, the network-capable side of the
controlled HTTP bridge.

It is triggered on demand by `knowledge-http-puller.path`; it does not
need to remain running continuously.

## `knowledge-gmail-ingest.service`

Runs one Gmail ingestion pass. It reads candidate messages through the
Gmail API, filters obvious non-KB material and known financial senders,
asks Codex to extract durable knowledge, and commits/pushes any Markdown
updates.

Manual test after Gmail OAuth is configured:

``` bash
sudo systemctl start knowledge-gmail-ingest.service
```

## `knowledge-gmail-ingest.timer`

Periodically launches `knowledge-gmail-ingest.service`.

Leave this disabled until Gmail OAuth is configured and
`GMAIL_ENABLED=true` has been set in `/opt/knowledge-agent/.env`.

``` bash
sudo systemctl enable --now knowledge-gmail-ingest.timer
```

# 11. Verify systemd

``` bash
sudo systemctl daemon-reload

sudo systemctl enable --now knowledge-agent.service
sudo systemctl enable --now knowledge-sync.timer
sudo systemctl enable --now knowledge-http-puller.path
# Optional, after Gmail OAuth setup:
# sudo systemctl enable --now knowledge-gmail-ingest.timer
```

Inspect:

``` bash
sudo systemctl status knowledge-agent.service --no-pager -l
sudo systemctl status knowledge-sync.timer --no-pager -l
sudo systemctl status knowledge-http-puller.path --no-pager -l
# Optional:
# sudo systemctl status knowledge-gmail-ingest.timer --no-pager -l

systemctl list-timers --all | grep knowledge
```

Logs:

``` bash
sudo journalctl -u knowledge-agent.service -f
```

``` bash
sudo journalctl -u knowledge-sync.service -n 100 --no-pager
```

``` bash
sudo journalctl -u knowledge-http-puller.service -n 100 --no-pager
```

``` bash
sudo journalctl -u knowledge-gmail-ingest.service -n 100 --no-pager
```

# 12. Test Telegram

Open the bot and send:

``` text
/start
/status
```

Supported commands:

``` text
/start   Check that the agent is online
/status  Show your conversation session status
/new     Start a new conversation session
/sync    Force immediate GitHub synchronization
/help    Show available commands
```

Test a READ:

``` text
What information is currently in my knowledge base?
```

Then an explicit WRITE:

``` text
Remember that my test project is called Project Orion.
```

Check Git:

``` bash
sudo -u knowledge -H \
  git -C /home/knowledge/repo log --oneline -10
```

Ask:

``` text
What is my test project called?
```

Then remove the test:

``` text
Remove the Project Orion test information from my knowledge base.
```

## Optional Gmail ingestion

Gmail ingestion is optional and disabled by default. It uses the Gmail
API with the read-only scope:

``` text
https://www.googleapis.com/auth/gmail.readonly
```

Create a Google Cloud project, enable the Gmail API, configure the OAuth
consent screen, and create an OAuth client. For a personal server, a
Desktop app OAuth client is the simplest starting point.

Copy the downloaded OAuth client JSON to:

``` text
/opt/knowledge-agent/gmail/credentials.json
```

Protect it:

``` bash
sudo chown -R knowledge:knowledge /opt/knowledge-agent/gmail
sudo chmod 700 /opt/knowledge-agent/gmail
sudo chmod 600 /opt/knowledge-agent/gmail/credentials.json
```

Authorize Gmail as the service account:

``` bash
sudo -u knowledge -H node /opt/knowledge-agent/gmail-auth.js
```

Open the displayed URL, approve access, paste the authorization code
back into the terminal, and verify that the token was created:

``` bash
sudo ls -l /opt/knowledge-agent/gmail/token.json
```

Enable Gmail ingestion in `/opt/knowledge-agent/.env`:

``` text
GMAIL_ENABLED=true
GMAIL_STATE_DIR=/opt/knowledge-agent/gmail
GMAIL_QUERY=newer_than:14d -category:promotions -category:social
GMAIL_MAX_MESSAGES_PER_RUN=10
GMAIL_MAX_EMAIL_CHARS=20000
```

Run one manual ingestion pass:

``` bash
sudo systemctl start knowledge-gmail-ingest.service
sudo journalctl -u knowledge-gmail-ingest.service -n 100 --no-pager
```

If that succeeds, enable the timer:

``` bash
sudo systemctl enable --now knowledge-gmail-ingest.timer
```

The ingestion worker stores processed Gmail message IDs in:

``` text
/opt/knowledge-agent/gmail/state.json
```

It does not intentionally store raw emails. It asks Codex to extract
durable knowledge such as appointments, deadlines, future-dated
reminders, people, contact updates, decisions, project updates,
policy/provider details, travel plans, and warranties.

Messages from likely financial senders are skipped before Codex sees the
body. This includes common banks, credit-card issuers, brokerages,
payment processors, lenders, and tax/payment platforms.

# 13. Multi-user operation

Multiple people can share one durable KB while maintaining separate
Codex conversational contexts.

Have the new user open the bot and press **Start**. Before
authorization, the bot returns their numeric Telegram user ID but does
not expose the KB.

Add the ID/name to `.env`, then:

``` bash
sudo systemctl restart knowledge-agent.service
```

Per-user conversation state is stored under:

``` text
/opt/knowledge-agent/sessions/
```

The sessions are operational state, not durable knowledge and not part
of Git. The Markdown KB remains shared.

# 14. READ vs. WRITE behavior

READ:

``` text
Telegram
   ↓
intent classifier
   ↓
READ
   ↓
shared repository lock
   ↓
Codex reads local Markdown
   ↓
answer
```

A READ does not intentionally change the repository. The wrapper checks
for unexpected modifications and discards them.

WRITE:

``` text
Telegram
   ↓
intent classifier
   ↓
WRITE
   ↓
shared repository lock
   ↓
GitHub pre-sync / rebase
   ↓
Codex edits Markdown
   ↓
git add + commit
   ↓
GitHub post-sync / rebase
   ↓
push
   ↓
answer
```

Repository operations share:

``` text
/tmp/knowledge-repo.lock
```

This prevents concurrent processes from modifying the checkout.

# 15. Git conflict handling

The KB can be edited from both Telegram and desktop tools.

The synchronization layer therefore reconciles Git history rather than
blindly overwriting one side. Markdown conflicts can be handed to Codex
for semantic resolution: preserve compatible information and chronology,
treat genuine corrections/newer facts appropriately, and avoid merely
concatenating conflicting text.

Non-Markdown conflicts are handled conservatively and should be resolved
manually.

Git history remains the recovery mechanism.

# 16. Desktop workflow

Clone the same KB onto any trusted workstation:

``` bash
git clone git@github.com:YOUR_GITHUB_USER/YOUR_KB_REPO.git
```

Use VS Code, Codex, Vim, or any other Markdown editor.

Typical workflow:

``` bash
git pull --rebase
# edit files
git add -A
git commit -m "Update knowledge"
git push
```

The server's periodic synchronization picks up those changes.

Telegram is therefore an interface to the KB, not the KB itself.

# 17. Attachments

The Telegram agent supports images, PDFs, and many text-based documents.

Images are supplied to Codex as image input.

PDFs are converted using:

``` bash
pdftotext -layout
```

Supported text-oriented formats include:

``` text
.txt .md .markdown .xml .json .jsonl .csv .tsv
.html .htm .yaml .yml .log .ics .vcf .ini .conf
.config .properties .env .sql .js .mjs .cjs .ts
.tsx .jsx .css .scss .py .rb .php .java .c .h
.cpp .hpp .cs .go .rs .sh .bash .zsh .ps1
```

Source attachments are temporary input. Useful information is
incorporated into Markdown; the original attachment is not intended to
become permanent repository content.

# 18. HTTP puller

Codex's execution sandbox may restrict outbound network access. The HTTP
bridge allows controlled public-resource retrieval without granting
Codex unrestricted network execution.

``` text
Codex
  ↓
http-puller.js
  ↓ request file
filesystem bridge
  ↓
knowledge-http-puller.path
  ↓
knowledge-http-puller.service
  ↓
http-puller-service.js
  ↓
Internet
  ↓ response file
http-puller.js
  ↓
Codex
```

Both JavaScript files are required:

-   `http-puller.js` is the Codex-facing client/helper.
-   `http-puller-service.js` is the out-of-sandbox network worker.

Keep the worker's destination-validation protections intact. The bridge
should reject unsafe destinations such as localhost/private-network
addresses and is not intended to bypass authentication, CAPTCHAs,
paywalls, or access controls.

# 19. Security

This application can read and modify personal knowledge. Treat it as
security-sensitive infrastructure.

-   Keep the KB repository private unless you intentionally want it
    public.
-   Never commit `.env`, Telegram tokens, Codex credentials, or SSH
    private keys.
-   Run the application as `knowledge`, not root.
-   Keep `/opt/knowledge-agent/.env` at mode `600`.
-   Restrict `/opt/knowledge-agent/sessions` to the service account.
-   Patch the Linux host.
-   Limit SSH access.
-   Expose no unnecessary ports.
-   Treat `TELEGRAM_ALLOWED_USER_IDS` as the bot authorization boundary.
-   Treat the Telegram token like a password and regenerate it through
    BotFather if compromised.
-   Treat the GitHub deploy-key private key as a KB write credential.
-   Preserve Codex sandboxing and the shared-lock architecture.
-   Do not use the PKB as a password manager; avoid passwords, API keys,
    recovery codes, private keys, card numbers, and similar secrets.

Telegram is part of the communications path. Bot conversations are not
Telegram Secret Chats. Decide accordingly what information is
appropriate to send through Telegram.

# 20. Backup and recovery

GitHub provides remote version history, but an important long-term KB
should have another trusted backup.

The durable asset is:

``` text
/home/knowledge/repo
```

A replacement server can be built from scratch and this repository
cloned again.

Telegram session files and other runtime state are disposable. The
Markdown + Git repository is the permanent memory.

# 21. Updating the application

When installing a newer application version:

1.  Preserve `/opt/knowledge-agent/.env`.
2.  Preserve `/opt/knowledge-agent/sessions`.
3.  Stop affected services.
4.  Replace application scripts.
5.  Replace systemd units if they changed.
6.  Run `systemctl daemon-reload`.
7.  Syntax-check JavaScript.
8.  Restart services.
9.  Review the journal.

Example:

``` bash
sudo systemctl stop knowledge-agent.service

sudo -u knowledge -H \
  node --check /opt/knowledge-agent/bot.js

sudo -u knowledge -H \
  node --check /opt/knowledge-agent/gmail-auth.js

sudo -u knowledge -H \
  node --check /opt/knowledge-agent/gmail-ingest.js

sudo systemctl daemon-reload
sudo systemctl restart knowledge-agent.service

sudo systemctl status \
  knowledge-agent.service \
  --no-pager -l
```

Do **not** overwrite `/home/knowledge/repo` while updating the
application.

# 22. Troubleshooting

### Bot does not respond

``` bash
sudo systemctl status knowledge-agent.service --no-pager -l
sudo journalctl -u knowledge-agent.service -n 100 --no-pager
```

Check `.env`, the bot token, and authorized Telegram IDs.

### Codex works over SSH but not through Telegram

Test it as the service account:

``` bash
sudo -u knowledge -H codex --version
```

If necessary, authenticate with `codex --login` as `knowledge`.

### Git sync fails

``` bash
sudo -u knowledge -H git -C /home/knowledge/repo status
sudo -u knowledge -H git -C /home/knowledge/repo fetch origin
```

Verify the GitHub deploy key has write access.

### Repository is unexpectedly dirty

``` bash
sudo -u knowledge -H git -C /home/knowledge/repo status
```

The transaction scripts intentionally stop when repository state is
unsafe or unexpected.

### Sync appears stuck

``` bash
sudo lsof /tmp/knowledge-repo.lock
sudo journalctl -u knowledge-sync.service -n 100 --no-pager
```

### HTTP puller fails

``` bash
sudo systemctl status knowledge-http-puller.path --no-pager -l
sudo journalctl -u knowledge-http-puller.service -n 100 --no-pager
```

Remember: `http-puller.js` is the client; `http-puller-service.js` is
the worker. Both are required.

### Gmail ingestion fails

``` bash
sudo systemctl status knowledge-gmail-ingest.service --no-pager -l
sudo journalctl -u knowledge-gmail-ingest.service -n 100 --no-pager
sudo -u knowledge -H ls -l /opt/knowledge-agent/gmail
sudo -u knowledge -H git -C /home/knowledge/repo status
```

Check that `GMAIL_ENABLED=true`, `credentials.json`, and `token.json`
exist under `/opt/knowledge-agent/gmail`, and that the KB repository is
clean before the ingestion run starts.

# 23. Final checklist

A healthy installation has:

-   `knowledge-agent.service` active.
-   `knowledge-sync.timer` active and scheduled.
-   `knowledge-http-puller.path` active.
-   `/home/knowledge/repo` owned by `knowledge` and normally clean.
-   GitHub fetch **and push** working as `knowledge`.
-   Codex installed and authenticated as `knowledge`.
-   `/opt/knowledge-agent/.env` owned by `knowledge` and mode `600`.
-   Telegram `/start`, `/status`, `/new`, `/sync`, and `/help` working.
-   READ requests producing no Git commits.
-   WRITE requests producing appropriate Markdown commits.
-   Agent commits reaching GitHub.
-   Desktop Git changes synchronizing back to the server.
-   Separate Telegram session files for separate authorized users.
-   HTTP puller able to retrieve an allowed public URL.
-   Optional Gmail ingestion has `knowledge-gmail-ingest.timer` active,
    valid OAuth files under `/opt/knowledge-agent/gmail`, and a clean
    processed-message state file.
-   No secrets committed to either repository.

------------------------------------------------------------------------

## Philosophy

The important part of this system is not Telegram, Codex, GitHub, or any
particular AI model.

**The durable asset is the knowledge.**

Keeping that knowledge in ordinary Markdown and Git makes the
intelligence layer replaceable. Codex can operate it today; another
model, local agent, or future tool can operate the same repository
tomorrow.

The result is less like an AI notes application and more like a
**persistent external memory**: human-readable, versioned, portable,
privately owned, and increasingly useful as durable knowledge
accumulates.
