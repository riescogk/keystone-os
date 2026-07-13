# COMPANY BIBLE

## [Company Name TBD] — The Intelligence Layer for Commercial Real Estate Valuation

**Document status:** Living document. Version 1.0. Owned by founder. Revised only through explicit decision, never silently.
**Last updated:** Phase 0.

---

## 1. Company Vision

Commercial real estate appraisal is a $100B+ decision-making industry that still ships its highest-stakes work product — a signed valuation opinion relied on by lenders, courts, and institutional investors — through a workflow whose final quality control step is a tired human reading their own 60-page document at 11pm before a deadline.

Our vision: **every appraisal report that leaves an appraiser's desk has been checked by a system that never gets tired, never skims, and never assumes the client name on page 40 matches the client name on page 1.**

We are not trying to replace the appraiser. We are not trying to replace Narrative1, ClickForms, ACI, or any report-writing platform. We are building the layer that sits on top of the appraiser's finished work and catches what humans structurally miss — because humans are bad at proofreading their own long, numeric, cross-referenced documents, and no amount of experience fixes that. This is a known, named, universal cognitive limitation (proofreading blindness / familiarity blindness), not a skill gap.

Long-term, we believe every professional service industry that produces long, numeric, legally-relied-upon documents under deadline pressure will adopt an AI review layer as a mandatory step before delivery — the way spell-check became mandatory, the way linters became mandatory in software engineering. We intend to own that layer for commercial real estate valuation first, then expand to adjacent high-stakes document workflows (eventually: environmental reports, lender due diligence packages, litigation valuation exhibits) once we have proven the core loop in appraisal.

**The operating system framing**: an "operating system for CRE valuation" does not mean we build every tool. It means every tool in the ecosystem — Narrative1, ClickForms, comp databases, lender portals — eventually assumes our review layer sits between "report drafted" and "report delivered," the same way a compiler assumes a linter might run first. We get there by being excellent at one narrow thing first, not by building broadly.

---

## 2. Mission

**Catch the mistake before the client does.**

Give every commercial appraiser a second set of eyes — available in minutes, not billable hours — that reviews a finished draft report for internal inconsistency, calculation error, narrative contradiction, leftover template artifacts, and mismatched identifying data, before that report is delivered to a client, lender, or court.

---

## 3. Core Values

1. **The appraiser is always right about value.** We never opine on market value, cap rate selection, comp adjustments, or reconciliation weighting. We flag; the appraiser decides. This is not a legal disclaimer bolted on after the fact — it is the product's actual design boundary, enforced in the UI, the AI prompting, and the output format.
2. **False confidence is worse than no product.** A review tool that says "looks good" and misses a six-figure math error is actively dangerous — it launders the appraiser's liability through our brand. We would rather flag too much (with clear severity levels) than too little.
3. **Boring, verifiable checks beat impressive, unverifiable ones.** A check that says "this number doesn't add up, here's the arithmetic" is worth more than a check that says "this seems off" with no shown reasoning. Every flag must be explainable in one sentence a human can verify in under 10 seconds.
4. **We are a tool, not a colleague.** We do not anthropomorphize the AI reviewer in the product ("Claude thinks...", "our AI believes..."). It produces findings, not opinions. This protects both the appraiser's professional standing and our own liability position.
5. **Speed matters because deadlines are real.** An appraiser reviewing this tool's output at 11pm before a morning delivery is our actual, primary use case. Every design decision is filtered through "does this help at 11pm under deadline pressure," not "is this impressive in a demo."
6. **We earn trust incrementally.** We do not ask an appraiser to trust us with their whole workflow on day one. We ask them to trust us with one narrow, low-risk, high-value check first (e.g., "does every instance of the client name match"), prove it's reliable, then expand scope.

---

## 4. Product Philosophy

