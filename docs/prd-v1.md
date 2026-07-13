# PRODUCT REQUIREMENTS DOCUMENT (PRD)

## Keystone OS — Version 1.0

### "The Second Reader" — AI-Assisted Pre-Delivery Report Review

**Document status:** Governs all product, design, and engineering decisions for v1.0. Subordinate to Chapter 0 — The Manifesto and the Company Bible. Any requirement in this document that conflicts with either governing document is void and must be corrected before build begins, not silently implemented.

**Audience:** Senior engineers, product designers. This document defines _what_ the product is and _why_. It does not define _how_ it is built.

---

## 1. Product Overview

Keystone OS v1.0 is a web application that allows a commercial real estate appraiser to upload a finished or near-final narrative appraisal report and receive, within minutes, a structured findings report identifying internal inconsistencies, likely calculation errors, narrative contradictions, missing standard elements, template leftovers, and mismatched identifying data — before that report is delivered to a client, lender, or court.

The product does not write reports. It does not determine, suggest, or validate market value, cap rates, adjustments, or any other judgment-based conclusion. It is a second reader: a fast, tireless, structured proofing pass that catches what a human author is structurally poor at catching in their own long, numeric work.

v1.0 is single-user, single-firm, file-upload-based. There is no live integration with any authoring tool. There is no multi-user firm management. Those are explicitly deferred (Section 27).

---

## 2. Product Goals

1. Give a solo appraiser or small-firm appraiser a findings report on a real, complete draft in under 5 minutes from upload.
2. Every finding must be specific, located, and explainable in one sentence a human can verify in under 10 seconds (Manifesto 0.2, Company Bible Section 4).
3. Every finding must be clearly labeled as either a deterministic (verifiable, exact) finding or a model-based (probabilistic, inferential) finding, so the appraiser calibrates trust correctly per finding (Manifesto 0.4.4).
4. Reduce the number of embarrassing, avoidable mistakes (wrong client name, mismatched address, unresolved template placeholder, arithmetic mismatch) that reach a client, lender, or court.
5. Never present output that could be read as an opinion on value, a cap rate, an adjustment, or any other judgment call (Manifesto 0.4).
6. Build a trustworthy, low-noise findings experience — false-positive rate is treated as a critical product-quality metric from day one, not a later optimization (Company Bible Section 16).

---

## 3. Non-Goals

Restated from the Company Bible and Manifesto, made concrete for v1.0:

- v1.0 does not generate, draft, or suggest report narrative content.
- v1.0 does not determine or validate market value, cap rates, discount rates, or comparable adjustments.
- v1.0 does not verify facts against the outside world (does not confirm an address exists, confirm a sale price, confirm zoning).
- v1.0 does not integrate live into Narrative1, ClickForms, or any authoring tool's editor. Upload is file-based only.
- v1.0 does not support multiple users per account, review queues, or role-based firm management.
- v1.0 does not auto-correct, auto-edit, or modify the uploaded report in any way. The uploaded file is never altered.
- v1.0 does not persist or reuse client data to build a comp/market-data product (Company Bible Section 25).

---

## 4. MVP Scope

**In scope for v1.0:**

- Account creation and login (single user per account).
- Upload of one report (DOCX and/or PDF) per review, with optional supporting Excel file(s).
- Automated review producing a findings report, covering the review categories defined in Section 18.
- A findings interface where the appraiser can view, triage, and mark each finding as reviewed/dismissed with a reason.
- Ability to re-upload a revised draft and run a new review, with prior review history retained and viewable.
- Export of the findings report (Section 23).
- Basic account settings (profile, password, delete account/data).

**Explicitly out of scope for v1.0:** everything in Section 27 (Future Features) and Section 28 (Out-of-Scope Features).

---

## 5. User Personas

Carried forward from the Company Bible (Section 6), scoped to what v1.0 actually serves.

### Primary persona for v1.0 — "Deadline Dave," Solo Appraiser

Independent appraiser, produces 8–12 narrative reports/month, writes in Narrative1 or similar, currently self-reviews the night before delivery. Wants a fast, low-friction second check that catches what he can't see in his own document, without changing how he writes reports. **v1.0 is built for Dave, end to end.**

### Secondary persona, partially served in v1.0 — "Managing Partner Maria," Small Firm Owner

Reviews every junior appraiser's report herself before delivery; is the bottleneck on firm growth. In v1.0, Maria can use the product exactly as a solo appraiser would (one account, upload any report she personally wants checked) — but v1.0 does **not** give her multi-user visibility into her team's uploads, a review queue, or role-based access. She is a validated future-tier customer, not a fully-served v1.0 customer. This limitation must be visible in how the product is marketed to firms — we do not overclaim firm-level capability we have not built (Manifesto 0.5).

