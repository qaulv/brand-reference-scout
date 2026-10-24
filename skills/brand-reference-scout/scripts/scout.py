#!/usr/bin/env python3
"""Prepare, serve and export a private B-roll review. Python standard library only."""
import argparse
import functools
import hashlib
import http.server
import json
import math
import mimetypes
import pathlib
import shutil
import subprocess
import sys
import tempfile
import uuid
import urllib.parse

SKILL = pathlib.Path(__file__).resolve().parents[1]


def read_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{label} is required')
    return value.strip()


def _read_context(path):
    value = read_json(path)
    if not isinstance(value, dict):
        raise ValueError('Review context must be a JSON object')
    context = {
        'brand_read': text(value.get('brand_read'), 'Context brand_read'),
        'ad_target': text(value.get('ad_target'), 'Context ad_target'),
    }
    for key, label in (('brand_read', 'Context brand_read'), ('ad_target', 'Context ad_target')):
        if len(context[key].split()) > 100:
            raise ValueError(f'{label} must be at most 100 words')
    return context


def web_url(value, label):
    value = text(value, label)
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f'{label} must be an HTTP(S) URL without credentials')
    return value


def seconds(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f'{label} must be a finite, nonnegative number of seconds')
    return value


def interval(record, start, end):
    left, right = seconds(record.get(start), start), seconds(record.get(end), end)
    if right <= left:
        raise ValueError(f'{end} must be after {start}')
    return left, right


def local_or_web(value, base, label):
    value = text(value, label)
    # Check native absolute paths first: Windows drive letters are not URI schemes.
    candidate = pathlib.Path(value)
    if candidate.is_absolute():
        if not candidate.is_file():
            raise ValueError(f'Missing {label}: {candidate.name}')
        return candidate.resolve()
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme:
        return web_url(value, label)
    file = (base / value).resolve()
    if not file.is_file():
        raise ValueError(f'Missing {label}: {file.name}')
    return file