- **Review, not generation.** The first product never writes appraiser content. It reads finished or near-finished drafts and produces a findings list. Generation is a categorically different liability and trust profile than review, and we are not ready for it — and may never need to be, if review alone is the wedge.
- **Deterministic checks first, probabilistic checks second.** Wherever a check can be done with regex, parsing, or arithmetic (address consistency, date math, sum totals, cross-page name matching), we do it that way — not with an LLM guess. LLM-based checks (narrative contradiction, missing assumption detection) are reserved for things that genuinely require language understanding. This keeps our false-positive rate low and our explainability high.
- **Every finding is falsifiable.** A finding without a specific location (page, paragraph, cell) and a specific reason is not shippable. "Something seems inconsistent" is not a finding. "Client name on cover page reads 'Meridian Capital LLC'; client name on page 34 signature block reads 'Meridian Capital Partners LLC'" is a finding.
- **Severity is a first-class concept, not an afterthought.** A typo in a boilerplate paragraph is not the same severity as a $2M arithmetic error in the income approach. Findings are triaged so the appraiser's attention goes where it matters most in the time they have.
- **The product's job ends at the finding. The appraiser's job is the fix.** We do not auto-correct anything in v1. Auto-correction of someone else's signed professional opinion is a trust and liability line we do not cross casually, if ever.

---

## 5. Target Customer

**Primary (MVP):** Independent commercial appraisers and small appraisal firms (1–15 appraisers) in the United States who produce narrative appraisal reports for lending, litigation, tax appeal, or estate purposes, typically using Narrative1, ClickForms, ACI, or Microsoft Word/Excel templates.

**Why this segment first:**

- They own their own QC process (no large firm compliance department doing this already).
- They feel deadline pressure personally and immediately — the founder-fit and urgency is highest here.
- They are price-sensitive but time-starved, meaning a tool that saves 30–60 minutes of manual proofreading per report has obvious, immediately felt ROI.
- They are reachable via appraiser associations, state coalitions, and word of mouth — no enterprise sales cycle required to get first customers.

**Explicitly not the primary target at MVP:** national AMCs, big-four valuation groups, bank-internal review departments. These are larger, slower-moving, procurement-heavy buyers we may reach later once we have proof points from independents.

---

## 6. Customer Personas

### Persona 1 — "Deadline Dave," Solo Appraiser

- 15 years experience, MAI candidate or designated, does 8–12 reports/month, mostly lending assignments.
- Writes reports in Narrative1 nights and weekends between site visits.
- His current QC process: reads the report himself the night before delivery, sometimes has his spouse or a colleague skim it as a favor.
- Pain: he has been burned before — a wrong client name in a signature block, a typo in an address, a cap rate that didn't match between the narrative and the grid — and it cost him an awkward client call or a resubmission.
- What he wants: something fast, cheap, that catches the dumb mistakes he's too close to his own document to see, without asking him to change how he writes reports.

### Persona 2 — "Managing Partner Maria," Small Firm Owner (4–8 appraisers)

- Runs a firm, reviews every junior appraiser's report before it goes out the door, because she is the one whose license/reputation is ultimately on the line.
- Her current QC process: manual review of every report, which does not scale — she is the bottleneck on firm growth.
- Pain: she cannot hire fast enough to keep up with review load; junior appraisers make more of the exact mistakes this product catches (template leftovers, mismatched names, unresolved placeholder text).
- What she wants: a first-pass filter so she only spends her personal review time on judgment calls (is this cap rate defensible?) rather than on catching "the property address says Oak Street on page 2 and Elm Street on page 11."

### Persona 3 — "Review Department Rita," Internal QC at a mid-size firm (future, not MVP)

- Dedicated reviewer role, reviews reports from 10+ appraisers before delivery.
- Pain: same as Maria but at higher volume, more formalized.
- Relevant later, once we have a firm-level product and role-based access; not the wedge customer.

---

## 7. Market Opportunity

