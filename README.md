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
| Camera monitoring | Optional per exam: **not required**, **face check at the start only**, or **monitored during the whole exam**. The student's face must be visible before they can start. With full monitoring, during the exam a hidden face, a covered camera, a second person, a phone, or the camera turning off gives **one warning**, and **the second time voids the exam**. Video is checked in the browser only: nothing is recorded or uploaded. |
| Anti-cheating | Switching tabs, minimizing, Alt+Tab, leaving or reloading the page, or plugging in a monitor mid-exam **voids the exam immediately**. A pop-up tells the student to inform their instructor. |
| Time | Per-exam **time window** (opens/closes) and **time limit** (auto-submits when time is up). Also: a countdown before the exam opens, warnings at times you choose, and an optional time limit per question. |
| Poor connection | If the internet drops or the page reloads, students can **reconnect within 1 minute** (adjustable, up to 3 times) and continue where they left off |
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
- Enter a title, an optional Exam ID, the **Course**, instructions, **Opens / Closes** (the time window), and a **Time limit** in minutes.
- Tick questions from the bank. You can filter by type or topic and search.
- **How questions are shown**:
  - *All questions on one page*: students scroll and can change any answer until they submit.
  - *One question at a time*: Next / Previous buttons plus numbered buttons to jump between questions.
    - Untick **Allow going back** to make it forward-only. There is no Previous button, and each answer is **locked on the server** when the student clicks Next, saved in the `Progress` sheet. Students are warned before skipping an unanswered question.
    - **Time limit per question** (seconds, 0 = none): a small ⏱ timer shows on each question. When it runs out, the exam moves to the next question, or submits after the last one. Going back is turned off automatically.
- **Camera / face check**: *Not required*, *Check face at the start only*, or *Monitor face during the whole exam* (see below).
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

### Class list, courses and access codes: `Roster` sheet (optional)
If the Roster is empty, anyone with an exam link can take it. If you fill it in, only listed Student IDs can take exams, and names come from the Roster.

| StudentID | Name | Email | AccessCode | Courses |
|---|---|---|---|---|
| 2024-001 | Ana Santos | | 4821 | MATH101, SCI201 |
| 2024-002 | Ben Cruz | | 7395 | SCI201 |

- **Courses**: every course the student is enrolled in, separated by commas. A student can be in any number of courses.
- In the Exam Builder, set the exam's **Course** (e.g. `MATH101`). Only students with that course in their Courses cell can take it. Everyone else sees *"You are not enrolled in MATH101"*.
- Leave an exam's Course empty to let everyone on the Roster take it.
- Capitals and spaces don't matter: `MATH 101` = `math101`.
- **AccessCode** (optional): if filled in, the student must type it. This stops someone from using another student's ID.
- The **Attempts** sheet records the course of each attempt, so you can filter results by course.

### Timers
- **Before the exam opens:** the rules screen shows a live countdown ("This exam opens in 1 day 2:15:30"), and **Start exam** unlocks by itself at zero. Turn it off with `OPEN_COUNTDOWN` = FALSE.
- **During the exam:** the countdown sits in the top bar and turns red in the last minute. Warnings appear at the minutes listed in `TIME_WARNINGS` (default `5, 1`; e.g. `10, 5, 1`; leave it empty for none). Warnings longer than the exam itself are skipped.
- **Per question:** see *Time limit per question* above.

### Poor connection / reconnecting
With `RECONNECT_SECONDS` above 0 (default **60**):
- **Internet drops while the page is open:** a red banner says *"Connection lost — trying to reconnect…"* and counts down. Students can keep answering, and answers are saved on their computer. If the connection returns in time, the exam simply continues. If not, the exam is voided.
- **Page reloads or closes** (browser crash, accidental reload): the student reopens the same link and enters their ID within the time limit. The exam continues with the same answers and the same questions, up to `MAX_RECONNECTS` times (default 3).
- **The timer keeps running** while they're away. Every disconnect and reconnect is logged in **Violations**, so you can see who reconnected and how often.
- Switching tabs, Alt+Tab, and a second monitor still void the exam immediately. A reload is not mistaken for a tab switch.
- The server checks the same limits, so the page can't be tampered with to get more time.
- Set `RECONNECT_SECONDS` to `0` for the strict behavior: any reload or close voids the exam.
- Note: a student could close the page on purpose and reopen it within the limit. Each time is logged, and `MAX_RECONNECTS` caps it.

