# ThesisTrack: Panel Presentation Guide

For the thesis presentation at the end of October. The system runs on your own laptop, so it needs no hosting.

## 1. Setup (do this a week early, not on the day)

1. **Use one laptop for the demo** and test it in the room if you can.
2. Start **MySQL** in XAMPP, then double-click [start-thesistrack.bat](../start-thesistrack.bat). The browser opens at http://localhost:3000. Keep the black window open.
3. **Back up the database** (phpMyAdmin at http://localhost/phpmyadmin, database `thesistrack`, Export).
4. **Reset to clean sample data** when you want a fresh demo: `npm run seed` (it wipes everything, so back up first).
5. **Fonts now load from the site itself**, so the design looks the same without internet.
6. **Email:** adviser invitation codes are emailed with Gmail, which needs internet. If the Wi-Fi is bad, the invitation is still saved and the code is written to `outbox/mail.log`. Open that file to read the code. Emails now give up after about 10 seconds, so the page won't freeze.
7. **Show it on a projector and, if you want the panel to try it, on their phones:**
   - Everyone must be on the same Wi-Fi. Find your laptop's address with `ipconfig` (look for IPv4, e.g. 192.168.1.5), then they open `http://192.168.1.5:3000`.
   - Allow "Node.js" through the Windows firewall when it asks.
   - The ID-photo camera only works on `localhost`. On phones, the file picker is used instead.
8. **Bring a backup:** a USB copy of the project folder and a database export, plus screenshots or a screen recording of the full flow in case something fails.

## 2. Demo accounts (password for all: `password123`)

| Role | Email |
| --- | --- |
| Student (in Team Pagasa) | juan@student.edu.ph |
| Student (no group) | rico@student.edu.ph |
| Adviser | reyes@school.edu.ph |
| Coordinator | admin@school.edu.ph |

Open each role in a separate browser (for example Chrome, Edge, and a private window) so you don't keep signing in and out.

## 3. Demo script (about 10 minutes)

1. **Problem (30 sec).** Thesis chapters are passed around by email and paper, so versions get lost and nobody sees the real progress.
2. **Student: Juan.** Open Chapter 4 and upload a PDF. Show the status change to *Pending review*, the version history, and the progress bar.
3. **Adviser: Dr. Reyes.** Chapter 4 is waiting. Return it **For revision** with a comment. (This shows that a comment is required.)
4. **Student again.** The status changed and the comment is there. Mark it resolved and upload version 2.
5. **Adviser again.** Approve it. Point out the chapter is now **locked**.
6. **Student: Rico (no group).** Create a group, add a member by email.
7. **Coordinator.** Assign an adviser (it's only a request), then switch to the adviser and **accept** it. Then schedule a defense with two panel members.
8. **Coordinator overview.** Show on-track, delayed and completed groups, then the **Reports** page and the CSV download.
9. **Invitation (optional).** Invite an adviser and show the one-time code and the lock after five wrong tries.
10. **Close:** security (hashed passwords, role access, only group members can download files) and the limitations in Section 5.

## 4. Questions the panel is likely to ask

| Question | Short answer |
| --- | --- |
| Why can't advisers register themselves? | To stop fake advisers. Only the coordinator can invite, with a 6-digit code that expires in 60 minutes and locks after five wrong tries. |
| What if the adviser never replies? | The group page shows pending reviews, and chapters past their deadline mark the group **Delayed** on the coordinator's overview. |
| Are old versions kept? | Yes. Every upload is a new version, and nothing is overwritten. |
| Why do panel members not log in? | They only evaluate at the defense. The coordinator records them, and students see the date, time and room. |
| How is the data protected? | Hashed passwords, form-forgery protection, role checks on every page, private ID photos, limited file types and sizes, and a sign-in lockout. |
| What if a student forgets the password? | The student asks for a reset link on the Forgot password page, and the system administrator is notified. If the email does not arrive, the system administrator resets it from the Users page and the student changes it under My account. |
| Do students get reminded of deadlines? | Yes. The system sends a reminder 3 days before a deadline and another when it is overdue. |
| Can it be used online? | The code is ready for hosting (`DEPLOY.md`), but we have not deployed it yet. |
| What database is used? | MySQL. The tables are in `db.js`. |
| Why a web system instead of an app? | It works on any device with a browser and needs no installation. |

### AI, privacy and design questions

| Question | Short answer |
| --- | --- |
| How does the plagiarism check work? | It compares runs of 6 words in a row against the latest upload of every other group in the same workspace. It runs on our server, costs nothing, and uses no AI. |
| Is it reliable? | It is an indicator, not proof. Paraphrased text is missed, quoted text and common phrases can be flagged, and unreadable files (such as scanned PDFs) are skipped. The adviser makes the judgment. |
| Does it search the internet or past theses? | No. It only compares with other groups in the same workspace. We say this openly as a limitation. |
| Where does student text go when the AI check or chatbot is used? | Grammar suggestions and the chatbot send text to Google Gemini's free tier, which may use prompts to improve its products. Local use with Ollama keeps everything on the computer. The plagiarism check never leaves the server. |
| What if the AI is down or the daily limit is used up? | The app says so and works again later. The plagiarism check and the rest of the system keep working. |
| Does the AI write the thesis? | No. It suggests grammar fixes and answers questions. Students still write and submit their own chapters, and advisers review them. |
| Can one coordinator see another's students? | No. Every coordinator has a separate workspace. `npm run test:workspaces` tries to break the separation and can be run live. |
| Can the system administrator read student work? | No. The administrator manages workspaces and accounts but cannot open chapters, comments, files or message text. |
| Who can read the Messages? | A group thread: the group, its adviser and the coordinator. A private thread: that person and the workspace's coordinators. Text only, with a rate limit, and the coordinator can hide abusive messages (kept as evidence). |
| What happens to the sample accounts? | With `NODE_ENV=production` they are not created, and the guide says to delete them before real use. |

## 5. Limitations and future work (say these yourselves, panels respect it)

- Runs locally. It is not deployed to the internet yet.
- Deadline reminders and most notifications are inside the system. Only adviser and coordinator invitations and password-reset links are sent by email.
- The plagiarism check compares only with other groups in the same workspace. It does not search the internet or published work, and it misses paraphrasing.
- Grammar suggestions and the chatbot depend on the internet and on Gemini's free daily limits, and send text to Google. Ollama is the private alternative.
- Files are viewed by downloading them, not previewed in the browser.
- Email depends on Gmail and the internet. The fallback is `outbox/mail.log`.
- It has been tested with sample data, not yet with a real class.

## 6. Expert suggestions: what to improve before the presentation

Ranked by value for the time it takes. I can build any of these.

1. **Forgot password / coordinator password reset.** ✅ Done. The system administrator (not the coordinator) uses **Reset password** on the Users page, gives the temporary password to the person privately, and they change it under **My account**.
2. **Deadline reminders.** ✅ Done. Every hour the system notifies a group 3 days before a deadline and when it is overdue (and tells the adviser about overdue chapters). Changing a deadline restarts the reminders.
3. **A coordinator activity log page.** (Small.) The system already records actions, but only the latest 12 show on the overview. A full page with a filter helps prove accountability.
4. **Browser preview for PDF chapters.** (Small.) Advisers can read a chapter without downloading it.
5. **Printable report (PDF).** (Medium.) A one-page summary per group for the defense, in addition to the CSV.
6. **Clean demo data.** (Small.) Replace the sample names with a realistic thesis group of your own, so the demo looks like your real case.

## 7. Day-of checklist

- [ ] Laptop charged, charger and an extension cord brought
- [ ] MySQL running, `start-thesistrack.bat` tested
- [ ] Browser zoom set to about 110% for the projector
- [ ] Demo data freshly reset, and a database backup exists
- [ ] Accounts tested in each browser
- [ ] Internet or phone hotspot ready for emails (or the `outbox/mail.log` plan)
- [ ] USB backup and screen recording ready
- [ ] Everyone knows who presents which role
- [ ] Run the chatbot and the AI check once to confirm the Gemini key and model still work
- [ ] New Gmail App Password created and kept only in `.env` (the old one was in the README and must be revoked)
- [ ] `.env` is not on the USB copy you hand to anyone