def asset(value, base, out, label):
    item = local_or_web(value, base, label)
    if isinstance(item, str):
        return item
    allowed = {'.mp4', '.webm', '.ogv', '.mov'} if label == 'preview_url' else {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'}
    if item.suffix.lower() not in allowed:
        raise ValueError(f'Unsupported {label} file type: {item.suffix}')
    digest = hashlib.sha256()
    with item.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    relative = pathlib.Path('media') / (digest.hexdigest()[:20] + item.suffix.lower())
    target = out / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        shutil.copyfile(item, target)
    return relative.as_posix()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def session_fingerprint(session):
    contents = {key: value for key, value in session.items() if key not in ('id', 'fingerprint')}
    return hashlib.sha256(canonical_json(contents).encode()).hexdigest()


def _canonical_path(path):
    """Apply the URL dot-segment rules while retaining meaningful empty segments."""
    segments = (path or '/').split('/')
    normalized = []
    for segment in segments:
        marker = segment.lower()
        if marker in ('.', '%2e'):
            continue
        if marker in ('..', '%2e.', '.%2e', '%2e%2e'):
            if len(normalized) > 1:
                normalized.pop()
            continue
        normalized.append(segment)
    return '/'.join(normalized).rstrip('/')


def source_identity(url):
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname.lower()
    port = parsed.port
    if port is not None and not ((scheme == 'http' and port == 80) or (scheme == 'https' and port == 443)):
        host = f'[{hostname}]' if ':' in hostname else hostname
        host = f'{host}:{port}'
    else:
        host = f'[{hostname}]' if ':' in hostname else hostname
    path = _canonical_path(parsed.path)
    query = sorted((key, value) for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                   if not key.lower().startswith('utm_') and key.lower() not in ('fbclid', 'gclid'))
    return urllib.parse.urlunsplit((scheme, host, path.rstrip('/'),
                                   urllib.parse.urlencode(query), ''))


POOL_SIZES = frozenset({10, 20})


GENERATED_OUTPUT_NAMES = frozenset({
    'index.html', 'style.css', 'review.js', 'review-session.json',
    'review-pool.json', 'review-pool.js', 'media',
})


def _clip_annotations(record):
    """Normalize optional candidate metadata without changing root-session records."""
    annotations = {}
    if 'tags' in record:
        tags = record['tags']
        if not isinstance(tags, list) or any(not isinstance(tag, str) or not tag.strip() for tag in tags):
            raise ValueError('Clip tags must be a list of nonempty strings')
        annotations['tags'] = [tag.strip() for tag in tags]
    if 'features' in record:
        features = record['features']
        if not isinstance(features, list) or any(not isinstance(feature, str) or not feature.strip()
                                                 for feature in features):
            raise ValueError('Clip features must be a list of nonempty strings')
        annotations['features'] = [feature.strip() for feature in features]
    return annotations


def _normalise_clips(records, base, seen=None, source_intervals=None, media_intervals=None,
                     include_annotations=False):
    """Validate and normalize clip records, optionally extending existing identity sets."""
    seen = set() if seen is None else seen
    source_intervals = set() if source_intervals is None else source_intervals
    media_intervals = set() if media_intervals is None else media_intervals
    clips = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('Each clip must be an object')
        ident = text(record.get('id'), 'Clip id')
        if ident in seen:
            raise ValueError(f'Duplicate clip id: {ident}')
        seen.add(ident)
        start, end = interval(record, 'start', 'end')
        pstart, pend = interval(record, 'preview_start', 'preview_end')
        source = web_url(record.get('source_url'), 'source_url')
        source_media = record.get('source_media_url')
        if source_media is not None:
            source_media = web_url(source_media, 'source_media_url')
        source_interval = (source_identity(source), start, end)
        if source_interval in source_intervals:
            raise ValueError(f'Duplicate source interval: {ident}')
        source_intervals.add(source_interval)
        if source_media is not None:
            media_interval = (source_identity(source_media), start, end)
            if media_interval in media_intervals:
                raise ValueError(f'Duplicate source interval: {ident}')
            media_intervals.add(media_interval)
        rights = record.get('rights')
        if not isinstance(rights, dict) or rights.get('status') not in ('source-stated', 'unverified', 'restricted'):
            raise ValueError('Each clip needs rights.status: source-stated, unverified or restricted')
        rights_url = rights.get('url')
        if rights_url is not None:
            rights_url = web_url(rights_url, 'Rights URL')
        rights = {'status': rights['status'], 'text': text(rights.get('text'), 'Rights evidence'),
                  'url': rights_url}
        # Preflight file existence and schemes before writing.
        local_or_web(record.get('preview_url'), base, 'preview_url')
        poster = record.get('poster_url')
        if poster is not None:
            local_or_web(poster, base, 'poster_url')
        observed = record.get('observed')
        if observed is not None and not isinstance(observed, str):
            raise ValueError('observed must be a string when provided')
        clip = {'id': ident, 'title': text(record.get('title'), 'Clip title'),
                'preview_url': record['preview_url'], 'poster_url': poster,
                'source_url': source, 'source_media_url': source_media,
                'start': start, 'end': end, 'preview_start': pstart, 'preview_end': pend,
                'rights': rights, 'fit': text(record.get('fit'), 'Clip fit explanation'),
                'observed': observed if observed is not None else ''}
        if include_annotations:
            clip.update(_clip_annotations(record))
        clips.append(clip)
    return clips, seen, source_intervals, media_intervals


def _normalise_initial_annotations(raw, root_ids):
    if raw is None:
        return {}
    if isinstance(raw, list):
        converted = {}
        for item in raw:
            if not isinstance(item, dict):
                raise ValueError('Initial clip annotations need clip ids and metadata')
            ident = text(item.get('id'), 'Initial clip annotation id')
            if ident in converted:
                raise ValueError(f'Duplicate initial clip annotation: {ident}')
            converted[ident] = {key: item[key] for key in ('tags', 'features') if key in item}
        raw = converted
    if not isinstance(raw, dict):
        raise ValueError('Initial clip annotations must be an object or list')
    annotations = {}
    for ident, value in raw.items():
        if not isinstance(ident, str) or not ident.strip() or ident not in root_ids:
            raise ValueError(f'Unknown initial clip annotation: {ident}')
        if not isinstance(value, dict):
            raise ValueError(f'Initial clip annotation must be an object: {ident}')
        annotations[ident] = _clip_annotations(value)
    return annotations


def _read_pool(path, root_ids, seen, source_intervals, media_intervals):
    pool_path = pathlib.Path(path).resolve()
    value = read_json(pool_path)
    if isinstance(value, list):
        records, raw_annotations = value, None
    elif isinstance(value, dict):
        records = value.get('clips')
        raw_annotations = value.get('initial_annotations', value.get('annotations', value.get('initial')))
    else:
        records, raw_annotations = None, None
    if not isinstance(records, list) or len(records) not in POOL_SIZES:
        raise ValueError('A candidate pool requires exactly ten or twenty additional curated clips')
    clips, seen, source_intervals, media_intervals = _normalise_clips(
        records, pool_path.parent, seen, source_intervals, media_intervals, include_annotations=True)
    annotations = _normalise_initial_annotations(raw_annotations, root_ids)
    return clips, annotations, seen, source_intervals, media_intervals


def _pool_payload(clips, annotations):
    return {'clips': clips, 'initial_annotations': annotations}


def pool_fingerprint(clips, annotations):
    return hashlib.sha256(canonical_json(_pool_payload(clips, annotations)).encode()).hexdigest()


def _pool_manifest(root_session, clips, annotations):
    return {'version': 1, 'root_session_id': root_session['id'],
            'root_fingerprint': root_session['fingerprint'],
            'pool_fingerprint': pool_fingerprint(clips, annotations),
            'clips': clips, 'initial_annotations': annotations}


def _pool_script(manifest):
    embedded = canonical_json(manifest).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    return "(function(root){root.BrandReferenceScoutPool=" + embedded + ";}(typeof globalThis !== 'undefined' ? globalThis : this));\n"


def _validate_pool_manifest(session, manifest):
    if not isinstance(manifest, dict):
        raise ValueError('Review pool must be a JSON object')
    if manifest.get('version') != 1 or manifest.get('root_session_id') != session.get('id'):
        raise ValueError('Candidate pool belongs to a different review session')
    if manifest.get('root_fingerprint') != session.get('fingerprint'):
        raise ValueError('Candidate pool belongs to a different review fingerprint')
    clips = manifest.get('clips')
    annotations = manifest.get('initial_annotations', {})
    if not isinstance(clips, list) or len(clips) not in POOL_SIZES or not isinstance(annotations, dict):
        raise ValueError('Invalid review pool contents')
    if manifest.get('pool_fingerprint') != pool_fingerprint(clips, annotations):
        raise ValueError('Candidate pool fingerprint does not match its contents')
    root_ids = {clip.get('id') for clip in session.get('clips', []) if isinstance(clip, dict)}
    seen = set(root_ids)
    source_intervals = set()
    media_intervals = set()
    for root_clip in session.get('clips', []):
        if isinstance(root_clip, dict):
            source = web_url(root_clip.get('source_url'), 'source_url')
            start, end = interval(root_clip, 'start', 'end')
            source_intervals.add((source_identity(source), start, end))
            source_media = root_clip.get('source_media_url')
            if source_media is not None:
                media_intervals.add((source_identity(web_url(source_media, 'source_media_url')), start, end))
    for clip in clips:
        if not isinstance(clip, dict):
            raise ValueError('Candidate pool clips need to be objects')
        ident = text(clip.get('id'), 'Clip id')
        if ident in seen:
            raise ValueError(f'Duplicate clip id: {ident}')
        seen.add(ident)
        text(clip.get('title'), 'Clip title')
        preview = text(clip.get('preview_url'), 'preview_url')
        if urllib.parse.urlsplit(preview).scheme:
            web_url(preview, 'preview_url')
        poster = clip.get('poster_url')
        if poster is not None:
            poster = text(poster, 'poster_url')
            if urllib.parse.urlsplit(poster).scheme:
                web_url(poster, 'poster_url')
        source = web_url(clip.get('source_url'), 'source_url')
        start, end = interval(clip, 'start', 'end')
        interval(clip, 'preview_start', 'preview_end')
        rights = clip.get('rights')
        if not isinstance(rights, dict) or rights.get('status') not in ('source-stated', 'unverified', 'restricted'):
            raise ValueError('Each clip needs rights.status: source-stated, unverified or restricted')
        text(rights.get('text'), 'Rights evidence')
        rights_url = rights.get('url')
        if rights_url is not None:
            web_url(rights_url, 'Rights URL')
        text(clip.get('fit'), 'Clip fit explanation')
        observed = clip.get('observed')
        if observed is not None and not isinstance(observed, str):
            raise ValueError('observed must be a string when provided')
        _clip_annotations(clip)
        source_key = (source_identity(source), start, end)
        if source_key in source_intervals:
            raise ValueError(f'Duplicate source interval: {ident}')
        source_intervals.add(source_key)
        source_media = clip.get('source_media_url')
        if source_media is not None:
            media_key = (source_identity(web_url(source_media, 'source_media_url')), start, end)
            if media_key in media_intervals:
                raise ValueError(f'Duplicate source interval: {ident}')
            media_intervals.add(media_key)
    _normalise_initial_annotations(annotations, root_ids)
    return clips


def _validate_output_directory(out):
    """Allow replacing only an empty or previously generated review directory."""
    if not out.exists():
        return
    if out.is_symlink() or not out.is_dir():
        raise ValueError(f'Output path is not a directory: {out}')
    unmanaged = sorted(entry.name for entry in out.iterdir()
                       if entry.name not in GENERATED_OUTPUT_NAMES
                       or (entry.name == 'media' and (entry.is_symlink() or not entry.is_dir())))
    if unmanaged:
        names = ', '.join(unmanaged)
        raise ValueError(f'Output directory contains unmanaged files: {names}')


def _replace_output(stage, out):
    """Replace an owned output directory, restoring it if the swap fails."""
    backup = None
    try:
        if out.exists():
            backup = out.parent / f'.{out.name}.backup-{uuid.uuid4().hex}'
            out.rename(backup)
        stage.rename(out)
    except Exception:
        if backup is not None and backup.exists() and not out.exists():
            backup.rename(out)
        raise
    if backup is not None:
        shutil.rmtree(backup)


def prepare(args):
    brief = text(args.brief, 'Job brief')
    brand_path = pathlib.Path(args.brand).resolve()
    brand = text(brand_path.read_text(encoding='utf-8'), 'Brand context')
    campaign_path = pathlib.Path(args.campaigns).resolve()
    campaigns = read_json(campaign_path)
    if not isinstance(campaigns, list) or not campaigns:
        raise ValueError('At least one campaign reference is required')
    references = []
    for item in campaigns:
        if not isinstance(item, dict):
            raise ValueError('Campaign references need label and source')
        label = text(item.get('label'), 'Campaign label')
        source = local_or_web(item.get('source'), campaign_path.parent, 'campaign source')
        references.append({'label': label, 'source': source.name if isinstance(source, pathlib.Path) else source})
    catalog_path = pathlib.Path(args.catalog).resolve()
    catalog = read_json(catalog_path)
    if isinstance(catalog, dict):
        catalog = catalog.get('clips')
    if not isinstance(catalog, list) or len(catalog) != 10:
        raise ValueError('A review requires exactly ten curated clips')
    # Validate the whole catalog before generating output or copying any media.
    seen, source_intervals, media_intervals = set(), set(), set()
    clips, seen, source_intervals, media_intervals = _normalise_clips(
        catalog, catalog_path.parent, seen, source_intervals, media_intervals)
    summary = text(pathlib.Path(args.analysis).read_text(encoding='utf-8'), 'Campaign analysis')
    name = next((line.lstrip('# ').strip() for line in brand.splitlines() if line.strip()), 'Brand')
    context_path = getattr(args, 'context', None)
    context = _read_context(context_path) if context_path else None
    out_arg = pathlib.Path(args.out)
    if out_arg.is_symlink():
        raise ValueError('Output path must not be a symlink')
    out = out_arg.resolve()
    _validate_output_directory(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    pool_path = getattr(args, 'pool', None)
    pool_clips, pool_annotations = [], {}
    if pool_path:
        pool_clips, pool_annotations, seen, source_intervals, media_intervals = _read_pool(
            pool_path, {clip['id'] for clip in clips}, seen, source_intervals, media_intervals)
    stage = pathlib.Path(tempfile.mkdtemp(prefix=f'.{out.name}.stage-', dir=str(out.parent)))
    try:
        for clip in clips:
            clip['preview_url'] = asset(clip['preview_url'], catalog_path.parent, stage, 'preview_url')
            if clip['poster_url'] is not None:
                clip['poster_url'] = asset(clip['poster_url'], catalog_path.parent, stage, 'poster_url')
        session = {'version': 1, 'title': args.title or f'{name} — B-roll review', 'brief': brief,
                   'brand': {'name': name, 'summary': summary}, 'campaign_references': references, 'clips': clips}
        fingerprint = session_fingerprint(session)
        session['id'] = f'scout-{fingerprint[:16]}'
        session['fingerprint'] = fingerprint
        (stage / 'review-session.json').write_text(json.dumps(session, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        template = (SKILL / 'assets/review.html').read_text(encoding='utf-8')
        if '__SCOUT_SESSION_JSON__' not in template:
            raise ValueError('Review template is missing its session placeholder')
        embedded = canonical_json(session).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
        for name in ('review.js', 'style.css'):
            shutil.copyfile(SKILL / 'assets' / name, stage / name)
        existing_session = None
        if pool_path and (out / 'review-session.json').is_file():
            existing_session = read_json(out / 'review-session.json')
            if not isinstance(existing_session, dict):
                raise ValueError('Existing review session must be a JSON object')
            if existing_session.get('id') != session['id'] or existing_session.get('fingerprint') != session['fingerprint']:
                raise ValueError('Existing review session does not match the supplied root catalog')
            # Keep the published root session byte-for-byte stable while the
            # current renderer supplies any new pool-aware page assets.
            shutil.copyfile(out / 'review-session.json', stage / 'review-session.json')
            session = existing_session
        for clip in pool_clips:
            clip['preview_url'] = asset(clip['preview_url'], pathlib.Path(pool_path).resolve().parent, stage, 'preview_url')
            if clip['poster_url'] is not None:
                clip['poster_url'] = asset(clip['poster_url'], pathlib.Path(pool_path).resolve().parent, stage, 'poster_url')
        if pool_path:
            manifest = _pool_manifest(session, pool_clips, pool_annotations)
            (stage / 'review-pool.json').write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
            (stage / 'review-pool.js').write_text(_pool_script(manifest), encoding='utf-8')
            pool_embedded = canonical_json(manifest).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
        else:
            pool_embedded = ''
        rendered = template.replace('__SCOUT_SESSION_JSON__', embedded)
        if '__SCOUT_POOL_JSON__' in rendered:
            rendered = rendered.replace('__SCOUT_POOL_JSON__', pool_embedded)
        context_embedded = '' if context is None else canonical_json(context).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
        if '__SCOUT_CONTEXT_JSON__' in rendered:
            rendered = rendered.replace('__SCOUT_CONTEXT_JSON__', context_embedded)
        elif context is not None:
            context_tag = '<script type="application/json" id="review-context">' + context_embedded + '</script>\n'
            if '    <script src="review.js"></script>\n' in rendered:
                rendered = rendered.replace('    <script src="review.js"></script>\n',
                                            '    ' + context_tag + '    <script src="review.js"></script>\n')
            else:
                rendered = rendered.replace('</body>', '    ' + context_tag + '</body>')
        if not pool_path:
            rendered = rendered.replace(
                '    <script src="review-pool.js" data-optional-pool onerror="this.remove()"></script>\n', '')
        (stage / 'index.html').write_text(rendered, encoding='utf-8')
        _replace_output(stage, out)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    result = {'session_id': session['id'], 'directory': str(out), 'review': str(out / 'index.html'),
              'clips': len(clips), 'analysis': 'provided'}
    if pool_path:
        result['pool_fingerprint'] = manifest['pool_fingerprint']
        result['pool_clips'] = len(pool_clips)
    if context is not None:
        result['context'] = True
    return result


def validate_decisions(session, data, pool=None):
    if not isinstance(session, dict):
        raise ValueError('Review session must be a JSON object')
    if not isinstance(data, dict):
        raise ValueError('Decision export must be a JSON object')
    if session.get('fingerprint') != session_fingerprint(session):
        raise ValueError('Session fingerprint does not match its contents')
    if data.get('version') != 1 or data.get('session_id') != session['id'] or data.get('session_fingerprint') != session['fingerprint']:
        raise ValueError('Decisions belong to a different review session')
    pool_clips = _validate_pool_manifest(session, pool) if pool is not None else []
    if pool is not None and data.get('pool_fingerprint') != pool['pool_fingerprint']:
        raise ValueError('Decisions belong to a different candidate pool')
    known = {clip['id'] for clip in session['clips']} | {clip['id'] for clip in pool_clips}
    decisions = data.get('decisions')
    if not isinstance(decisions, dict):
        raise ValueError('Invalid clip decisions')
    rounds = data.get('rounds', [])
    if rounds is not None and not isinstance(rounds, list):
        raise ValueError('Invalid review rounds')
    cumulative_decisions = {}
    cumulative_notes = {}
    for round_record in rounds or []:
        if not isinstance(round_record, dict):
            raise ValueError('Invalid review rounds')
        round_decisions = round_record.get('decisions', {})
        round_notes = round_record.get('notes', {})
        if not isinstance(round_decisions, dict) or not isinstance(round_notes, dict):
            raise ValueError('Invalid review rounds')
        cumulative_decisions.update(round_decisions)
        cumulative_notes.update(round_notes)
    cumulative_decisions.update(decisions)
    if any(i not in known or v not in ('keep', 'discard') for i, v in cumulative_decisions.items()):
        raise ValueError('Invalid clip decisions')
    notes = data.get('notes', {})
    if not isinstance(notes, dict):
        raise ValueError('Invalid clip notes')
    cumulative_notes.update(notes)
    if any(i not in known or not isinstance(note, str) for i, note in cumulative_notes.items()):
        raise ValueError('Invalid clip notes')
    return cumulative_decisions, cumulative_notes


def markdown(session, data, pool=None):
    decisions, notes = validate_decisions(session, data, pool)
    clips = session['clips'] + (pool.get('clips', []) if pool is not None else [])
    lines = [f'# {session["title"]}', '', f'Brief: {session["brief"]}', '',
             f'Reviewed: {len(decisions)}/{len(clips)} clips', '']
    selected = [clip for clip in clips if decisions.get(clip['id']) == 'keep']
    if not selected:
        lines.append('No clips selected.')
    for clip in selected:
        lines.extend([f'## {clip["title"]}', '', f'- Source: {clip["source_url"]}',
                      f'- Original interval: {clip["start"]}–{clip["end"]} seconds',
                      f'- Fit: {clip["fit"]}', f'- Rights ({clip["rights"]["status"]}): {clip["rights"]["text"]}'])
        if clip.get('source_media_url'):
            lines.append(f'- Original media: {clip["source_media_url"]}')
        if clip['rights'].get('url'):
            lines.append(f'- Rights source: {clip["rights"]["url"]}')
        if notes.get(clip['id']):
            lines.append(f'- Note: {notes[clip["id"]]}')
        lines.append('')
    return '\n'.join(lines) + '\n'


def export(args):
    session, decisions = read_json(args.session), read_json(args.decisions)
    pool_path = getattr(args, 'pool', None)
    pool = read_json(pool_path) if pool_path else None
    output = pathlib.Path(args.out)
    content = markdown(session, decisions, pool)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(content, encoding='utf-8')
    return {'markdown': str(output.resolve())}


class ReviewHandler(http.server.SimpleHTTPRequestHandler):
    """Read-only static server, including byte ranges for local video seeking."""
    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_head(self):
        path = pathlib.Path(self.translate_path(self.path))
        # An explicit directory is the sole serving boundary; never follow a symlink out.
        root = pathlib.Path(self.directory).resolve()
        if not path.resolve().is_relative_to(root):
            self.send_error(403)
            return None
        if path.is_dir():
            index = path / 'index.html'
            if not index.is_file():
                self.send_error(404)
                return None
            # SimpleHTTPRequestHandler resolves this target itself after this
            # method returns. Check the target now so an index symlink cannot
            # bypass the serving boundary.
            if not index.resolve().is_relative_to(root):
                self.send_error(403)
                return None
        if 'Range' not in self.headers or not path.is_file():
            return super().send_head()
        import re
        size = path.stat().st_size
        match = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers['Range'])
        if not match:
            self.send_error(416)
            return None
        start = int(match[1])
        end = min(int(match[2]) if match[2] else size - 1, size - 1)
        if start > end:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        self.send_response(206)
        self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        self.range_remaining = end - start + 1
        stream = path.open('rb')
        stream.seek(start)
        return stream

    def copyfile(self, source, outputfile):
        remaining = getattr(self, 'range_remaining', None)
        self.range_remaining = None
        try:
            if remaining is None:
                return super().copyfile(source, outputfile)
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def serve(args):
    root = pathlib.Path(args.directory).resolve()
    index = root / 'index.html'
    if not index.is_file():
        raise ValueError('Prepare a review directory before serving it')
    if not index.resolve().is_relative_to(root):
        raise ValueError('Review index must remain inside its directory')
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(ReviewHandler, directory=str(root)))
    url = f'http://127.0.0.1:{server.server_port}/'
    print(json.dumps({'url': url, 'directory': str(root)}), flush=True)
    if args.open:
        if sys.platform == 'darwin':
            subprocess.run(['open', '-a', 'Arc', url], check=False)
        else:
            import webbrowser
            webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('prepare', help='Render ten host-curated clips into a private static review')
    for option in ('brand', 'campaigns', 'brief', 'catalog', 'out'):
        command.add_argument('--' + option, required=True)
    command.add_argument('--analysis', required=True, help='Compact campaign analysis supplied by the host agent')
    command.add_argument('--pool', help='Optional JSON file containing ten or twenty additional review candidates (one or two batches)')
    command.add_argument('--context', help='Optional JSON file with short brand_read and ad_target copy')
    command.add_argument('--title')
    command.set_defaults(run=prepare)
    command = commands.add_parser('serve', help='Serve a prepared review on localhost')
    command.add_argument('directory')
    command.add_argument('--port', type=int, default=0)
    command.add_argument('--open', action='store_true')
    command.set_defaults(run=serve)
    command = commands.add_parser('export', help='Validate an exported decision file and render Markdown')
    for option in ('session', 'decisions', 'out'):
        command.add_argument('--' + option, required=True)
    command.add_argument('--pool', help='Optional review-pool.json for cumulative root-plus-pool export')
    command.set_defaults(run=export)
    args = parser.parse_args()
    try:
        result = args.run(args)
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
