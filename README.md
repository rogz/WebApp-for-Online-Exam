# WebApp for Online Exam

A free online exam system that needs **no database and no paid server**:

- **Google Sheets** holds the question bank, exams, and results.
- **Google Apps Script** (attached to the Sheet) checks answers and records results.
- **GitHub Pages** hosts the student exam page for free.
- You share the exam link in **Google Classroom**.

## Features

| | |
|---|---|
| Question types | Multiple choice, True/False, Fill in the blank, Short essay |
| Question bank | Teachers pick questions in an **Exam Builder** window inside Google Sheets |
| Rules screen | Before starting, students are told that switching tabs voids the exam and that a second monitor must be disconnected. They must tick "I agree". |
| System check | **Start** stays disabled while a second monitor is connected |
| Anti-cheating | Switching tabs, minimizing, Alt+Tab, leaving or reloading the page, or plugging in a monitor mid-exam **voids the exam immediately**. A pop-up tells the student to inform their instructor. |
| Time | Per-exam **time window** (opens/closes) and **time limit** (auto-submits when time is up) |
| Retakes | The instructor can let a voided (or finished) student take the exam again |
| Grading | MC, T/F and fill-in-the-blank are graded automatically. Essays are graded by the teacher in the sheet, then **Recalculate scores** updates the totals. |
| Security | Answer keys never reach the student's browser. Times and windows are checked by the server. |

---

## Setup (about 15 minutes, one time)

