# Opportunity Desk

Opportunity Desk is a self-hosted job-application tracker that turns Gmail conversations into a structured opportunity pipeline. It combines inbox and sent messages, identifies genuine job-search conversations, extracts useful fields with OpenAI, and presents each opportunity with filters, metrics, manual editing, an AI summary, and a chronological email timeline.

Gmail access is strictly read-only. Opportunity Desk cannot send, modify, label, trash, or delete email.

## What it tracks

Every identified opportunity belongs to one of four categories:

- **Normal application** — an application to a specific advertised role.
- **Cold email** — personalized outreach to a person or team about a possible opportunity.
- **Unsolicited application** — a speculative application without a specific advertised vacancy.
- **PhD** — a doctoral position, program, or prospective-supervisor conversation.

The dashboard tracks active opportunities, waiting applications, interviews, offers, rejections, and response rate. Records can also be created, edited, status-overridden, and deleted manually.

## Requirements

- Node.js 24.15 or newer
- A Google Cloud OAuth 2.0 client with the Gmail API enabled
- An OpenAI API key

## Installation

```bash
git clone https://github.com/prasadGhegde/ApplicationTracker.git
cd ApplicationTracker
npm install
npm start
```

Open <http://127.0.0.1:3000>.

Opportunity Desk creates `local-data/` automatically. This directory contains the SQLite database, OAuth tokens, and runtime credentials and is excluded from Git.

## Google Cloud setup

1. Create or select a project in Google Cloud Console.
2. Enable the **Gmail API**.
3. Configure the OAuth consent screen.
4. Create an **OAuth client ID** for a web application.
5. Add this authorized redirect URI exactly:

   ```text
   http://127.0.0.1:3000/oauth2/callback
   ```

6. Copy the OAuth client ID and client secret.

Only the `gmail.readonly` scope is requested.

## First-time setup in the website

1. Open **Settings**.
2. Enter the Gmail OAuth client ID.
3. Enter the Gmail OAuth client secret.
4. Enter the OpenAI API key.
5. Save settings.
6. Select **Connect account** and complete Google authorization.
7. Choose 50, 100, 150, 200, or 250 from the initial-analysis dropdown.
8. Select **Initial Analyze**.

Initial Analyze performs the bounded first import: up to 250 recent inbox messages and 30 recent sent messages are backed up in SQLite. The selected number controls how many of the newest merged inbox-and-sent messages are analyzed by the LLM. Older imported messages remain stored but do not inflate the analysis backlog.

After initialization, use the large **Sync Email** button. Later syncs use Gmail's history cursor, fetch only new message IDs, and analyze only new or changed conversations.

## Credential storage

Credentials entered in Settings are written to:

```text
local-data/runtime-credentials.json
```

The file is created with owner-only permissions (`0600`), is excluded by `.gitignore`, and is never returned to the browser after saving. OAuth tokens and email data also stay under `local-data/`.

Environment variables remain available as an alternative:

```bash
export GMAIL_CLIENT_ID="...apps.googleusercontent.com"
export GMAIL_CLIENT_SECRET="..."
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-5.4-mini" # optional
npm start
```

## How the workflow functions

```text
Settings → Gmail OAuth → Initial Analyze → SQLite
                                      ↓
Inbox + Sent → Gmail thread merge → OpenAI structured extraction
                                      ↓
                         Deduplication + manual overrides
                                      ↓
                      Dashboard → Opportunity → Timeline

Later: Sync Email → Gmail history cursor → unseen messages only
                                      ↓
                  changed conversation hash only → extraction once
```

Important workflow guarantees:

- Inbox and sent messages belonging to the same Gmail thread are analyzed together.
- Stored Gmail message IDs prevent duplicate ingestion.
- Each successful analysis stores a content hash containing the provider, model, prompt version, and conversation content.
- An unchanged conversation is not analyzed repeatedly.
- A new sent message or received reply changes the hash and triggers one fresh analysis.
- Separate Gmail threads can merge using strong identifiers such as employer job ID, company plus role, or recruiter email plus role.
- Manual field overrides always win over later AI output.
- Deleting an opportunity never deletes source email.