- There are roughly 15,000–20,000 state-certified general/residential commercial appraisers in the US (Appraisal Institute + state licensing board aggregate figures; exact figure to be verified via primary source before using in any external materials — flagged as unverified estimate, not a claim).
- Independent appraisers and small firms represent the majority of that population by headcount, though large AMC-affiliated firms represent a larger share of report _volume_.
- The adjacent, better-known comparison point is legal-document review software (e.g., contract review AI) and accounting workpaper review tools — both categories that did not exist as "AI review" products five years ago and now have venture-scale companies, because the underlying pattern (long, numeric/legal, liability-bearing documents, reviewed under deadline) is the same pattern we are targeting in appraisal.
- We are not sizing this market by "how many appraisers could buy a review tool" alone — we are sizing it by "how many long-form liability-bearing valuation documents are produced per year that currently get zero automated review," because that number determines both TAM and the long-term OS vision (once appraisal review works, the same review engine architecture applies to environmental reports, lender due diligence memos, etc.).

_(This section should be revisited in Phase 1 planning with actual primary-source market sizing before it's used in any investor-facing material. Flagging clearly: the numbers above are order-of-magnitude estimates for internal planning only.)_

---

## 8. Problems We Solve

1. **Cross-document consistency failures.** Client name, property name, address, and effective date often appear 10–40+ times across a report (cover letter, certification, cover page, engagement letter reference, grid headers, photo captions, addenda). Humans do not reliably catch a mismatch introduced by copy-paste from a prior report template.
2. **Template leftover artifacts.** "[INSERT PROPERTY NAME]", "XXXXX", a prior client's name accidentally left in a boilerplate paragraph, a placeholder cap rate that was never updated — extremely common in narrative reports built from prior report templates, and extremely embarrassing when a client finds them instead of the appraiser.
3. **Internal arithmetic errors.** Income approach math (NOI calculations, cap rate application, discounted cash flow totals), sales comparison grid adjustment totals, reconciliation weighting — these are frequently done in Excel and pasted into Word as static text/images, meaning a later correction in Excel does not propagate to the narrative, producing a silent contradiction.
4. **Narrative-to-data contradictions.** The narrative text says "the subject is in average condition" while the improvement description grid says "good condition, renovated 2022." The highest and best use conclusion in the narrative doesn't match the zoning stated in the site description.
5. **Missing required assumptions/limiting conditions.** USPAP and client-specific requirements often require specific extraordinary assumptions or hypothetical conditions to be stated; reports sometimes omit a condition that was verbally discussed with the client but never written down, or state one assumption in the letter of transmittal and a different one in the certification.
6. **Missing supporting documentation references.** The report references "see Addendum C" for a document that isn't actually in the addenda, or references a comp that doesn't appear in the comp grid.
7. **Typos and formatting inconsistencies** that, while individually low-severity, collectively signal a lack of polish to a client, lender, or opposing counsel in litigation — where credibility of the whole document can be undermined by sloppy surface-level errors.

---

## 9. Problems We DO NOT Solve

Stated explicitly, because a review tool that overreaches into judgment territory is a liability, not a feature.

- We do not determine, suggest, validate, or opine on market value.
- We do not select or validate cap rates, discount rates, or comparable adjustments as being "correct" — we may flag that a cap rate appears inconsistent between two locations in the same document, but we never say what the "right" cap rate should be.
- We do not verify facts against the outside world (we do not confirm an address exists, confirm a comp actually sold at the stated price, or confirm zoning — that requires external data verification, a different and later product, not the review-layer wedge).
- We do not replace USPAP compliance review by a qualified reviewer/appraiser — we are a supplementary automated pass, not a substitute for the professional judgment USPAP requires.
- We do not generate report narrative content in v1.
- We do not integrate directly into Narrative1's editor in v1 (file-based ingestion only at MVP — see Product Positioning).
- We do not store or process data in a way that creates a claim of being "the appraiser of record" or co-author — our output is explicitly a QC findings report, never part of the appraisal report itself.

---

## 10. Competitive Analysis

| Competitor / Category                                         | What they do                                                                                                     | Why they are not us                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Narrative1**                                                | Report writing/drafting platform — templates, data entry, narrative assembly.                                    | This is the tool we sit on top of, not compete with. They own creation; we own review.                                                                                                                                                                                                                                            |
| **ClickForms / ACI**                                          | Form-based report software, primarily residential-leaning but used in some commercial contexts.                  | Same category as Narrative1 — authoring tool, not review tool.                                                                                                                                                                                                                                                                    |
| **Manual peer review (status quo)**                           | A colleague, partner, or the appraiser themselves re-reads the report.                                           | Slow, inconsistent, subject to the exact "too close to your own work" blindness we exist to solve, doesn't scale with firm growth.                                                                                                                                                                                                |
| **General-purpose AI (ChatGPT/Claude used ad hoc)**           | Some appraisers already paste sections of reports into general AI chat tools to "check" them.                    | No domain-specific structured checklist, no severity triage, no cross-document consistency engine, no audit trail, no liability-appropriate output format, and real client-confidentiality/data-handling risk from pasting client financials into a consumer chat tool with no BAA-equivalent or usage terms suited to this data. |
| **Big-firm internal QC software (proprietary, AMC-internal)** | Some large AMCs and lenders have internal proprietary checklists/software for reviewing appraisals they receive. | Built for the _recipient_ of a report (lender-side QC), not the _producer_ (appraiser-side, pre-delivery). Different buyer, different moment in the workflow, generally not sold as a product to independent appraisers.                                                                                                          |
| **Grammarly / generic proofing tools**                        | Catches spelling/grammar.                                                                                        | Zero domain understanding — cannot catch a cap rate mismatch, a wrong client name in a certification, or a missing extraordinary assumption.                                                                                                                                                                                      |

**Our actual competitive moat, stated honestly:** it is not the AI model (any competitor can call an LLM). It is (1) the domain-specific structured checklist encoding what actually goes wrong in CRE narrative reports, refined over real report volume, (2) the deterministic-check layer that catches what LLMs are unreliable at (exact arithmetic, exact string matching) so our findings are trustworthy rather than "AI vibes," and (3) trust and distribution within the appraiser community, which is a relationship-driven, word-of-mouth market that rewards being early and being right, not being loudest.

---

## 11. Why Existing Software Fails at This

- **Authoring tools (Narrative1, ClickForms) are not incentivized to build a rigorous review layer** — their business is report creation/throughput, and a strict QC layer that surfaces the authoring tool's own template-leftover problems is not a natural feature for the authoring vendor to prioritize.
- **General AI chat tools lack structure.** A one-off prompt to "check this report" has no persistent checklist, no severity model, no way to verify the AI actually checked every required category, and no output format an appraiser can act on quickly under deadline pressure. It also creates confidentiality exposure that a purpose-built, appropriately-scoped tool is designed to avoid.
- **Manual review does not scale and is not objective.** A human reviewer's attention is finite and inconsistent report-to-report; a systematic checklist, run the same way every time, does not get tired on the 40th page.
- **No existing tool treats "internal consistency" as a first-class, structured problem.** Spell-checkers check words. Authoring tools check that required fields are filled. Nothing currently cross-references "does the client name in the cover letter match the client name in the certification" as a discrete, always-run check.

---

## 12. Product Positioning

**We are not an appraisal platform. We are the QC step before delivery.**

Positioning statement: _"For commercial appraisers who deliver narrative reports under deadline pressure, [Product] is the AI-powered second set of eyes that catches inconsistencies, math errors, and leftover mistakes before your client does — without ever telling you what the value should be."_

We position explicitly _against_ AI-writes-your-report positioning, because:

1. It is a smaller, safer, more defensible trust claim ("we check" vs. "we know the value").
2. It avoids the regulatory and liability gray zone of AI-generated valuation opinions.
3. It is the _correct_ wedge into a market whose gatekeepers (state boards, USPAP, E&O insurers) are actively wary of AI replacing appraiser judgment — we position as the tool that protects the appraiser's judgment from embarrassing, avoidable mistakes, not as a threat to it.

Ingestion positioning at MVP: **file-based, not embedded.** The appraiser exports/uploads their near-final report (Word/PDF, plus supporting Excel grids if available) into our system; we do not require live integration into Narrative1's editor. This is deliberately the lowest-integration-risk entry point — no partnership dependency, no API access requirement, works with any authoring tool the appraiser already uses.

---

## 13. Long-Term Roadmap

_(Directional, not committed — revised as we learn. Ordered by dependency, not calendar time.)_

1. **Review layer for a single report, file-upload based** (the MVP wedge — this document's Phase 1+ builds toward this).
2. **Firm-level review** — Managing Partner Maria persona: multiple appraisers, a review queue, role-based access, aggregated findings-quality metrics per junior appraiser (coaching tool, not punitive surveillance — framing matters here).
3. **Deeper structured-data ingestion** — direct parsing of Excel valuation models (not just the narrative document) so calculation checks become exact rather than inferred from text.
4. **Historical pattern learning per firm** — "this firm's reports commonly have X type of leftover error" to prioritize checks per customer, without ever crossing into "we know your market value" territory.
5. **Integration partnerships** — potential formal integration with Narrative1 or similar authoring tools once we have proven standalone value and have leverage/credibility to propose it, not before.
6. **Adjacent document types** — environmental reports, lender due-diligence packages, litigation valuation exhibits — same review-engine architecture, new domain checklists.
7. **The "operating system" layer** — once review is trusted and embedded in appraiser workflow, become the connective layer other CRE valuation tools plug into (comp data providers, report authoring tools, lender delivery portals) for pre-delivery QC as a standard, expected step.

Explicitly not on this roadmap unless a future version of this document adds it: AI-generated valuation opinions, AVM, marketplace/lead-gen for appraisers, residential appraisal.

---

## 14. Feature Roadmap (Product, not engineering — engineering sequencing comes in later phases)

**MVP (v1):**

- Upload a finished/near-final report (PDF/DOCX) + optional supporting Excel.
- Automated checks: name/address/date cross-document consistency, template leftover detection, basic arithmetic re-verification where numbers are extractable, narrative-to-grid contradiction detection (LLM-assisted), missing standard sections/assumptions detection.
- Findings report: severity-tagged, page/location-referenced, exportable.
- Single-user, single-firm account (no complex roles yet).

**v1.1–v1.x (near-term):**

- Support for the appraiser marking findings as "reviewed/dismissed" with a reason (creates an audit trail and reduces re-flagging the same accepted item across revisions).
- Re-run review on a revised draft, diffed against the prior run.
- Excel grid direct parsing (not just narrative text) for higher-confidence arithmetic checks.

**Later (firm-tier):**

- Multi-user firm accounts, review queues, role-based access (Owner/Appraiser/Reviewer).
- Aggregate quality metrics across a firm's appraisers (for coaching, not punitive use — this needs careful product framing and will get its own section in a later phase).

---

## 15. Success Metrics

- **Time-to-first-value**: an appraiser uploads their first report and receives a findings report within [target: under 5 minutes] — this is the single most important early metric, because the entire value proposition is "faster than you re-reading it yourself."
- **Finding precision**: percentage of flagged findings the appraiser marks as "valid/useful" vs. "false positive, dismissed." This is the core trust metric and must be tracked from day one.
- **Retention**: percentage of appraisers who upload a second report within 30 days of their first (proxy for "did this actually save them time/embarrassment").
- **Word-of-mouth signal**: unprompted referrals within appraiser associations/forums — this market moves on trust and reputation, and organic mentions are a stronger signal than paid acquisition metrics at this stage.
- **Severity-weighted catch rate** (harder to measure, worth building toward): of reports where the appraiser later confirms a real mistake existed, what fraction did we catch before delivery vs. the client/lender catching it after.

---

## 16. Failure Metrics — signals we are failing, watched deliberately

- **High false-positive rate reported qualitatively** ("it just flags noise, I ignore the report") — this kills trust faster than almost anything else and must be treated as a critical bug, not a tuning nit.
- **Appraisers uploading once and never returning.**
- **Appraisers using it only for the "easy" checks (typos) and explicitly distrusting the "hard" checks (narrative contradiction)** — a signal our LLM-based checks need better explainability or are genuinely not reliable enough yet.
- **Any incident where a real, material error passed through undetected and the appraiser had reasonably relied on our tool as their final check** — this is not just a metric, it's a triggered postmortem event (see Legal Risks, Section 23).
- **Support/complaint volume centered on confidentiality/data-handling concerns** — given the sensitivity of client financials, this is an early trust make-or-break signal, not a normal support-ticket category.

---

## 17. Revenue Model

- **Per-seat SaaS subscription** (monthly/annual), priced per appraiser license, is the default model for the MVP — matches how independent appraisers already buy Narrative1/ClickForms-style tools, and is simplest to build, bill, and explain.
- **Usage-based add-on (per-report)** is a plausible alternative or hybrid worth testing once we have real usage data — appraisers with lumpy monthly volume may prefer paying per report reviewed rather than a flat seat fee. Not committed at MVP; flagged for pricing-phase experimentation (Section 18).
- **Firm-tier pricing** (multiple seats + admin/review-queue features) is the natural expansion path once the firm persona (Maria) is served, priced at a premium per seat over solo pricing given the added management value.
- Explicitly **not** modeled at MVP: revenue share with authoring-tool partners, data-licensing revenue, or marketplace/lead-gen revenue — all premature before core product-market fit.

---

## 18. Pricing Hypothesis (to be tested, not assumed correct)

- **Hypothesis**: an independent appraiser will pay somewhere in the range of a mid-tier SaaS tool (comparable to what they already pay for report-writing software add-ons) per month for unlimited or generously-capped report reviews, because the cost of a single embarrassing client-facing mistake (redo time, reputational damage, potential E&O exposure) vastly exceeds a monthly subscription fee.
- **We will not lock in a specific dollar figure in this document** — pricing is a Phase-appropriate-later decision validated with actual prospective customers, not a number invented in Phase 0. Flagging this explicitly rather than fabricating false precision.
- **Free trial or first-report-free** is a likely necessary go-to-market mechanic given the trust-building nature of this product category — appraisers will reasonably want to see real findings on a real report before paying, especially from an unknown/early-stage vendor.

---

## 19. Go-To-Market Strategy

- **Primary channel: appraiser communities, not paid ads.** State appraisal coalitions, Appraisal Institute chapter meetings/forums, LinkedIn groups where independent appraisers discuss tools and pain points. This is a trust-driven, relationship-driven professional market.
- **Wedge tactic: free/low-friction first review.** Let a skeptical appraiser upload one real (or redacted/sample) report and see actual findings before any commitment — the product's value is immediately self-evident in a way that's hard to convey through marketing copy alone.
- **Content/credibility building**: publishing genuinely specific, useful content about common CRE report mistakes (the kind of thing this document's Section 8 describes) builds credibility with a skeptical, experienced professional audience far better than generic AI-hype marketing would.
- **Explicitly avoid**: positioning that sounds like "AI will replace appraisers" in any marketing material — this audience's professional identity and licensing regime make that framing actively hostile to adoption, in addition to being factually wrong per our own product philosophy.
- **Long-term channel bet**: once credible, a formal or informal integration relationship with Narrative1 (or a competitor) becomes a plausible high-leverage channel — but this is a partnership to earn later, not a dependency to build the business plan around now.

---

## 20. Product Risks

- **False positives erode trust faster than false negatives are noticed** — a wrong flag is seen immediately and annoys the user; a missed real error may not surface for weeks/months, if ever, making it easy to overestimate how well the product is doing from usage data alone.
- **Appraisers may not trust an automated review of their own professional judgment**, even when we are explicit that we don't judge value — the review category itself ("something is checking my work") can trigger defensiveness in an experienced-professional market. Positioning and first-touch experience must actively address this.
- **Low switching motivation**: appraisers who have never been burned by a bad mistake may not feel the pain acutely enough to pay before they need it — GTM must find and prioritize appraisers who have already been burned (litigation history, a past client complaint) as easier early adopters.
- **Report format diversity**: narrative reports vary enormously in template, structure, and formatting across firms and authoring tools, making "extract the client name from page 1" a harder parsing problem than it sounds — this is a real engineering risk explored in later phases, not a Phase 0 concern, but worth naming here.

---

## 21. Technical Risks

- **Document parsing fidelity**: DOCX/PDF extraction of tables, grids, and embedded images-of-Excel-screenshots is unreliable in general, and CRE reports frequently embed financial grids as images or complex tables — this is likely the single hardest technical problem in the whole product and should be prototyped early and honestly, not assumed away.
- **LLM reliability on arithmetic**: LLMs are unreliable at exact arithmetic; any calculation-check feature must use deterministic extraction + code-based recalculation, not LLM mental math (this is already stated as a design principle in Section 4, restated here as a risk if that principle is violated under time pressure).
- **LLM hallucination on narrative-contradiction checks**: the highest-risk check category, because it requires genuine language understanding rather than exact matching — false positives and false negatives are both likely here and must be monitored closely, with conservative severity labeling until real-world precision is measured.
- **Latency vs. thoroughness tradeoff**: a genuinely thorough review of a 40+ page report with cross-referencing may take longer than an appraiser wants to wait at 11pm — this is a real product/engineering tension, not just an infra scaling question.
- **Cost per review**: LLM API costs on long documents (potentially 50+ pages of context per report) must be modeled early against the pricing hypothesis in Section 18 — this is a unit-economics risk, not just a technical one.

---

## 22. AI Risks

- **Overclaiming AI capability is our single biggest reputational risk.** If we market "AI reviews your report" and it misses an obvious, embarrassing error a human would have caught, the damage to trust in a small, word-of-mouth professional community is severe and hard to recover from. Every public claim about what the AI catches must be conservative relative to actual measured performance.
- **The line between "flagging an inconsistency" and "opining on value" is a real prompting/engineering risk, not just a policy statement.** An AI check that says "this cap rate seems too low" has crossed from consistency-checking into valuation judgment, even unintentionally. Every AI-check prompt must be reviewed against this line explicitly, and this document is the standing reference for that review.
- **Model drift/version changes**: underlying LLM provider model updates can silently change check behavior/quality over time without any code change on our side — this requires ongoing evaluation discipline (regression-testing findings against a fixed set of sample reports), not a one-time launch validation.
- **Client data flowing through a third-party LLM API** is itself a risk surface (see Data Philosophy, Section 25, and Legal Risks below) — appraisal reports contain sensitive client financials, and our AI-provider terms and data handling must be appraiser-defensible if a client ever asks "where did my financial data go."

---

## 23. Legal Risks

- **Professional liability spillover**: if an appraiser relies on our tool as their final check and a material error still reaches a client/lender/court, there is a real question of whether our tool's existence and marketing claims become part of a professional negligence conversation about the appraiser — our Terms of Service, marketing language, and in-product disclaimers must be unambiguous that we are a supplementary aid, not a substitute for the appraiser's own professional review obligation under USPAP. This is not boilerplate; it is core to the product's legal safety and must be drafted with actual legal counsel before any paying customer, not improvised.
- **We are not attempting to define "practicing appraisal" via software** — because we never determine value, we believe we sit outside licensed-appraisal-practice regulation, but this is a legal question requiring actual counsel confirmation before GTM, not an assumption to rely on unverified.
- **Data handling / confidentiality obligations**: appraisal engagement letters often include confidentiality clauses about client financial data; our Terms and data-handling practices must be compatible with appraisers being able to honestly represent to their own clients how their data is being processed (see Data Philosophy).
- **E&O insurance interaction**: appraiser E&O insurers may have opinions (positive or negative) about AI tools in the workflow — worth proactive research, potentially even a differentiator ("insurer-aware" positioning) once we have that information, but currently unknown and flagged as an open question, not a claim.

---

## 24. Security Philosophy

- Client financial data and property data flowing through our system is **sensitive business data, not public information**, even though it is not health or payment-card data — treated with a "serious SaaS," tenant-isolated posture from day one (consistent with the Company Bible's Phase 1 architecture principles).
- **Least data retention necessary.** We do not need to retain uploaded reports indefinitely by default; retention policy is a deliberate product decision (appraiser may want history for re-review-diffing per Section 14, but this is opt-in/configurable, not an assumed default) — over-retention of client-sensitive data is a liability with no product benefit if the appraiser doesn't need it.
- **No client data used to train third-party foundation models** without explicit, informed opt-in — this must be verified against whichever LLM provider's default data-usage terms we adopt (API-tier terms typically differ from consumer-app terms, but this must be confirmed and documented, not assumed).
- **Tenant isolation via database-level RLS**, consistent with the Phase 0 architecture principles already established for this project (Postgres RLS-first, per the Company Bible's architecture principles document).

---

## 25. Data Philosophy

- **The appraiser's uploaded report and underlying data belong to the appraiser and their client, not to us.** We are a processor, not an owner, of this data — this framing should be reflected literally in our Terms of Service, not just as an internal value statement.
- **We are transparent about what leaves the appraiser's environment and where it goes** (e.g., which LLM provider, under what data-use terms) — an appraiser must be able to honestly answer their own client's question "is my financial data safe" without us having obscured the actual data flow from them.
- **We do not build a comp/market-data business on the back of appraiser-uploaded report data** without explicit, separate, opt-in consent — even though appraiser reports contain valuable market data (sale prices, cap rates, rents), harvesting that data for a separate product without clear consent would be a trust-destroying move in a small, relationship-driven market, and is explicitly out of scope regardless of its theoretical business value.
- **Findings history belongs to the appraiser/firm, exportable on request** — no lock-in via data hostage-taking; consistent with the "reversibility over speed" architecture principle already established.

---

## 26. Product Principles

1. **Every finding must show its evidence.** No "trust me" findings — always cite the specific locations being compared or the specific numbers that don't reconcile.
2. **Severity before volume.** A findings report with 3 correctly-prioritized critical issues beats one with 40 undifferentiated flags.
3. **Never claim certainty we don't have.** Narrative-contradiction and missing-assumption checks (LLM-based) should be labeled distinctly from deterministic checks (arithmetic, string-matching) in the UI, so the appraiser calibrates trust appropriately per check type.
4. **Design for the tired professional at 11pm, not the impressed prospect in a demo.** Clarity and speed of the findings report under real deadline pressure is the actual product, not a polished onboarding flow.
5. **We are a checklist that got smarter, not a colleague that got opinions.** Every product and marketing decision should be checkable against this sentence.
6. **When in doubt about scope, choose review over judgment, and disclosure over inference.** If a feature idea requires us to imply a view on value, comps, or professional correctness — it's out of scope, full stop, regardless of how technically feasible it is.

---

## Open Items Requiring Founder Decision (not yet resolved by this document)

Flagging explicitly rather than silently deciding:

- Actual company name, not yet chosen.
- Confirmed market-sizing figures from a primary source (Section 7 uses unverified estimates).
- Actual price point (Section 18 deliberately left unresolved).
- Legal counsel confirmation on the liability/practice-of-appraisal questions in Section 23 before any paying customer.
- LLM provider selection and its specific data-use terms (referenced in Sections 22, 24, 25 but not yet chosen — this is a Phase-appropriate technical decision, not a Phase 0 one).

---

_End of Company Bible v1.0. Do not build schema, code, or pricing pages that contradict this document without first revising this document and noting the change. This is the constitution; everything else is implementation._
