# Teaching non-repudiation with SiegeSeal Classroom

A plan for one 50-minute high school class. Students need a laptop, Chromebook or phone each; no accounts, no installs.

**Goal:** by the end, students can explain in their own words what a digital signature proves (who wrote it, that nobody changed it, and that the writer can't deny it later), and what it doesn't (it doesn't keep the message secret).

## Before class (15 minutes, once)

1. Deploy the site to GitHub Pages (see the README).
2. Make a **throwaway GitHub account** for the class. Under *Settings → Developer settings → Personal access tokens → Tokens (classic)*, create a token with **only the `gist` scope** and a short expiry.
3. Open your site, choose **Start a classroom**, paste the token. Make one classroom per group of four (see limits below). Copy each link.
4. Rehearse once with **Try it on this computer**: open four tabs and play every role yourself.

The token ends up in every student's link. That's acceptable only because the account holds nothing but these rooms. Revoke the token after class.

## Groups

Groups of four: **Aurelia**, **Borealis**, **Cyrene**, and one student who plays **Vharos**, the city. Vharos picks any name at the identity screen (or joins as a fourth army) and works from the *Vharos* tab.

## The lesson

**1. The story (5 min).** Read *How it works → The story* aloud, or tell it. Ask: *if you were Borealis and got a letter saying "attack at dusk", how would you know it was real?* Collect answers (handwriting, wax seal, a code word…) and ask how the city could fake each one.

**2. Plain letters (8 min).** Everyone turns **Check seals** off (top bar). Armies send each other plans. Vharos turns on the checkpoint and quietly rewrites a word in a letter or two. Then ask each army: *which of your letters were changed?* Nobody can tell.

**3. Seal ceremony (5 min).** Turn **Check seals** back on. Look at the letters from step 2: the altered ones now show a cracked seal. Then do the ceremony: each army reads their fingerprint aloud, and the others tick *It matches* only if it does. Explain: *the fingerprint is a short summary of your public key. Your private key never leaves your device.*

**4. Siege (15 min).** Vharos tries every tool: rewrite, forge a letter, deliver a copy twice, deliver a letter to the wrong ally, burn a courier and fake its receipt, hold a courier for more than ten minutes, post a fake seal. Armies keep a tally of which tricks they caught and how the app explained it. Swap who plays Vharos halfway.

Expect students to discover on their own:
- Rewritten and forged letters break the seal.
- Copies and old letters have genuine seals but are rejected anyway (*why?* The number and the time are sealed in).
- Burned letters leave a gap in the numbering and no signed receipt.
- **A fake seal works on anyone who skipped the ceremony.** This is the most important "aha": cryptography only moves trust, it doesn't create it.

**5. Tribunal (10 min).** One army uses *Tribunal → Try to tell two stories* to promise different things to the other two. The tribunal catches it. Then argue a case: an army that "never promised" something, or "never got" an order, is confronted with **Copy evidence** pasted into someone else's *Check someone else's evidence* box. *This* is non-repudiation: the proof doesn't depend on trusting the person showing it.

**6. Wrap-up (5 min).** Ask: *Vharos read every letter. Did seals stop that?* (No: signatures aren't encryption.) Where do we use this in real life? Software updates, the browser padlock, signed contracts, Signal safety numbers, SSH.

## Exit ticket

1. Vharos changes "dawn" to "dusk" in a sealed letter. What does Borealis see, and why?
2. Cyrene says she never sent a letter that has her valid seal on it. Why doesn't the tribunal believe her?
3. Name one thing a digital signature does **not** protect against.

## Limits worth knowing

- **GitHub limits each token to 500 writes an hour.** Each letter costs about two (the letter, then the receipt). That's roughly 250 letters an hour across all rooms sharing a token, plenty for a few groups but tight for a whole class at once. For more than about four groups, make a second throwaway account and token and give each half of the class different rooms. If the limit is hit, the app says so and when to try again.
- Changes take a few seconds to appear (each device checks every 6 seconds).
- A room keeps its newest 400 letters and receipts. That's plenty for a lesson; start a fresh room for each class.
- Seals live in each student's browser. Clearing browser data or switching device means forging a new seal, which other students will see as a changed seal, a good discussion prompt.
- Everything in a room is readable by anyone with its link. Tell students not to write anything personal.