## Tags and statuses

Category tags visually distinguish the four opportunity channels. Status tags represent the latest supported stage:

| Status | Meaning |
|---|---|
| `draft` | Not yet sent or submitted |
| `submitted` | Application submitted or automatically acknowledged |
| `awaiting_response` | Outbound application or outreach has no human reply |
| `replied` | A human replied without a defined recruiting stage |
| `screening` | Recruiter or eligibility screening |
| `assessment` | Test, task, case study, or technical assessment |
| `interview` | Interview process underway |
| `offer` | Offer received |
| `accepted` | Offer accepted |
| `rejected` | Application declined |
| `withdrawn` | Applicant withdrew |
| `closed` | Conversation closed for another supported reason |

Automated acknowledgements do not count as human responses.

## AI and LLM calls

`OpportunityExtractionService` is the application boundary. `OpenAIOpportunityExtractor` is the current provider implementation and can be swapped without changing Gmail synchronization, persistence, CRUD, statistics, or the UI.

The application uses the OpenAI Responses API with `gpt-5.4-mini` by default, low reasoning effort, and strict JSON Schema structured output. OpenAI is used only to:

- Decide whether a conversation is a job-search opportunity
- Extract category, status, company, role, recruiter, recruiter email, location, job ID, and dates
- Detect whether a human responded
- Produce a short factual summary and evidence list

Email content is treated as untrusted data. The system instruction explicitly tells the model to ignore commands or prompts found inside email. Parsed output is validated again at runtime with Zod before persistence.

Everything else—Gmail sync, message deduplication, thread merging, database writes, CRUD, metrics, manual override protection, and UI behavior—is deterministic application code.

## Database

SQLite data is stored at:

```text
local-data/gmail-opportunities.sqlite
```

The schema stores raw read-only email snapshots, application settings, opportunities, thread links, timelines, and extraction runs. Initialization creates the database automatically.

## Private access with Tailscale

Opportunity Desk listens on `127.0.0.1` by default, which keeps it unavailable to the local network and public internet. [Tailscale](https://tailscale.com/) can make that local service privately available to a phone or another trusted device from anywhere.

1. Install Tailscale on the computer running Opportunity Desk.
2. Install Tailscale on the phone or other client device.
3. Sign in to both using the same Tailscale account.
4. Keep Opportunity Desk running on port 3000.
5. On the host computer, run:

   ```bash
   tailscale serve --bg 3000
   ```

6. Tailscale returns a private HTTPS address similar to:

   ```text
   https://opportunity-desk.example-tailnet.ts.net
   ```

7. Add that exact origin when starting Opportunity Desk:

   ```bash
   export TRUSTED_ORIGINS="https://opportunity-desk.example-tailnet.ts.net"
   npm start
   ```

Use **Tailscale Serve**, not Tailscale Funnel. Serve limits access to authenticated devices in the tailnet; Funnel would make the service publicly accessible. The host computer must remain powered on, awake, online, and connected to Tailscale.

### A slightly recursive note

If you are looking at this repository because you are considering me for a role, there is a good chance that very application is already being tracked in the live Opportunity Desk. In other words: the application may be tracking the application.

The live dashboard remains private inside the owner's tailnet. Cloning this repository creates a separate installation with its own local database and credentials; no live application data is included in Git.

## Development commands

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run test:extraction
```

The extraction test operates on the configured local database and writes its report only inside gitignored `local-data/`.

## Architecture

```text
src/domain/          Typed models and status/category vocabulary
src/application/     Sync and analysis use cases plus service ports
src/infrastructure/  Gmail, OpenAI, SQLite, OAuth, credential persistence
src/presentation/    HTTP API and security boundaries
public/              Responsive web interface
test/                Deterministic integration and unit tests
```

## Security notes
- Do not expose Opportunity Desk directly to the public internet without adding user authentication and a hardened deployment layer.