### 1. Create the Google Sheet and script
1. Go to [sheets.new](https://sheets.new) and name the spreadsheet, e.g. **Online Exam**.
2. Set your time zone: **File → Settings → Time zone**. All exam times use it.
3. Open **Extensions → Apps Script**.
4. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
5. Click **+ → HTML**, name the file **`Builder`**, and paste [`apps-script/Builder.html`](apps-script/Builder.html).
6. Click **Save**, then go back to the Sheet and reload it. An **Exam Admin** menu appears.
7. Click **Exam Admin → Set up sheets (run once)**. Google asks for permission; click *Advanced → Go to project* if you see the "unverified app" warning (it's your own script).
   The script creates all the sheets, plus 8 sample questions and a sample exam called `SAMPLE-QUIZ`.

### 2. Deploy the API
1. In Apps Script: **Deploy → New deployment → ⚙ → Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**. Students don't need a Google account. They only ever see their own questions, never the sheet.
3. Click **Deploy** and copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

> If you change `Code.gs` later, use **Deploy → Manage deployments → ✏ Edit → Version: New version** so the URL stays the same.

### 3. Publish the student page (GitHub Pages)
1. In this repo, edit [`docs/config.js`](docs/config.js) and paste the Web app URL into `API_URL`.
2. Merge to `main`. Then on GitHub, open **Settings → Pages**, set **Source: Deploy from a branch**, choose **Branch: `main`**, folder **`/docs`**, and save.
3. After a minute your page is live at `https://<your-username>.github.io/WebApp-for-Online-Exam/`.
4. In the Sheet's **Settings** tab, put that address in `STUDENT_APP_URL`.

### 4. Test it
Open `https://<your-username>.github.io/WebApp-for-Online-Exam/?exam=SAMPLE-QUIZ` and take the sample quiz. The results appear in the **Attempts** and **Responses** sheets.

---

## Day-to-day use

### Adding questions: `Questions` sheet

| Column | What to write |
|---|---|
| QuestionID | Any unique code, e.g. `SCI-001`. Use letters in IDs, not bare numbers. |
| Type | `MC`, `TF`, `FIB`, or `ESSAY` |
| Question | The question text. For fill in the blank, mark the blank with `____` (3+ underscores) |
| Choices | MC only: options separated by `|`, e.g. `Venus | Mars | Jupiter` |
| Answer | MC: the letter (`B`) or the exact choice text. TF: `TRUE`/`FALSE`. FIB: accepted answers separated by `|` (case and extra spaces are ignored). ESSAY: optional model answer, for your reference only. |
| Points | Points for the question (default 1) |
| Topic | Optional, used to filter in the Exam Builder |

Use **Exam Admin → Check question bank for errors** to catch mistakes. You can also paste questions in from Excel.

### Creating an exam
**Exam Admin → Exam Builder…**
- Enter a title, an optional Exam ID, instructions, **Opens / Closes** (the time window), and a **Time limit** in minutes.
- Tick questions from the bank. You can filter by type or topic and search.
- Options: shuffle questions, shuffle choices, show the score after submitting, active.
- Click **Save exam**, then **Copy student link**.

The time limit is counted from when each student clicks Start, but the exam never runs past the closing time. For example, a student who starts 10 minutes before closing gets 10 minutes.

### Posting in Google Classroom
**Classwork → Create → Assignment (or Quiz assignment) → Add → Link**, then paste the student link (it ends in `?exam=YOUR-EXAM-ID`).
Ask students to open it on a **laptop or desktop in Chrome or Edge**. Results are recorded in your Sheet, not in Classroom; copy the scores into Classroom's grade column if you need them there.

### Results
- **Attempts**: one row per attempt, with Status (`SUBMITTED`, `VOIDED`, `IN_PROGRESS`, `EXPIRED`), score, percent, `Late`, and the void reason.
- **Responses**: every answer, the correct answer, and points.
- **Violations**: what happened and when.
- Download the results with **File → Download → Microsoft Excel**.

### Grading essays
In **Responses**, enter points in `PointsEarned` for each `ESSAY` row, then click **Exam Admin → Recalculate scores**.

### Allowing a retake
Either tick the **AllowRetake** checkbox on the student's row in **Attempts**, or select the row(s) and click **Exam Admin → Allow retake for selected attempt(s)**.
The student opens the same link and starts a fresh attempt with the full time limit, even if the exam window has already closed.

### Optional: class list and access codes (`Roster` sheet)
If you fill in `Roster`, only listed Student IDs can take exams, and names come from the roster. If you also fill in `AccessCode`, each student must enter their code.

### Settings sheet
| Key | Default | Meaning |
|---|---|---|
| `STUDENT_APP_URL` | — | Your GitHub Pages address (used to build the links) |
| `BLUR_GRACE_SECONDS` | `0` | How long the window may lose focus before voiding. `0` voids immediately. Use `2`–`3` if clicks on browser pop-ups cause false voids. Tab switches always void immediately. |
| `REQUIRE_MONITOR_CHECK` | `TRUE` | Only allow browsers that can detect extra monitors (Chrome or Edge on a computer). Set `FALSE` to allow Firefox, Safari, and phones; monitors can't be checked there. |
| `BLOCK_COPY_PASTE` | `TRUE` | Disables copy, paste, and right-click during the exam |
| `SUBMIT_GRACE_SECONDS` | `60` | Seconds after the deadline that a submission still counts as on time |

---

## What is detected, and the limits

| Event | Detected | Result |
|---|---|---|
| Switching tabs, minimizing, opening a new window over the exam | ✅ all browsers | Voided |
| Alt+Tab / Cmd+Tab, clicking another app or the other screen | ✅ all browsers | Voided |
| Refreshing or closing the page | ✅ | Voided |
| Second monitor connected before start | ✅ Chrome/Edge (`screen.isExtended`) | Can't start |
| Second monitor connected during the exam | ✅ Chrome/Edge | Voided |
| Phone, second computer, another person, HDMI splitter or "mirror" mode | ❌ no website can see these | — |

All checks run in the student's browser, so a technically skilled student could get around them using developer tools. Treat voids as strong signals and review them, and combine the exam with a video call or room proctoring for high-stakes tests. Ordinary actions also count as leaving the exam, including clicking the browser's address bar or an operating system pop-up taking focus. Tell students this, or raise `BLUR_GRACE_SECONDS`.

The free Google tier handles a typical class (tens to a few hundred students) without problems.

## Project structure
```
apps-script/
  Code.gs           backend: API, grading, teacher menu
  Builder.html      Exam Builder window shown inside Google Sheets
  appsscript.json   manifest (optional, if you use clasp)
docs/               student exam page (served by GitHub Pages)
  index.html  app.js  styles.css  config.js
```

## Developer tests
`node tests/e2e.test.js` runs the backend against a fake Google Sheet and drives the student page in Chromium (needs the `playwright` package). It covers grading, tab-switch, Alt+Tab and second-monitor voiding, retakes, time limits, time windows, and essay re-scoring.
