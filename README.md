# Brand Reference Scout

Find B-roll that fits the work you've already made.

Bring **brand context**, **campaign examples**, and a **specific job brief**. Your
agent inspects the work once, searches Internet Archive for the best matching clips,
and opens a private two-up review. Keep left, both, right or neither; the next
pair appears immediately. Finish with a shortlist containing source links,
original intervals and rights evidence.

Match the supplied brand, references and brief—not a preset vintage aesthetic.
Internet Archive is the default footage source; generic stock libraries are used
only when explicitly requested. Sparse results are disclosed rather than padded.

The host model handles interpretation and discovery. Selection runs in the browser
without AI calls. This is a small agent workflow, not a new footage index or model.

Works with **GPT-6 Luna at high reasoning**. A fresh trial on The Pickle Company
read the real brand site, inspected its imagery, discovered ten distinct source
clips and prepared a playable review. Creative fit still needs human judgment.
No model calls happen while choosing clips. As a pricing comparison, the recorded
On trial's token counts would cost about **$0.09 on GPT-6 Luna** at Standard API
rates with the same cache hits, before cache-write or tool charges. That is an
estimate, not the measured bill for the Luna trial. See
[API pricing](https://developers.openai.com/api/docs/pricing).

This release supports video B-roll. Font specimens and image references from the
original broader plan are not implemented yet; books and audio also remain pending.

## Use from a repository copy

Open this folder in your coding agent and say:

```text
Follow skills/brand-reference-scout/SKILL.md.
Help me find B-roll for a new campaign. Ask me for the required inputs,
then take me through the review and shortlist.
```

No server setup is needed before starting. The host agent prepares and opens the
review. Install the skill below when you want to use it across projects.

## Install the skill

Requires Python 3.10+ and an agent with file, browser/search and visual-inspection
tools. ffmpeg/ffprobe are useful for checking or trimming previews but are optional.

From this repository, copy the self-contained skill folder into your host's skill
directory. For Codex:

```bash
cp -R skills/brand-reference-scout ~/.codex/skills/brand-reference-scout
```

Use a new session after installing. Do not overwrite an existing installation
without checking it first. The same folder can be installed through Claude Code's
supported skill mechanism.

```text
Use $brand-reference-scout with my BRAND.md and these campaign examples.
I need B-roll for a 20-second launch film about tactile materials and motion.
Find ten references and open a private review.
```

All three inputs are required. The job brief changes every campaign; the compact
brand/campaign analysis can be reused when the references haven't changed.
During intake, choose a private ChatGPT Site or a local browser review. The agent
remembers this choice for the campaign. Inputs and discovery happen in chat;
the visual player opens when the first ten clips are prepared.

## Plugin installation

The repository includes a portable `plugin.json`, a Codex compatibility manifest
and a repository marketplace. After cloning the repository locally:

```bash
codex plugin marketplace add /absolute/path/to/brand-reference-scout
codex plugin add brand-reference-scout@brand-reference-scout-local
```

Supported desktop clients can discover the repository marketplace. Direct skill
installation remains available when a client's plugin support differs. Public
directory submission and GitHub publication are separate release steps.

For a personal ChatGPT trial, open **Plugins → Add → Upload plugin archive**
and upload the plugin ZIP. Test it in a new chat. This personal installation is
separate from public directory publication; the latter requires a submission
and review through the [OpenAI plugin portal](https://platform.openai.com/plugins).
See the [official package guide](https://developers.openai.com/plugins/build/plugins).

## Try the included example

The fictional Forma Studio campaign is original. Its ten-clip catalog contains
source links to previously screened archival footage; it is an honest cached
example, not a fresh-search benchmark. No footage files are bundled.

```bash
python3 scripts/scout.py prepare \
  --brand skills/brand-reference-scout/examples/BRAND.md \
  --campaigns skills/brand-reference-scout/examples/campaigns.json \
  --analysis skills/brand-reference-scout/examples/analysis.md \
  --context skills/brand-reference-scout/examples/context.json \
  --brief "B-roll for a motion studio launch: graphic rhythm, optical experiments and tactile processes." \
  --catalog skills/brand-reference-scout/examples/catalog.json \
  --out trials/forma-review

python3 scripts/scout.py serve trials/forma-review --open
```

Remote Archive playback depends on source availability and browser seeking.
The host can prepare local trimmed previews for a more dependable review. A
preview's zero-based time is kept separate from its original source interval.

## Review and export

The review starts with a short brand interpretation and the ad’s objective,
provided by the host in `context.json` via `prepare --context /path/to/context.json`.
Each field is at most 100 words. This makes the selection criteria visible.

Five pairs cover ten clips, with one pair visible at a time. Player controls support
seeking, audio and fullscreen; only one preview plays at once. Decisions save in
the current browser. Undo restores the previous pair. Completion shows the kept
clips and attempts to copy the sourced shortlist to your clipboard; a visible
copy button remains available if the browser denies automatic copying.

The normal iterative workflow prepares a pool for one or two further batches of
ten unseen clips. A quick ten-only review is available when requested; it ends at
that shortlist and does not promise another batch.
The page ranks that pool using shared visual tags from keeps and discards. This
is a transparent local heuristic, with no model calls per choice. It does not
search the web itself: when the pool is exhausted, a new agent search is needed.
JSON and Markdown exports preserve the cumulative shortlist. Import matching
JSON to resume on another device. To prepare this flow, pass `--pool /path/to/pool.json`
to `prepare`; the pool contains ten or twenty inspected records and annotations for
the initial ten. See the [session contract](skills/brand-reference-scout/references/session-contract.md).

For validation and a fresh Markdown export in the agent:

```bash
python3 scripts/scout.py export --session trials/forma-review/review-session.json \
  --decisions /path/to/review-decisions.json --out trials/shortlist.md
```

For cumulative decisions, also pass `--pool trials/forma-review/review-pool.json`
when exporting.

Session fingerprints prevent votes from leaking into a changed catalog. Choices
indicate suitability for this brief; they do not constitute a universal ranking.

## Sites and sources

When the user chooses Sites and it is connected, the host publishes the prepared
review directory as an owner-private static Site. It works without a model service
or custom backend. The local browser option requires no Sites account. The CLI
itself does not publish.

Reuse an available Internet Archive discovery skill; its installation and licensing
are separate. Host browser/search tools can follow the same source when it isn't
installed. Destockd can help discover original Archive items. Library of Congress
is available when the user requests sources beyond Internet Archive;
Eyecandy and Public Work supply visual inspiration. See the skill's source guide.
Context/hackathon web-data tools are optional helpers for extracting brand/campaign
webpages when connected. The basic workflow requires no extra API key or paid model.

## Privacy and rights

Campaign inputs, downloaded media and review decisions belong in ignored private
working folders. The static review contains its brief and source records: preserve
private Site access unless the owner deliberately chooses to share it.

MIT covers our original software and example campaign. External footage keeps its
own rights. A source's public-domain statement is recorded as evidence, not a
new clearance guarantee. Nothing here grants commercial rights to an unverified clip.
Third-party source skills are referenced, not bundled.

## Verification

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/review.test.cjs
```

These checks cover input validation, review choices, persistence, sourced exports,
local serving and package boundaries. Live footage availability and creative fit
still need inspection for each campaign.
