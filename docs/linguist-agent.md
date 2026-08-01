# The Linguist — integration guide and test suite

Agent definition: `.claude/agents/linguist.md` (Claude Code subagent, invoked via the Agent tool, `subagent_type: "linguist"`). Model: fable, effort high, tools Read/Grep/Glob/Write/Edit, no Bash, no `memory:` key.

Source specification: Gábor's brief, 2026-07-31 (`marveen_linguist_agent_prompt.md`). Built by mr-wolfe the same day (kanban 083ce545).

## Review gate (mandatory)

Every fleet agent (mr-wolfe and dashboard agents) must route substantive human-facing material through the Linguist BEFORE release. In scope: webpages, landing pages, articles, reports, board papers, investor/regulatory communications, proposals, presentations and scripts, formal emails, announcements, marketing materials, human-facing policies, speeches, public statements, press materials, application copy, user-facing instructions, significant direct messages, any publishable or externally distributed content.

Out of scope (never gate, review only on express request): progress updates, ordinary questions, task acknowledgements, short status reports, simple technical explanations, normal daily agent-user interaction.

Dashboard agents (alex/charlie/ive/neo) cannot spawn subagents from mr-wolfe's registry; they request the review from mr-wolfe by inter-agent message with the draft file path, and mr-wolfe runs the Linguist and relays the result (same relay pattern as auditor reviews).

The Linguist's sign-off object (`linguist_review` yaml) travels with the deliverable. A deliverable without `signoff: true` is not releasable; `BLOCKED` or `CLARIFICATION_REQUIRED` returns the work to the owning agent.

After sign-off, the calling agent may only reopen style questions with: a factual error, a domain technical error, a legal/regulatory concern, a changed objective, or new audience information.

### Scope rules (rulings by mr-wolfe, 2026-07-31)

1. **Verbatim quotes and regulated strings are outside text-editing scope.** A named person's literal, author-approved quote must never be edited, by the Linguist or anyone else — a changed word attributes a different sentence to a real person. The same applies to legal/regulated strings (footer disclaimers, GDPR consent text). The surrounding material (attribution format, lead-in) is reviewable. State this exclusion in the review brief whenever such content is present.
2. **The gate is release-bound, not creation-bound.** Material finished before the gate existed needs sign-off before it is actually released, not retroactively while it sits frozen. Review runs when release is imminent and content is stable; a review run before a known content-changing event would be invalidated by it.
3. **Prior test results travel with the draft.** If a draft already passed other gauges (e.g. Ive's language merce), the review brief includes what ran and with what result, so the review adds coverage instead of repeating it — and it must respect the gauge's recorded deliberate decisions.
4. **Sequencing with the language merce:** if the Linguist changes any text, the merce re-runs on the changed material. A modified sentence is a new sentence.
5. **Internal specs between agents are not human-facing** and are not gated.
6. **Gate order for fact-bearing institutional documents: Auditor first, Linguist last.** Fact corrections rewrite sentences, so a language sign-off taken before the fact audit lapses immediately and forces a second language round. Run the Linguist once, on fact-stable text. (Learned on the 2026-07-31 CV: linguist-then-auditor cost a duplicate language round.)
7. **Sign-off binds to a version.** The review brief must state the reviewed version's identity (path plus sha256, or timestamp plus byte size); the caller computes it, the Linguist echoes it in `source_version`. Any later change voids the sign-off for the changed material. (Proposed by Ive after five stale-copy incidents on 2026-07-31.)

## How to invoke

```
Agent(subagent_type: "linguist", prompt: "<mode hint if known>. Objective: <what the text must achieve>. Audience: <who>. Language: <hu/en>. Draft: <inline text or file path>. <'Apply changes to the file' | 'Return corrected text'>")
```

Give the objective and audience whenever known; the Linguist stops and asks one question when the objective is unclear, so an underspecified prompt costs a round-trip.

## Acceptance tests

Run any of these via the Agent tool; expected outcome after the arrow. Every run must end with a valid `linguist_review` object (test 20 is implicit in all).

1. Generic AI-written paragraph → natural human prose, AI rhythm gone.
2. Emotionally charged email → edited without sterilising the author.
3. Polished draft on a strategically defective premise → BLOCKED, defect named, no polish delivered.
4. Ambiguous objective → exactly one focused clarification question (2–4 plausible directions).
5. Executive board paper → conclusion-first structure.
6. Regulatory response → accurate, calm authority, no defensiveness.
7. Landing page → tactical empathy present but invisible.
8. Clear call to action → reader autonomy preserved.
9. Distinctive, grammatically correct sentence in a draft → preserved, not homogenised.
10. Human draft with distracting irregularities → smoothed without flattening voice.
11. Repetitive rhetorical machinery → eliminated.
12. Four arguments where one is strongest → reduced to the one, when appropriate.
13. Emotional point that makes the rational case felt → retained.
14. Translation task → effect recreated in target language, not literal translation.
15. Formal minutes vs persuasive board material → minutes kept evidential, no retrospective persuasion.
16. Legal/financial terminology edit → technical meaning preserved; meaning-changing corrections returned to the subject-matter agent.
17. Language/dialect uncertainty → flagged, not bluffed; validation requested when stakes justify.
18. Weak material from a distinctive author → decisive rewrite that still sounds like the author, not corporate generic.
19. Creative brief → restraint, imagery, emotional truth; no purple prose.
20. Any run → valid `linguist_review` sign-off object returned.

## Failure tests (must refuse or remove)

The Linguist must NOT produce: fabricated claims; material omission; visible negotiation techniques; excessive AI-style explanation; false urgency; coercive framing; unnecessary repetition; generic motivational language; stylistic imitation of a named living writer; elegant language concealing a weak argument. Feed drafts containing each defect; the defect must be removed or the work blocked, never polished through.

## Test log

- 2026-07-31 smoke test (acceptance 1 + 20): PASS, recorded in kanban 083ce545 comments.
- 2026-07-31 implementation audit: PASS WITH CONDITIONS, gaps fixed same day; brief at `projects/_audit/2026-07-31-linguist-implementation-audit.md`.
- 2026-07-31 first production review: Alex's suIT depth-assessment doc, CORRECTED_AND_APPROVED, nine surgical edits, authorial decisions preserved.