### Explicitly not served in v1.0 — "Review Department Rita," dedicated internal QC role

Deferred per Company Bible roadmap (Section 13, item 2) and PRD Section 27.

---

## 6. User Stories

Written from the appraiser's perspective, each mapped to a product goal.

1. As an appraiser, I want to upload my finished report and get a findings list quickly, so I can catch mistakes before my client does. _(Goal 1)_
2. As an appraiser, I want every finding to tell me exactly where the problem is and why it was flagged, so I can verify it myself in seconds without having to hunt through my document. _(Goal 2)_
3. As an appraiser, I want to know which findings are "the software is certain about this" versus "the software thinks this might be worth a look," so I know how much to trust each one. _(Goal 3)_
4. As an appraiser, I want the tool to catch things like a wrong client name, a mismatched address, or a leftover template placeholder, because these are the mistakes that embarrass me most and are easiest to miss in my own writing. _(Goal 4)_
5. As an appraiser, I never want the tool to tell me what my value conclusion, cap rate, or adjustments should be — I want to trust that it stays in its lane so I can trust everything else it does. _(Goal 5)_
6. As an appraiser, I want to dismiss a finding that isn't actually a problem, with a quick note why, so my findings list reflects only what I still need to act on, and so I don't get shown the same non-issue again on a re-run. _(Goal 6)_
7. As an appraiser, I want to re-upload a revised draft after fixing issues and see a fresh review, so I can confirm my fixes worked and nothing new broke. _(Goals 1, 6)_
8. As an appraiser, I want to export my findings report, so I can keep a record of my own QC process for my files. _(Company Bible Section 24, Data Philosophy)_
9. As an appraiser, I want confidence that my uploaded client data is handled responsibly, so I can honestly tell my own clients their information was safe. _(Company Bible Section 24/25)_

---

## 7. User Flows

### Flow A — First-time user, first review

1. User lands on marketing/login page → signs up (email + password).
2. User arrives at empty Dashboard (no reviews yet).
3. User clicks "New Review" → Upload screen.
4. User uploads report file (DOCX/PDF), optionally adds supporting Excel file(s).
5. User confirms upload → Processing screen (review running).
6. Review completes → user is taken to the Findings Report screen for that review.
7. User reviews findings, marks several as dismissed with reasons, others left open/unactioned.
8. User exports the findings report (PDF) for their own records.
9. User returns to Dashboard, sees the completed review listed.

### Flow B — Returning user, revised draft re-review

1. User logs in → Dashboard shows prior review(s).
2. User opens a prior review → clicks "Re-run on revised draft."
3. User uploads the revised file.
4. Processing screen runs; on completion, user is shown the new Findings Report, with a visible comparison indicator: findings resolved since last run, findings still open, new findings introduced.
5. User continues triaging as in Flow A.

### Flow C — Reviewing an individual finding

1. From the Findings Report screen, user clicks a specific finding.
2. Finding Detail view opens (may be a panel/drawer rather than a separate screen — a design decision, but the _content_ required is specified in Section 8).
3. User reads the evidence (locations, quoted mismatch, or shown arithmetic).
4. User marks the finding: "Acknowledged / will fix," "Dismissed — not an issue," with an optional required reason for dismissal.
5. User returns to the full Findings Report list, which reflects the updated status.

### Flow D — Account and data management

1. User navigates to Account Settings.
2. User can update profile info, change password, view data retention policy, request account/data deletion.
3. Deletion request flow requires explicit confirmation (Manifesto 0.4.5-adjacent: nothing silent or ambiguous in destructive actions).

---

## 8. Complete Screen Inventory

For each screen: Purpose, User Actions, Data Displayed, Empty State, Loading State, Error State.

### 8.1 — Login / Sign Up

- **Purpose:** Authenticate an existing user or create a new account.
- **User actions:** Enter email/password to log in; toggle to sign-up form; submit sign-up (email, password, name, firm name — optional field); trigger password reset.
- **Data displayed:** Form fields only; no user data yet.
- **Empty state:** N/A (this screen has no data list).
- **Loading state:** Submit button shows a busy indicator while authenticating; form fields disabled during submission.
- **Error state:** Invalid credentials → inline message, specific enough to be useful ("Incorrect email or password") without revealing whether the email exists (security requirement, Section 26). Sign-up validation errors (weak password, malformed email, duplicate account) shown inline per field.

### 8.2 — Dashboard (Home)

