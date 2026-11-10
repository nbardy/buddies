# Collect: the public record for {{name}}

Segment: {{segment}}

You are gathering what {{name}} says in public, exactly as it says it. One organization, this
call only. Someone else will draw conclusions; your job is a record they can trust.

## Fetch

- Product, pricing, documentation and case-study pages, and the internal links that matter.
- If {{name}} is a publicly reporting company: its latest two or three earnings calls, from the
  official investor-relations transcripts or filings.

A landing-page summary is not a fetched site. Open the pages.

## Record

For every surface you tried, write one row in `sources/{{id}}.md`:
the URL, the retrieval date, and its status: `fetched`, `missing` or `login-blocked`.

For every fact you keep, write the fact, the exact quoted words it rests on, and the URL. Your
work is checked by a script that looks for each quote in the stored page. A paraphrase presented
as a quote fails the check.

Store raw page bodies through `artifact_store_v1` under `output/`. Do not commit them.

## Do not

- Guess at pricing or customers that the pages do not state. Write "not stated".
- Use search-engine summaries as sources. They are leads until you open the page.
- Draw conclusions about demand.

## Report

In your summary, say how many surfaces were fetched, missing and login-blocked, and name anything
that surprised you. If you learn something about the world that changes who we should study (a
company went private, was acquired, or shut the product), record it with the `learn` tool.
