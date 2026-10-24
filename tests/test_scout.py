import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CLI = ROOT / 'scripts' / 'scout.py'


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        (self.root / 'BRAND.md').write_text('# Tidal Field\nOrganic, tactile ocean science.\n')
        (self.root / 'analysis.md').write_text('Observed high contrast, curved forms and tactile surfaces.\n')
        (self.root / 'campaign.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.campaigns = [{'label': 'Previous campaign', 'source': 'campaign.svg'}]
        self.clips = [dict(id=f'clip-{i}', title=f'Film {i}',
                           preview_url=f'https://example.org/clip-{i}.mp4',
                           source_url=f'https://example.org/film-{i}',
                           source_media_url=f'https://example.org/full-{i}.mp4',
                           start=10, end=30, preview_start=0, preview_end=20,
                           rights=dict(status='unverified', text='Source evidence pending.', url=None),
                           fit='Organic movement for the campaign.') for i in range(10)]

    def invoke(self, *extra, brief='Ocean-science campaign B-roll', include_analysis=True):
        (self.root / 'campaigns.json').write_text(json.dumps(self.campaigns))
        (self.root / 'catalog.json').write_text(json.dumps(self.clips))
        return subprocess.run([sys.executable, str(CLI), 'prepare',
                               '--brand', str(self.root / 'BRAND.md'), '--brief', brief,
                               '--campaigns', str(self.root / 'campaigns.json'),
                               '--catalog', str(self.root / 'catalog.json'),
                               '--out', str(self.root / 'review'),
                               *(['--analysis', str(self.root / 'analysis.md')] if include_analysis else []),
                               *extra], capture_output=True, text=True)

    def pool_records(self, local_preview=None, count=20):
        records = []
        for i in range(count):
            records.append(dict(id=f'pool-{i}', title=f'Pool film {i}',
                                preview_url=local_preview or f'https://example.org/pool-{i}.mp4',
                                poster_url=None,
                                source_url=f'https://example.org/pool-source-{i}',
                                source_media_url=f'https://example.org/pool-media-{i}.mp4',
                                start=40 + i, end=60 + i, preview_start=0, preview_end=20,
                                rights=dict(status='unverified', text='Pool evidence pending.', url=None),
                                fit='Additional candidate for the next shortlist.',
                                observed='A pool candidate.'))
        return records

    def invoke_pool(self, pool, **kwargs):
        pool_path = self.root / 'pool.json'
        pool_path.write_text(json.dumps(pool))
        return self.invoke('--pool', str(pool_path), **kwargs)

    def invoke_context(self, context, **kwargs):
        context_path = self.root / 'context.json'
        context_path.write_text(json.dumps(context))
        return self.invoke('--context', str(context_path), **kwargs)

    def test_prepares_complete_static_review(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        session = json.loads((self.root / 'review/review-session.json').read_text())
        self.assertEqual(len(session['clips']), 10)
        self.assertEqual(session['brand']['name'], 'Tidal Field')
        self.assertEqual(session['brief'], 'Ocean-science campaign B-roll')
        self.assertTrue(session['fingerprint'])
        html = (self.root / 'review/index.html').read_text()
        self.assertNotIn('__SCOUT_SESSION_JSON__', html)
        self.assertNotIn('__SCOUT_POOL_JSON__', html)
        self.assertNotIn('review-pool.js', html)
        self.assertIn('Ocean-science campaign B-roll', html)
        self.assertTrue((self.root / 'review/review.js').is_file())

    def test_empty_job_brief_is_rejected(self):
        result = self.invoke(brief='   ')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('brief', result.stderr.lower())
        self.assertFalse((self.root / 'review/index.html').exists())

    def test_optional_context_is_embedded_without_changing_root_identity(self):
        self.assertEqual(self.invoke().returncode, 0)
        session_path = self.root / 'review/review-session.json'
        before = session_path.read_bytes()
        context = {'brand_read': 'Silver luggage, restrained design, spontaneous travel.',
                   'ad_target': 'Make a last-minute trip feel effortless through motion and arrival.'}
        result = self.invoke_context(context)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(session_path.read_bytes(), before)
        html = (self.root / 'review/index.html').read_text()
        self.assertNotIn('__SCOUT_CONTEXT_JSON__', html)
        start = html.index('<script type="application/json" id="review-context">')
        start = html.index('>', start) + 1
        end = html.index('</script>', start)
        self.assertEqual(json.loads(html[start:end]), context)

    def test_context_embedding_escapes_script_terminators(self):
        context = {'brand_read': '</script><script>alert(1)</script>', 'ad_target': 'A short target.'}
        result = self.invoke_context(context)
        self.assertEqual(result.returncode, 0, result.stderr)
        html = (self.root / 'review/index.html').read_text()
        self.assertNotIn('</script><script>alert(1)</script>', html)

    def test_context_word_limit_and_shape_are_rejected(self):
        too_long = {'brand_read': ' '.join(['word'] * 101), 'ad_target': 'Target'}
        result = self.invoke_context(too_long)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'review/index.html').exists())
        result = self.invoke_context({'brand_read': 'Read only'})
        self.assertNotEqual(result.returncode, 0)

    def test_missing_campaign_is_rejected(self):
        self.campaigns = []
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('campaign', result.stderr.lower())

    def test_campaign_analysis_is_required(self):
        self.assertNotEqual(self.invoke(include_analysis=False).returncode, 0)

    def test_alternate_encodings_do_not_duplicate_source_interval(self):
        self.clips[1]['source_url'] = self.clips[0]['source_url'] + '?utm_source=another'
        self.clips[1]['source_media_url'] = 'https://example.org/alternate-encoding.mp4'
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('duplicate source interval', result.stderr.lower())

    def test_meaningful_source_query_identifiers_stay_distinct(self):
        self.clips[0]['source_url'] = 'https://example.org/watch?v=film-a'
        self.clips[1]['source_url'] = 'https://example.org/watch?v=film-b'
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_same_media_under_another_source_page_is_a_duplicate(self):
        self.clips[1]['source_media_url'] = self.clips[0]['source_media_url']
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)

    def test_default_ports_and_dot_segments_do_not_bypass_source_page_identity(self):
        self.clips[1]['source_url'] = 'https://example.org:443/film-0/../film-0'
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)

    def test_default_ports_and_dot_segments_do_not_bypass_media_identity(self):
        self.clips[1]['source_url'] = 'https://example.org/another-page'
        self.clips[1]['source_media_url'] = 'https://example.org:443/full-0.mp4/../full-0.mp4'
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)

    def test_falsey_optional_urls_are_rejected(self):
        for field in ('poster_url', 'source_media_url'):
            for value in (False, 0):
                with self.subTest(field=field, value=value):
                    self.clips[0][field] = value
                    self.assertNotEqual(self.invoke().returncode, 0)
            self.clips[0].pop(field)

    def test_replacing_review_removes_obsolete_generated_media(self):
        (self.root / 'preview.mp4').write_bytes(b'old private media')
        self.clips[0]['preview_url'] = 'preview.mp4'
        self.assertEqual(self.invoke().returncode, 0)
        first = json.loads((self.root / 'review/review-session.json').read_text())
        old_preview = self.root / 'review' / first['clips'][0]['preview_url']
        self.assertTrue(old_preview.exists())
        self.clips[0]['preview_url'] = 'https://example.org/new-preview.mp4'
        self.assertEqual(self.invoke().returncode, 0)
        self.assertFalse(old_preview.exists())

    def test_unmanaged_output_files_are_preserved(self):
        out = self.root / 'review'
        out.mkdir()
        (out / 'my-notes.txt').write_text('user work')
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual((out / 'my-notes.txt').read_text(), 'user work')

    def test_pool_preserves_root_session_and_emits_tied_manifest(self):
        self.assertEqual(self.invoke().returncode, 0)
        root_session_path = self.root / 'review/review-session.json'
        root_session_bytes = root_session_path.read_bytes()
        root_session = json.loads(root_session_bytes)
        pool = {'clips': self.pool_records(),
                'initial_annotations': {'clip-0': {'tags': ['kept'], 'features': ['silver', 'rolling']}}}
        result = self.invoke_pool(pool)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(root_session_path.read_bytes(), root_session_bytes)
        manifest = json.loads((self.root / 'review/review-pool.json').read_text())
        self.assertEqual(manifest['root_session_id'], root_session['id'])
        self.assertEqual(manifest['root_fingerprint'], root_session['fingerprint'])
        self.assertEqual(len(manifest['clips']), 20)
        self.assertEqual(manifest['initial_annotations']['clip-0']['tags'], ['kept'])
        self.assertIn('BrandReferenceScoutPool', (self.root / 'review/review-pool.js').read_text())
        html = (self.root / 'review/index.html').read_text()
        self.assertNotIn('__SCOUT_POOL_JSON__', html)
        self.assertIn(manifest['pool_fingerprint'], html)
        self.assertIn('review-pool.js', html)

    def test_ten_clip_pool_can_prepare(self):
        result = self.invoke_pool({'clips': self.pool_records(count=10)})
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / 'review/review-pool.json').read_text())
        self.assertEqual(len(manifest['clips']), 10)

    def test_nineteen_clip_pool_is_rejected(self):
        result = self.invoke_pool({'clips': self.pool_records(count=19)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ten or twenty', result.stderr.lower())

    def test_replacing_pool_removes_obsolete_pool_media(self):
        (self.root / 'pool-preview.mp4').write_bytes(b'old pool media')
        first = self.invoke_pool({'clips': self.pool_records('pool-preview.mp4')})
        self.assertEqual(first.returncode, 0, first.stderr)
        manifest = json.loads((self.root / 'review/review-pool.json').read_text())
        old_media = self.root / 'review' / manifest['clips'][0]['preview_url']
        self.assertTrue(old_media.exists())
        second = self.invoke_pool({'clips': self.pool_records()})
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertFalse(old_media.exists())

    def test_missing_local_campaign_is_rejected(self):
        self.campaigns[0]['source'] = 'missing.mp4'
        self.assertNotEqual(self.invoke().returncode, 0)

    def test_ten_distinct_clips_are_required(self):
        self.clips[1] = dict(self.clips[0])
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('duplicate', result.stderr.lower())

    def test_invalid_and_nonfinite_intervals_are_rejected(self):
        for start, end in [(30, 10), (-1, 20), (float('nan'), 20), (0, float('inf'))]:
            with self.subTest(start=start, end=end):
                self.clips[0]['start'], self.clips[0]['end'] = start, end
                self.assertNotEqual(self.invoke().returncode, 0)

    def test_unsafe_media_links_are_rejected(self):
        self.clips[0]['preview_url'] = 'javascript:alert(1)'
        self.assertNotEqual(self.invoke().returncode, 0)

    def test_local_previews_are_copied_and_campaign_inputs_stay_private(self):
        (self.root / 'preview.mp4').write_bytes(b'fixture media')
        self.clips[0]['preview_url'] = 'preview.mp4'
        self.assertEqual(self.invoke().returncode, 0)
        session = json.loads((self.root / 'review/review-session.json').read_text())
        preview = self.root / 'review' / session['clips'][0]['preview_url']
        self.assertEqual(preview.read_bytes(), b'fixture media')
        self.assertFalse((self.root / 'review/campaign.svg').exists())
        self.assertNotIn(str(self.root), (self.root / 'review/review-session.json').read_text())

    def test_catalog_change_produces_different_session_fingerprint(self):
        self.assertEqual(self.invoke().returncode, 0)
        first = json.loads((self.root / 'review/review-session.json').read_text())
        self.clips[0]['end'] = 31
        self.assertEqual(self.invoke().returncode, 0)
        second = json.loads((self.root / 'review/review-session.json').read_text())
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])

    def test_embedded_json_cannot_close_script_tag(self):
        self.clips[0]['title'] = '</script><script>alert(1)</script>'
        self.assertEqual(self.invoke().returncode, 0)
        html = (self.root / 'review/index.html').read_text()
        self.assertNotIn('</script><script>alert(1)</script>', html)


if __name__ == '__main__':
    unittest.main()
