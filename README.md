# Keystone OS

A second reader for commercial appraisal reports — checks a finished
narrative report for internal inconsistencies, calculation mistakes,
and leftover mistakes before it's delivered to a client, lender, or
court. It never determines market value and never replaces the
appraiser's professional judgment.

Governing documents (read in this order before making any product or
architecture decision):

1. `docs/chapter-0-the-manifesto.md` — Chapter 0, The Manifesto
2. `docs/company-bible.md` — Company Bible
3. `docs/prd-v1.md` — Product Requirements Document v1.0

## Phase 3 — Secure Report Upload (current)

This phase added: a private Supabase Storage bucket for uploaded PDFs, the `public.reports` table with Row Level Security, a New Review upload page, a real report list on the Dashboard, and per-report Open (signed URL) / Delete actions. It intentionally does NOT include text extraction, the review engine, findings, AI, OCR, billing, teams, exports, or notifications — those are later phases, per the PRD.

## Local development

```bash
npm install
cp .env.local.example .env.local   # then fill in real Supabase values
npm run dev
```

## Scripts

- `npm run dev` — start the local dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run format` — Prettier (writes)
- `npm run format:check` — Prettier (check only, used in CI)

## Database

SQL migrations live in `supabase/migrations/`, applied in order via
the Supabase SQL Editor or the Supabase CLI. See
`docs/CHANGELOG.md` for what's shipped in each phase.