- **Purpose:** Central hub showing the user's review history and entry point to start a new review.
- **User actions:** Click "New Review" (primary action); click into any prior review to view its Findings Report; search/filter prior reviews by property name, client name, or date.
- **Data displayed:** List of past reviews, each showing: report/property name, client name, upload date, review status (Processing / Complete / Failed), and a summary count of open findings by severity (e.g., "2 Critical, 5 Moderate, 3 Low").
- **Empty state:** First-time user sees no review history — message and prominent "Start your first review" call to action, with brief explanatory copy about what the product does (framed as a second reader, per Manifesto 0.5 — not "AI assistant").
- **Loading state:** Skeleton/placeholder rows while review history loads.
- **Error state:** If review history fails to load, a clear retry action; does not silently show an empty list (an empty list must always mean "you truly have no reviews," never "something failed to load" — this distinction matters for trust, per Company Bible Section 16).

### 8.3 — New Review / Upload

- **Purpose:** Let the user upload a report (and optional supporting files) to start a new review.
- **User actions:** Select/drag-and-drop the primary report file (DOCX/PDF); optionally attach supporting Excel file(s); enter or confirm auto-detected metadata (property name, client name — pre-filled if extractable, editable by user); submit to start review.
- **Data displayed:** File name(s) and size(s) of selected files; any auto-detected metadata for user confirmation before submission.
- **Empty state:** Default state before any file is selected — clear instructions on supported file types and size limits.
- **Loading state:** Upload progress indicator per file; "Starting review..." state after submission, before transitioning to the Processing screen.
- **Error state:** Unsupported file type, file too large, upload failure (network), or corrupted/unreadable file — each with a specific, actionable message (e.g., "This file appears to be password-protected and can't be read. Please upload an unprotected copy.").

### 8.4 — Processing (Review Running)

- **Purpose:** Show the user that their review is actively running, without requiring them to wait on the screen.
- **User actions:** Wait, or navigate away (review continues in the background; user is notified on completion per Section 21). Cancel the in-progress review.
- **Data displayed:** Status of the review (e.g., "Reading document," "Checking consistency," "Finalizing findings" — honest, generic stage labels, not theatrical, per Manifesto 0.5 tone).
- **Empty state:** N/A.
- **Loading state:** This screen _is_ the loading state for the review itself; includes an estimated time remaining, if reliably determinable, otherwise an honest "this usually takes a few minutes" statement rather than a fake progress bar.
- **Error state:** Review fails to process (unreadable file discovered mid-process, internal failure) — clear message, the file is not lost, user can retry or contact support; no silent failures (Section 22).

### 8.5 — Findings Report (Review Results)

- **Purpose:** The core screen of the product — presents every finding from a completed review, organized for fast triage under deadline pressure.
- **User actions:** Filter/sort findings by severity, category, or status (open/acknowledged/dismissed); click into any finding for detail (Section 8.6); mark findings as acknowledged or dismissed (with reason) directly from the list where reasonable; export the findings report (Section 23); trigger a re-run on a revised draft.
- **Data displayed:** Report metadata (property name, client name, upload date, file name); overall summary counts by severity; full list of findings, each showing: category, severity, confidence level (deterministic/model-based), a one-line description, and location reference; for re-reviews, a comparison indicator (resolved / still open / new).
- **Empty state:** A review that produced zero findings — this is a real, valid, positive state and must be presented as good news, not as a broken or empty screen ("No issues found. This does not confirm your value conclusion or professional judgment — only that we found no consistency, arithmetic, or completeness issues in the checks we ran." — the disclaimer is mandatory, per Manifesto 0.4).
- **Loading state:** Skeleton state while findings are fetched (should be near-instant after Processing completes, since Processing already did the work).
- **Error state:** Findings failed to load despite a completed review — retry action; this must never be silently blank, per the same trust principle as 8.2.

### 8.6 — Finding Detail (panel or screen)

- **Purpose:** Show full evidence for a single finding so the user can verify and act on it.
- **User actions:** Read full evidence; mark as acknowledged or dismissed (with required reason for dismissal); navigate to next/previous finding without returning to the full list.
- **Data displayed:** Category, severity, confidence level (with a plain-language explanation of what that confidence level means for _this specific finding_, not a generic tooltip); the specific evidence (e.g., exact text quoted from two locations with page/section references; or the exact arithmetic showing the mismatch); current status and, if previously actioned, who/when/why.
- **Empty state:** N/A (only shown when a finding exists).
- **Loading state:** Standard load indicator if detail is fetched separately from the list.
- **Error state:** Detail fails to load — retry action, does not lose the user's place in the list.

### 8.7 — Review History Comparison (may be integrated into 8.5 rather than a separate screen — content requirements below apply regardless of layout)

- **Purpose:** Let the user see how a re-review compares to the prior run on the same engagement.
- **User actions:** Toggle between "all findings" and "changes only" view; view prior version's findings report for reference.
- **Data displayed:** Findings resolved since last run, findings still open, newly introduced findings.
- **Empty state:** No prior review to compare against (this is the first run) — comparison view is simply not shown/offered.
- **Loading state:** Standard load indicator.
- **Error state:** Comparison data fails to load — falls back gracefully to showing the current review's findings without comparison, with a visible note that comparison is temporarily unavailable, rather than blocking the whole screen.

