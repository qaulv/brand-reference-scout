# Source routing

Use the smallest existing tool/workflow that supplies the actual reference.
Do not install or redistribute third-party skills implicitly.

For a historical progression, search intermediate eras explicitly and verify
dates against item metadata. A source collection is not a single visual style:
avoid building a batch from many near-identical intervals of the same film.
Cache compact metadata and batch independent retrievals before asking the model
to assess the useful candidates.

## Internet Archive

The [Internet Archive agent skill](https://github.com/internetarchive/internet-archive-skills)
uses the `ia` CLI. It is separately distributed under AGPL-3.0; this package does
not copy or bundle it. If installed, use its search and download workflow.
Otherwise the host can use public read endpoints with no key:

- Search: `https://archive.org/advancedsearch.php?q=...&output=json&rows=20`.
- Metadata/files: `https://archive.org/metadata/{identifier}`.
- Stable source: `https://archive.org/details/{identifier}`.
- Stable file: `https://archive.org/download/{identifier}/{filename}`.

Start with Prelinger for archival footage; narrow to the campaign's literal
subjects. Metadata matches need actual video inspection. Preserve item-level
license/rights fields. Avoid transient archive data-node URLs. Follow the Archive's
[automated-access guidance](https://archive.org/developers/bots.html).

## Destockd

[Destockd](https://www.destockd.com/#/collections) offers shot-level visual search,
similar shots and clip downloads from FedFlix, with archival source links.
Search visible subjects/actions rather than abstract brand adjectives.

The [existing Destockd footage skill](https://github.com/redactedCHAD/destockd-footage-skill)
can be used when separately available. No license was detected during assessment;
do not copy its instructions or code into this MIT package without permission.
Otherwise browse the site with existing host tools and import selected clip links.
Its public frontend endpoints were observed, but a supported integration API was
not established. Don't add a scraper or depend on undocumented endpoints.
Retain [source/rights evidence](https://www.destockd.com/#/legal).

## Supplementary sources

- [Library of Congress](https://www.loc.gov/film-and-videos/): archival breadth;
  use its [documented JSON API](https://www.loc.gov/apis/json-and-yaml/) or browsing.
  Playback access alone does not determine reuse rights.
- [Eyecandy](https://eyecannndy.com/): technique and visual-language inspiration.
  Follow original creator/source links; examples are not a blanket stock license.
- [Public Work](https://www.cosmos.so/public-work): still-image discovery for
  palette, texture or composition. Check original collection records. Do not
  present stills, scanned type specimens or film frames as playable B-roll.

## Optional Context / hackathon web-data connection

If already connected, brand retrieval and focused page/image extraction can help
read a brand URL or JavaScript-heavy campaign page. Choose only the missing fields;
cache the compact result alongside the analysis. Preserve URLs and retrieval date.
The hackathon's separate API/MCP must use its supplied endpoint and authentication;
do not assume the standard Context endpoint uses those credits. Until that
connection is supplied, use ordinary host tools. The basic skill requires no
Context account, key, credits or additional model service.
