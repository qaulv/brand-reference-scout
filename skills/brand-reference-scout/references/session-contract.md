# Review files

The host agent supplies analysis and curated candidates. The Python helper renders
a static review; it does not analyse media or discover footage itself.

## Inputs to `prepare`

- `--brand`: nonempty UTF-8 Markdown brand context.
- `--brief`: nonempty current job description, required every run.
- `--campaigns`: nonempty JSON array, e.g. `[{"label":"Launch film","source":"campaign.mp4"}]`.
  Sources are existing local files (relative to that JSON) or accessible HTTP(S) links.
  The host checks remote accessibility and actually inspects the campaign first.
- `--analysis`: required compact Markdown observations written by the host after
  inspecting the campaign references. This is separate from supplied brand context.
- `--catalog`: JSON array of exactly ten clips (or an object with `clips`).
- `--out`: private output directory.
- `--context`: optional JSON object with short presentation copy:
  `{ "brand_read": "…", "ad_target": "…" }`. Both values must be nonempty
  strings of at most 100 whitespace-delimited words. This context is display
  data only and is not part of the root session fingerprint.
- `--pool`: optional JSON object containing exactly ten or twenty additional,
  unseen clips under `clips` (one or two prepared review batches), plus optional
  `initial_annotations` keyed by an existing root clip ID. Annotation `tags` and
  `features` values are arrays of nonempty strings. Pool clips may also carry
  those optional arrays.

Clip example:

```json
{
  "id": "archive-item-shot-62",
  "title": "Light through a lens",
  "preview_url": "previews/light.mp4",
  "poster_url": "posters/light.jpg",
  "source_url": "https://archive.org/details/example-item",
  "source_media_url": "https://archive.org/download/example-item/source.mp4",
  "start": 62,
  "end": 82,
  "preview_start": 0,
  "preview_end": 20,
  "rights": {"status": "unverified", "text": "No item-level license found.", "url": null},
  "fit": "Consider the changing light geometry for the transition.",
  "observed": "Parallel rays converge through a lens."
}
```

`poster_url`, `source_media_url` and `observed` are optional. Media/poster inputs
can be explicit local files or HTTP(S) URLs. Local previews/posters are copied
under hashed names; raw campaign files are not copied. Session references preserve
labels and remote links, with local inputs reduced to basenames. Preparation does
not certify codec support, URL availability, source bounds or rights; verify those
before curation is complete.

`start/end` always describe the original film. `preview_start/preview_end` describe
the supplied player file: zero-based for a trimmed excerpt, original coordinates
for the full film. All are finite nonnegative seconds, with end after start.
Rights status is `source-stated`, `unverified` or `restricted`; `source-stated`
records the source's assertion and is not a new clearance decision.

An optional pool has the same URL, interval, rights and local-media validation as
the root catalog. Pool IDs, canonical source intervals and canonical source-media
intervals cannot repeat root or pool records. The pool is an upfront candidate
set for a later shortlist; it does not change the ten-record root session. The
review supports at most three rounds: the root ten plus one additional ten-clip
batch, or two additional batches when a twenty-clip pool is supplied.

## Outputs

`review-session.json` contains `version`, `id`, `fingerprint`, `title`, `brief`,
`brand: {name, summary}`, `campaign_references` and `clips`. A SHA-256 fingerprint
covers the full normalized session. The static page embeds this same data and uses
the same HTML/JS/CSS locally and on Sites.

`review-decisions.json` contains `version:1`, `session_id`, `session_fingerprint`,
`updated_at`, `decisions: {clip_id:"keep"|"discard"}`, `notes`, `history`,
`completed_pairs`, and `shortlist` containing full selected clip records.
The UI may add pair/progress state. Unknown/unreviewed clips have no verdict.
The four pair actions record both verdicts together; Undo restores the prior pair.

Import requires the matching session identity, fingerprint and valid clip IDs.
Browser storage failure is visible; explicit JSON export remains the portable
backup. Exporting a partial session preserves only the choices actually made.

When `--pool` is supplied, preparation also writes `review-pool.json` and
`review-pool.js`. Both carry the same manifest:

```json
{
  "version": 1,
  "root_session_id": "scout-…",
  "root_fingerprint": "…",
  "pool_fingerprint": "…",
  "clips": ["ten or twenty normalized clip records"],
  "initial_annotations": {"root-clip-id": {"tags": ["…"], "features": ["…"]}}
}
```

`pool_fingerprint` is SHA-256 over canonical JSON containing only `clips` and
`initial_annotations`; it is independent of the root identity but the manifest
must carry the matching root session ID and fingerprint. The JavaScript companion
exposes the manifest as `globalThis.BrandReferenceScoutPool`. Adding or replacing
a pool preserves an existing root `review-session.json` byte-for-byte and replaces
owned pool output/media transactionally. The `export` command accepts
`--pool review-pool.json`; cumulative decisions must include the matching
`pool_fingerprint`, and selected pool records are taken from that validated
manifest so their actual source URLs and intervals are retained.

When `--context` is supplied, the static page also embeds a separate JSON script
with `id="review-context"` containing exactly `brand_read` and `ad_target`.
The values are escaped for safe HTML-script embedding and are not copied into
`review-session.json`; pages without context retain the legacy session and allow
the UI to fall back to its existing brief/summary presentation.

No input, output or selection is sent to an AI API by the review interface.