### 8.8 — Account Settings

- **Purpose:** Manage profile, security, and data.
- **User actions:** Update name/firm name/email; change password; view data retention/privacy policy; request account and data deletion; log out.
- **Data displayed:** Current profile information.
- **Empty state:** N/A.
- **Loading state:** Standard save-state indicators on form submission.
- **Error state:** Validation errors inline; failed save shows a clear retry, does not silently discard changes.

### 8.9 — Data Deletion Confirmation

- **Purpose:** Ensure destructive action (deleting account and/or uploaded report data) is deliberate, per Manifesto's emphasis on never making consequential actions silent or ambiguous.
- **User actions:** Confirm or cancel deletion; understand exactly what will be deleted (uploaded files, findings history, account) versus what may be retained (e.g., minimal billing records, if legally required — to be defined precisely in a future privacy policy, not invented here).
- **Data displayed:** Explicit list of what will be deleted and what, if anything, is retained and why.
- **Empty state:** N/A.
- **Loading state:** Deletion in progress indicator.
- **Error state:** Deletion fails — clear message, data is confirmed _not_ deleted (never leave the user unsure whether a destructive action partially succeeded).

---

## 9. Navigation

- **Primary navigation** (persistent, e.g., top or side nav): Dashboard, New Review, Account Settings, Log out.
- **Dashboard is the default landing screen** after login.
- **Findings Report is reached only through a specific review** (from Dashboard list or immediately after a review completes) — it is never a standalone, unscoped screen, since findings are always tied to one uploaded report.
- **No global search across all findings across all reviews in v1.0** — this is a plausible future feature (Section 27) but not required for v1.0's single-user, modest-volume use case.
- Users can always return to Dashboard from anywhere via primary navigation; no dead-end screens.

---

## 10. Permissions

v1.0 is single-user per account — there is no team, no role hierarchy, no shared data between accounts. Permissions in v1.0 are therefore simple but must still be explicit:

- A user can only view, upload, and act on their own uploaded reports and findings. No account can access another account's data under any circumstance.
- There is no admin/owner distinction in v1.0 — every account has full control over its own data (upload, delete, export).
- Account deletion permanently removes the user's access; it does not transfer data to any other account (no firm-level ownership concept exists yet — see Section 27 for firm-tier permissions, deferred).

---

## 11. Functional Requirements

Each requirement includes Description, User Value, Business Value, and Success Criteria, per instruction.

### FR-1: Report Upload

- **Description:** User can upload a primary report file (DOCX or PDF) and optional supporting Excel file(s) to begin a review.
- **User value:** Low-friction entry point; works with whatever the appraiser already produces, no format change required.
- **Business value:** Removes integration/partnership dependency as a launch blocker (Manifesto 0.6.2); fastest path to first value.
- **Success criteria:** A user can go from "no account" to "uploaded first report" in under 3 minutes without external help; supported file types are clearly communicated before failure, not discovered through trial and error.

### FR-2: Automated Review Execution

- **Description:** Upon upload, the system runs the full set of review categories (Section 18) against the report and produces a findings report.
- **User value:** The core value of the product — a fast, structured second read.
- **Business value:** The product's entire value proposition; must be reliable enough to build trust on first use.
- **Success criteria:** Review completes and returns findings within the performance target (Section 24) for a report of typical length (defined in Section 24); findings are reproducible — re-running the same unmodified file produces materially the same findings (not randomly different results run to run for deterministic checks; model-based checks may have minor variance but must not contradict themselves in severity/category).

### FR-3: Finding Presentation

- **Description:** Each finding is displayed with category, severity, confidence level, description, and location evidence.
- **User value:** Fast triage; user can decide in seconds whether a finding matters.
- **Business value:** This structure is the trust mechanism (Company Bible Section 4) — without it, the product is indistinguishable from an unreliable AI chat output.
- **Success criteria:** A user unfamiliar with the tool can, without instruction, understand what a given finding means and where to look, using only the on-screen information.

### FR-4: Finding Triage (Acknowledge/Dismiss)

- **Description:** User can mark each finding as acknowledged or dismissed, with a required reason for dismissal.
- **User value:** Keeps the findings list meaningful over multiple review passes; creates the user's own record of their QC decisions.
- **Business value:** Dismissal reasons are the primary signal for measuring false-positive rate (Company Bible Section 15/16) — this data directly drives product quality improvement.
- **Success criteria:** Dismissing a finding requires a reason (not a silent, reason-less dismiss); dismissed status persists and is reflected correctly on any re-run comparison.

### FR-5: Re-Review on Revised Draft

