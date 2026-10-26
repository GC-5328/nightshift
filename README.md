# NightShift — an AI phone agent for trades businesses

NightShift is an AI-powered phone agent that helps trades businesses (HVAC, solar and electrical companies) capture leads after hours and streamlines decision-making for managers. Lucy, the AI receptionist, answers calls with the business's own call flow, checks the technician schedule to offer a tentative visit time, and logs every call. The manager gets an overview, a report per night shift with a suggested technician plan, and an action list. Nothing reaches the office until the manager pushes it.

Calls are simulated in the browser (microphone or keyboard, or AI-played test customers); there is no real phone line yet.

Author: Yichen Xu · Model: `gpt-6-luna` via Portkey

---

## Run it (about 5 minutes)

You need **Python 3.9 or newer** and a **Portkey API key**.

### 1. Get the code

```bash
git clone https://github.com/GC-5328/nightshift.git
cd nightshift
```

### 2. Add your API key

Create a file named `.env` containing:

```
PORTKEY_API_KEY=your_key_here
```

The app looks for `.env` **in this folder first, then in the folder above it**. If you already keep a `.env` with `PORTKEY_API_KEY` one level up, for example `submissions/.env` next to `submissions/nightshift/`, you don't need to do anything. `.env.example` shows the format. `OPENAI_API_KEY` also works if `PORTKEY_API_KEY` is not set.

### 3. Create a virtual environment and install

macOS / Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows (PowerShell):

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 4. Start the app

```bash
python app.py
```

Open **http://127.0.0.1:5050** in Chrome, Edge or Safari. The microphone needs one of these; typing works in any browser.

On first start the app creates its local database in `runtime/`. It loads a technician schedule anchored to today and a recorded "last night" of real test calls, so every page has data immediately.

---

## A 2-minute tour

1. **Test** (blue button, top right). Click **Start test calls**. Simulated customers ring in, with a brand-new person and situation every time and 3 lines at once. Or open **Call it yourself** and talk to Lucy by microphone or keyboard.
2. **Live**. Every call on the line right now. Click one to listen in: the transcript streams and is read aloud.
3. **Overview**. What happened overnight (or since the shift ended, under **Current**): calls, visits accepted, emergencies, follow-ups, cost. Turn Lucy on or off, change the office line, choose when the manager gets texted. **Action items**: review visits and alerts, change or remove them, push them to the office.
4. **Report**. One report per night shift (or a Current report any time): a suggested technician for every job, with reasons, checked against the schedule. Suggestions only.
5. **Calls**. Every call's summary, notes, transcript, step-by-step agent trace and cost. **Analysis** shows charts and cost by agent.
6. **Schedule**. Day, week and month calendar of technician jobs and the tentative visits held during calls.
7. **Agent**. The drag-and-drop **Conversation map** (it can also import a Retell AI agent export), **Agent settings** (voice, personality, routing, alerts, cost limit), **Knowledge base** (upload only for now) and **Model** (display only).

To start over with clean demo data: **Agent → Agent settings → Reset demo data**.

---

## How it works

* **Receptionist ("Lucy")**: one structured model answer per caller turn (notes, next step, optional window to hold, action, words to say). It has one tool, `check_availability`, which reads the schedule. It writes the call log after hang-up.
* **Dispatcher**: after each call, suggests a technician and texts the manager by priority; these are rules only, with no tokens. On request, it plans a night shift's jobs, and code re-checks every pick against the schedule.
* **Guards in code**:
  * Safety words (gas, CO, sparks) force the emergency path.
  * The agent can only move along the arrows of the call flow, and can only hold windows the schedule returned.
  * Manipulation attempts are flagged, and the call ends after 3.
  * Private information is redacted from replies.
  * A per-call cost cap applies.
  * If the model fails, the agent takes a plain message.
* Every model request is logged with tokens, cost, latency and cache status (see **Calls → Analysis**).

```
app.py                 Flask routes
nightshift/            receptionist.py (agent 1) · call_log.py · dispatch.py (agent 2) · safety.py
                       schedule.py · metrics.py · actions.py · simulator.py · caller_gen.py · llm.py · db.py
data/                  business, technicians, call flow, note fields, scenarios, schedule template, sample night
static/                front end (plain HTML/CSS/JS, no build step)
scripts/run_scenarios.py   scored end-to-end test suite (simulated callers)
tests/                 offline unit tests for the guards (no API key needed)
eval/results/          measured results used in the report
```

## Tests

```bash
python -m unittest discover tests -v                    # offline, free
python scripts/run_scenarios.py --fresh --tag mytest    # 9 scripted calls end to end (~$0.02 of tokens)
```

`run_scenarios.py` resets the local demo data when `--fresh` is passed. To keep your demo data, run it against a separate folder:

```bash
NIGHTSHIFT_RUNTIME=eval/rt_test python scripts/run_scenarios.py --fresh
```