### Camera monitoring
In the Exam Builder, choose **Camera / face check**:

| Option | Before starting | During the exam |
|---|---|---|
| **Not required** | No camera | No camera |
| **Check face at the start only** | Face must be visible to unlock Start | Camera turns off |
| **Monitor face during the whole exam** | Face must be visible to unlock Start | Monitored: 1 warning, then void |

With **Monitor face during the whole exam**:
- **Show students their camera preview** (Builder checkbox, on by default):
  - *On, wide screens (≥ 1200 px):* a 160 px preview sits in the bottom-right corner, in the empty margin beside the questions.
  - *On, narrower screens:* a small thumbnail sits in the top bar next to the timer.
  - Either way it never covers questions, choices or buttons.
  - *Off:* no picture, just a small "📷 Camera on" label in the top bar that turns red when there's a problem. Monitoring still works the same, and the warning box still shows the camera so the student can fix the problem.
- On the rules screen, students click **Turn on camera**. **Start exam** stays disabled until exactly one face is clearly visible.
- During the exam, a small camera preview stays in the corner. Each of these counts as an offense if it lasts longer than `FACE_GRACE_SECONDS` (default 3 s):
  - the face is not visible (covered, turned away, or left the seat)
  - the camera is covered or too dark
  - more than one person is in view
  - a mobile phone is held in front of the camera
  - the camera is turned off (this one counts immediately)
- **1st offense:** a warning box. The student can only continue once the problem is fixed. It's logged in **Violations** as a warning, and **Attempts → Warnings** becomes 1.
- **2nd offense:** the exam is voided, just like a tab switch.
- Detection runs in the browser using Google MediaPipe, loaded from a CDN on first use (about 5 MB). Nothing is recorded or uploaded. Students need a webcam and Chrome or Edge.
- Limits: a phone held below the desk or outside the camera's view can't be seen, and phone detection can sometimes miss or mistake objects. That's why a phone gets a warning first, not an instant void.

### Settings sheet
| Key | Default | Meaning |
|---|---|---|
| `STUDENT_APP_URL` | — | Your GitHub Pages address (used to build the links) |
| `BLUR_GRACE_SECONDS` | `0` | How long the window may lose focus before voiding. `0` voids immediately. Use `2`–`3` if clicks on browser pop-ups cause false voids. Tab switches always void immediately. |
| `REQUIRE_MONITOR_CHECK` | `TRUE` | Only allow browsers that can detect extra monitors (Chrome or Edge on a computer). Set `FALSE` to allow Firefox, Safari, and phones; monitors can't be checked there. |
| `BLOCK_COPY_PASTE` | `TRUE` | Disables copy, paste, and right-click during the exam |
| `SUBMIT_GRACE_SECONDS` | `60` | Seconds after the deadline that a submission still counts as on time |
| `FACE_GRACE_SECONDS` | `3` | Camera exams: how long a problem must last before it counts as an offense |
| `PHONE_DETECTION` | `TRUE` | Camera exams: also look for a phone held in front of the camera |
| `OPEN_COUNTDOWN` | `TRUE` | Show a countdown before an exam opens |
| `TIME_WARNINGS` | `5, 1` | Minutes before the end when students are warned; empty = no warnings |
| `RECONNECT_SECONDS` | `60` | Time allowed to reconnect after the internet drops or the page reloads; `0` = off (reload voids) |
| `MAX_RECONNECTS` | `3` | How many times a student may reopen the page during one attempt |

---

## What is detected, and the limits

| Event | Detected | Result |
|---|---|---|
| Switching tabs, minimizing, opening a new window over the exam | ✅ all browsers | Voided |
| Alt+Tab / Cmd+Tab, clicking another app or the other screen | ✅ all browsers | Voided |
| Refreshing or closing the page | ✅ | Allowed to reconnect within `RECONNECT_SECONDS` (max `MAX_RECONNECTS` times), otherwise voided |
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
`tests/timing.test.js` covers the countdowns, warnings, per-question timer, and reconnect rules.
`tests/camera.test.js` runs the camera flow with the real MediaPipe detector and a fake webcam. See the comments at the top of the file for setup.

`node tests/e2e.test.js` runs the backend against a fake Google Sheet and drives the student page in Chromium (needs the `playwright` package). It covers grading, tab-switch, Alt+Tab and second-monitor voiding, retakes, time limits, time windows, and essay re-scoring.