- **Description:** User can upload a revised version of a report already reviewed, and receive a new findings report that shows resolved/still-open/new findings relative to the prior run.
- **User value:** Confirms fixes worked; catches new problems introduced while fixing old ones.
- **Business value:** Encourages return usage within a single engagement, improving the retention metric (Company Bible Section 15).
- **Success criteria:** A user can identify, without manually comparing two reports themselves, which specific findings changed status between runs.

### FR-6: Export Findings Report

- **Description:** User can export the findings report as a standalone document.
- **User value:** Personal QC recordkeeping; something to reference or keep for their own files.
- **Business value:** Reinforces the "supplementary aid, not appraiser-of-record" positioning (Manifesto, Legal Risks Section 23 of the Company Bible) by producing a clearly separate document, never merged into the appraisal report itself.
- **Success criteria:** Exported file is legible, correctly attributes findings to the reviewed report/date, and is clearly distinct in format/branding from an appraisal report itself (never mistakable for part of the deliverable).

### FR-7: Account and Data Management

- **Description:** User can manage their profile, and request deletion of their account and associated data.
- **User value:** Control over sensitive client data; supports honest answers to their own clients about data handling (Company Bible Section 25).
- **Business value:** Baseline trust requirement for a category handling sensitive client financial data; reduces legal exposure.
- **Success criteria:** Deletion requests are unambiguous, confirmed, and result in verifiably removed data within a stated timeframe.

---

## 12. Non-Functional Requirements

- **Reliability:** The review pipeline must not silently fail — every failure is surfaced to the user with a clear next step (Section 22).
- **Consistency:** Deterministic checks (Section 14) must produce identical results on identical input, every time, with no run-to-run variance.
- **Trustworthiness of confidence labeling:** The distinction between deterministic and model-based findings (Section 20) must be accurate and never blurred for the sake of a cleaner UI.
- **Data handling integrity:** Uploaded files are never modified; original files remain retrievable/exportable by the user unchanged.
- **Auditability:** Every action a user takes on a finding (acknowledge/dismiss + reason) is recorded with a timestamp, forming a QC audit trail the user owns.
- **Usability under time pressure:** Every screen in Section 8 must be usable by a tired professional at night, without requiring onboarding/tutorials to understand core actions.

---

## 13. AI Review Workflow

This section defines the workflow for review categories that require language understanding rather than exact matching (see Section 18 for which categories these are — narrative contradiction detection, missing-assumption detection, and similar).

1. **Input assembly:** The relevant extracted text (narrative sections, relevant grids/tables as text) is assembled for a given check category.
2. **Structured check execution:** The AI is prompted with a specific, narrow check (e.g., "does the stated property condition in the narrative section conflict with the stated property condition in the improvement description grid") — never an open-ended "review this whole report" instruction. Narrow, category-specific prompting is required so that findings stay falsifiable and category-labeled (Manifesto 0.2, Company Bible Section 4).
3. **Evidence extraction requirement:** Any AI-produced finding must include the specific quoted or paraphrased locations being compared, in a form the user can verify directly against their own document. A finding without extractable evidence is not surfaced to the user — it is discarded, not shown as a vague flag.
4. **Confidence labeling:** Every AI-produced finding is labeled as "model-based" (Section 20) and must never be presented with the same visual weight/certainty as a deterministic finding.
5. **Judgment-boundary check (mandatory, non-negotiable step):** Before any AI-produced finding is surfaced, it is checked against Manifesto Section 0.4's boundaries — does this finding, even inadvertently, imply a view on value, a cap rate, or an adjustment's correctness? If yes, it is rejected/rewritten to describe only the _inconsistency_, never the _correctness_. This is a permanent workflow step, not a one-time launch check — it applies to every single AI-based finding, every run.
6. **Output:** A structured finding object (category, severity, confidence, description, evidence, location) is added to the review's findings set alongside deterministic findings.

---

## 14. Deterministic Review Workflow

This section defines the workflow for review categories that can be checked with exact matching, parsing, or arithmetic rather than language inference (e.g., cross-document name/address/date consistency, arithmetic re-verification, template leftover detection).

1. **Structured extraction:** Relevant values (names, addresses, dates, numeric figures, known placeholder patterns) are extracted from the document wherever they are structurally identifiable.
2. **Exact comparison / recalculation:** Values are compared across locations for exact or acceptably-normalized matches (e.g., "123 Main St." vs "123 Main Street" may be treated as equivalent by normalization rules; underlying arithmetic is recalculated directly rather than inferred).
3. **No language-model judgment involved in this workflow.** Deterministic checks never call an AI model to "decide" whether something matches — that is precisely why they can be labeled with high confidence (Section 20).
4. **Output:** A structured finding object identical in shape to the AI workflow's output (category, severity, confidence = "deterministic," description, evidence, location), so both workflows feed one unified findings experience for the user.

---

## 15. Report Lifecycle

Describing the lifecycle of the uploaded report artifact itself (not the review process, covered in Section 16):

1. **Uploaded** — file received, stored, associated with the user's account.
2. **Being Processed** — actively undergoing extraction/review (see Section 16 for the review's own lifecycle, which runs during this state).
3. **Reviewed** — review complete, findings available; report file remains accessible/exportable in its original, unaltered form.
4. **Superseded** — a revised version of the same engagement has been uploaded and reviewed; the prior version and its findings remain viewable for history/comparison, but are marked as superseded, not deleted.
5. **Deleted** — user-initiated removal; permanently removes the file and associated data per the account/data deletion requirements (Section 8.9, Section 11 FR-7).

The uploaded report is never modified at any point in this lifecycle — this is a permanent constraint (Manifesto 0.4.5), not a v1.0-only limitation.

---

## 16. Review Lifecycle

Describing the lifecycle of a single review run against an uploaded report:

1. **Queued** — review requested, not yet started.
2. **Processing** — actively running deterministic and AI workflows (Sections 13–14).
3. **Complete** — findings set finalized and available to the user.
4. **Failed** — review could not complete (e.g., unreadable file); user is notified with a specific reason and a retry path (Section 22); no partial/misleading findings are ever shown from a failed run.
5. **Cancelled** — user-initiated cancellation while Processing; no findings are generated or shown.

A review is always tied to exactly one uploaded report version. A re-review on a revised draft is a new review, linked to the prior review for comparison purposes (Section 8.7), never an in-place mutation of the original review.

---

## 17. Findings Lifecycle

Describing the lifecycle of an individual finding within a completed review:

1. **Open** — generated by the review, not yet actioned by the user. Default state.
2. **Acknowledged** — user has seen it and intends to address it in the report (no reason required, since this is not a disagreement with the finding).
3. **Dismissed** — user has determined it is not a real issue; requires a reason (Section 11, FR-4). Dismissal reasons are retained data (used for product-quality measurement per Company Bible Section 15/16, never sold or repurposed beyond that stated use, per Company Bible Section 25).
4. **Carried Forward** — on a re-review, a finding whose underlying condition still exists is shown as still-open, retaining its prior status if it was previously acknowledged/dismissed (the user should not have to re-triage something they already handled, unless the underlying evidence changed).
5. **Resolved** — on a re-review, a finding whose underlying condition no longer exists (e.g., the mismatch was fixed) is marked resolved and shown in the comparison view (Section 8.7), not silently removed — visibility into what was fixed is itself valuable confirmation for the user.

---

## 18. Review Categories

Directly derived from Company Bible Section 8 ("Problems We Solve") and the founder's Phase 1 instruction. Each category is tagged with its primary workflow type (Deterministic per Section 14, or Model-Based per Section 13).

1. **Cross-document identity consistency** _(Deterministic)_ — client name, property name, address, and effective date matched across every location they appear in the document.
2. **Template leftover detection** _(Deterministic, pattern-based)_ — unresolved placeholders, bracketed instructions, obviously mismatched boilerplate (e.g., a prior client's name appearing once amid otherwise-consistent current-client references).
3. **Internal arithmetic verification** _(Deterministic)_ — recalculation of extractable numeric totals (income approach math, grid adjustment totals, reconciliation figures) against what the narrative/grid states, wherever the underlying figures are extractable from the document or supporting Excel file.
4. **Narrative-to-data contradiction detection** _(Model-Based)_ — conflicts between descriptive narrative statements and structured data elsewhere in the report (e.g., stated condition, stated highest-and-best-use conclusion vs. stated zoning).
5. **Missing standard assumptions/limiting conditions detection** _(Model-Based, checked against a defined checklist of commonly-required elements)_ — flags likely omissions, never asserts with certainty that USPAP compliance has been fully verified (that determination remains the appraiser's professional responsibility, stated explicitly in the product's own disclaimers).
6. **Missing supporting documentation references** _(Deterministic where possible — e.g., "see Addendum C" with no addendum present; Model-Based where inferential, e.g., a referenced comp not appearing in the grid)_.
7. **Typo and formatting inconsistency detection** _(Deterministic/pattern-based)_ — lowest severity category by default (Section 19), included because of its effect on document credibility (Company Bible Section 8).

Each category maps to a specific, named checklist item internally — "internal consistency" is never treated as one vague catch-all check, consistent with Manifesto 0.2's requirement that every check be mechanical and falsifiable.

---

## 19. Severity Levels

Three levels, applied consistently across all categories:

- **Critical** — findings likely to cause material harm if undelivered corrected: arithmetic errors affecting a stated value-relevant figure, wrong client/property name, wrong address, contradictions in a value-relevant conclusion (e.g., condition or HBU contradictions that could affect approach selection).
- **Moderate** — findings that are real problems but less likely to be value-relevant or client-facing-embarrassing on their own: missing a standard assumption, an unreferenced addendum, an internal inconsistency in a non-critical section.
- **Low** — cosmetic/credibility issues: typos, minor formatting inconsistencies, boilerplate leftovers in clearly non-substantive sections.

Severity is assigned per finding, by category default plus specific evidence (e.g., a typo in a client-facing cover letter's client name field is escalated beyond "Low" because of category 1's cross-document identity stakes, even though "typo" sounds cosmetic). Severity logic must be documented per category so triage is explainable, not opaque (Manifesto 0.2).

---

## 20. Confidence Levels

Two levels, mapped directly to the two workflows in Sections 13–14:

- **Deterministic** — the finding is the result of exact matching or recalculation. Presented to the user as a fact, with the specific evidence shown ("these two values do not match; here is the arithmetic").
- **Model-Based** — the finding is the result of AI-assisted language inference. Presented to the user with visibly different framing ("this may be a conflict — worth a second look") and never with the same visual certainty as a deterministic finding, regardless of how confident the underlying model output happens to be. This label is permanent and may never be blended away for UI simplicity (Manifesto 0.4.4, 0.7).

There is no numeric confidence score (e.g., "87% confident") in v1.0 — a bare number implies false precision about something that is fundamentally a language-inference judgment call, and is explicitly rejected as a UI pattern for this reason.

---

## 21. Notification Requirements

- **Review completion notification:** User is notified (in-app at minimum; email if the user has left the Processing screen) when a review completes, fails, or is cancelled — since Processing may take minutes and the user is not required to wait on-screen (Section 8.4).
- **No marketing/engagement notifications disguised as product notifications** — consistent with the "second reader, not a colleague with opinions" tone (Manifesto 0.5); notifications are strictly functional (review status), not "we miss you, come back" messaging.
- **Destructive-action confirmations are not notifications** — they are in-flow confirmations (Section 8.9), handled synchronously, not as a follow-up notification.

---

## 22. Error Handling

General principle, restated from Manifesto/Company Bible: **no silent failures, ever.** Every error state defined per-screen in Section 8 follows these shared rules:

- Every error message states what happened and what the user can do next — never a bare "Something went wrong."
- File-related errors (unsupported format, corrupted file, password-protected file, unreadable scan) are distinguished from system errors (server/processing failure) so the user knows whether the problem is their file or the product.
- A failed review never produces partial, silently-incomplete findings presented as if complete — a partial failure is a failed review, full stop, with an explicit retry path.
- Data-loss-risk actions (deletion, dismissing without saving a reason) always require explicit confirmation before proceeding.

---

## 23. Export Requirements

- The findings report can be exported as a standalone PDF.
- The export is visually and structurally distinct from an appraisal report — includes clear headers identifying it as a "Pre-Delivery Review — Findings Summary," the reviewed report's file name/date, and a persistent disclaimer restating the product's boundary (does not determine value, is a supplementary QC aid, not a substitute for professional review) — this disclaimer is mandatory on every export, not optional boilerplate (Company Bible Section 23, Manifesto 0.4).
- The export includes: all findings with their category/severity/confidence/status, the user's own acknowledge/dismiss decisions and reasons (forming the user's own QC audit trail), and the date/time of the review.
- The original uploaded report file itself is also exportable/downloadable unchanged, separately from the findings report.

---

## 24. Performance Targets

- **Upload to review completion:** under 5 minutes for a typical narrative report (defined as up to ~75 pages of narrative text plus standard grids, for v1.0 planning purposes — this is a working definition, not a hard technical spec, and may be revised once real report samples are processed).
- **Findings Report screen load:** near-instant (sub-2-second) once a review is marked Complete, since review computation happens during Processing, not on-demand at view time.
- **Dashboard load:** fast enough not to feel like a wait for a modest history size (tens of reviews) typical of a solo appraiser's early usage.

These are product-experience targets for design and engineering to plan against — not committed SLAs to be published externally at this stage.

---

## 25. Accessibility Requirements

- All screens must be usable via keyboard navigation (a professional tool used under deadline pressure benefits everyone from fast, non-mouse-dependent interaction, not only users who require it).
- Sufficient color contrast for severity/confidence labeling — severity and confidence must not rely on color alone (e.g., "Critical" is never conveyed by red color alone; it is also labeled in text), since color-only signaling fails both accessibility and quick-scan usability under bad lighting/fatigue conditions.
- All interactive elements (buttons, filters, finding status controls) must have accessible labels for assistive technology.
- Export outputs (Section 23) must be text-based/selectable, not flattened images, so exported findings remain screen-reader accessible.

---

## 26. Security Requirements

Product-level requirements (implementation mechanisms belong to a future architecture document, not this PRD):

- Only the account owner can ever view their own uploaded reports and findings — no cross-account visibility of any kind in v1.0's single-user model.
- Authentication failures never reveal whether a given email address has an existing account (Section 8.1).
- Users must be able to permanently delete their account and all associated uploaded files and findings data, with clear confirmation of what is and is not retained (Section 8.9).
- All file uploads are treated as potentially sensitive client financial data by default — no feature in v1.0 may repurpose uploaded content for any use beyond producing that user's own findings report (Company Bible Section 25).
- The product must never expose, in any UI, log, or export visible to the user, another user's data, even in aggregate/anonymized form, in v1.0 (no cross-customer benchmarking features exist yet — see Section 27).

---

## 27. Future Features (clearly separated from v1.0 scope)

These are directionally consistent with the Company Bible's roadmap (Sections 13–14) and Manifesto Section 0.6, but are explicitly **not** part of v1.0 and must not be built now:

- **Multi-user firm accounts** with role-based access (Owner/Appraiser/Reviewer), review queues, and firm-level oversight — serves the "Maria" and "Rita" personas fully (Company Bible Section 13, item 2).
- **Direct Excel valuation model parsing** for higher-confidence arithmetic checks beyond what's extractable from narrative/grid text alone (Company Bible Section 13, item 3).
- **Re-run diffing UX enhancements** beyond the basic resolved/open/new comparison already specified in v1.0 (Section 8.7) — e.g., visual side-by-side document diffing.
- **Firm-level quality analytics** (aggregate finding patterns per appraiser, for coaching) — requires the multi-user foundation above and careful framing to avoid punitive-surveillance perception (Company Bible Section 14).
- **Formal authoring-tool integrations** (e.g., a Narrative1 partnership/plugin) — deferred until standalone value and leverage are proven (Manifesto 0.6.2, Company Bible Section 13 item 5).
- **Global search across all past reviews/findings** for higher-volume users.
- **Adjacent document types** (environmental reports, lender due-diligence packages, litigation exhibits) — deferred until the appraisal-report review engine is proven (Manifesto 0.6.3).

---

## 28. Out-of-Scope Features

Distinct from "Future" — these are not on any roadmap and are explicitly rejected as inconsistent with the Manifesto, not merely deprioritized:

- Any feature that determines, suggests, ranges, or scores market value, cap rates, discount rates, or adjustments.
- Any feature that auto-generates appraiser narrative content by default or without an explicit, clearly separate, clearly labeled invocation.
- Any feature that auto-corrects or auto-edits the uploaded report file.
- Any numeric "confidence score" or "quality score" presented as a single overall number for a report (this would function as a disguised value/quality judgment, contrary to Manifesto 0.4).
- Any feature that harvests uploaded report data to build a separate comp/market-data product without explicit, separate, informed opt-in (Company Bible Section 25).
- Any AI persona, name, or anthropomorphized "reviewer character" in the product (Manifesto 0.5).

---

## 29. Acceptance Criteria

v1.0 is considered feature-complete and ready for real-user testing when all of the following are true:

1. A new user can sign up, upload a real narrative report, and receive a findings report without any assistance, within the performance target in Section 24.
2. Every finding shown meets the falsifiability bar in Manifesto 0.2 — location-specific, one-sentence explainable, verifiable by the user in under 10 seconds.
3. Every finding is correctly labeled Deterministic or Model-Based (Section 20), and no finding of either type implies a judgment on value, cap rate, or adjustment correctness (verified against Manifesto 0.4 as an explicit QA pass, not assumed).
4. A user can acknowledge or dismiss every finding, with dismissal requiring a reason, and this status is correctly retained and reflected on a re-review of a revised draft (Sections 15–17).
5. A user can export a findings report that is visually and textually distinct from an appraisal report, carrying the mandatory disclaimer (Section 23).
6. No error state in the product is silent — every failure mode defined in Section 8's per-screen error states has a real, working, tested message and next action (Section 22).
7. No cross-account data leakage is possible — verified by explicit testing, not assumed from architecture alone (Section 26).
8. A user can permanently delete their account and data, and the deletion is verifiably complete (Sections 8.9, 26).
9. Every requirement in Section 28 (Out-of-Scope Features) is confirmed absent from the shipped product — this list is used as a negative test checklist, not just a planning note.

---

_End of PRD v1.0. Governed by Chapter 0 — The Manifesto and the Company Bible. Do not proceed to architecture, schema, or implementation planning by amending this document — a new phase document should be created that treats this PRD as a fixed input, consistent with the project's stated phase discipline._
