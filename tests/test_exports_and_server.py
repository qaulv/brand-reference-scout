import functools
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('scout', ROOT / 'skills/brand-reference-scout/scripts/scout.py')
scout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scout)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.clip = dict(id='water', title='Water study', source_url='https://example.org/water',
                         start=0.123456789, end=20.987654321, fit='Changing reflected forms.',
                         rights=dict(status='unverified', text='No source license found.', url=None))
        self.session = dict(title='Water campaign',
                            brief='Organic water motion', clips=[self.clip])
        fingerprint = hashlib.sha256(json.dumps(self.session, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.session.update(id='session', fingerprint=fingerprint)
        self.decisions = dict(version=1, session_id='session', session_fingerprint=fingerprint,
                              decisions={'water': 'keep'}, notes={'water': 'Use the reflection.'})

    def test_original_intervals_keep_full_precision(self):
        output = scout.markdown(self.session, self.decisions)
        self.assertIn('0.123456789', output)
        self.assertIn('20.987654321', output)
        self.assertIn('No source license found.', output)
        self.assertIn('Use the reflection.', output)

    def test_mismatched_session_export_is_rejected(self):
        self.decisions['session_fingerprint'] = 'different'
        with self.assertRaisesRegex(ValueError, 'different review'):
            scout.markdown(self.session, self.decisions)

    def test_unknown_clip_export_is_rejected(self):
        self.decisions['decisions']['another'] = 'keep'
        with self.assertRaisesRegex(ValueError, 'Invalid clip'):
            scout.markdown(self.session, self.decisions)

    def test_modified_session_cannot_reuse_its_old_fingerprint(self):
        self.session['title'] = 'Changed campaign'
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            scout.markdown(self.session, self.decisions)

    def test_non_object_decision_json_has_clear_validation_error(self):
        with self.assertRaisesRegex(ValueError, 'object'):
            scout.markdown(self.session, [])

    def test_non_object_session_json_has_clear_validation_error(self):
        with self.assertRaisesRegex(ValueError, 'object'):
            scout.markdown([], self.decisions)

    def test_undecided_clips_do_not_enter_shortlist(self):
        self.decisions['decisions'] = {}
        output = scout.markdown(self.session, self.decisions)
        self.assertIn('No clips selected.', output)
        self.assertNotIn('## Water study', output)

    def test_cumulative_pool_export_validates_identity_and_uses_pool_sources(self):
        pool_clips = [dict(id=f'pool-water-{i}', title=f'Pool water study {i}', source_url=f'https://pool.example/water-{i}',
                           source_media_url=f'https://cdn.pool.example/water-{i}.mp4',
                           start=30 + i, end=45 + i, preview_start=0, preview_end=15,
                           preview_url=f'media/pool-{i}.mp4', poster_url=None,
                           fit='A pool candidate.', observed='Pool observation.',
                           rights=dict(status='unverified', text='Pool evidence.', url=None)) for i in range(20)]
        pool_clips[0]['id'] = 'pool-water'
        pool = scout._pool_manifest(self.session, pool_clips, {})
        decisions = dict(version=1, session_id='session', session_fingerprint=self.session['fingerprint'],
                         pool_fingerprint=pool['pool_fingerprint'],
                         decisions={'water': 'keep', 'pool-water': 'keep'}, notes={})
        output = scout.markdown(self.session, decisions, pool)
        self.assertIn('## Pool water study', output)
        self.assertIn('https://pool.example/water', output)
        self.assertIn('30–45 seconds', output)

        round_export = dict(decisions, decisions={'pool-water': 'keep'}, rounds=[
            {'decisions': {'water': 'keep'}, 'notes': {'water': 'Root note.'}},
        ])
        cumulative = scout.markdown(self.session, round_export, pool)
        self.assertIn('## Water study', cumulative)
        self.assertIn('## Pool water study', cumulative)
        self.assertIn('Root note.', cumulative)

        foreign = dict(pool, root_fingerprint='different')
        with self.assertRaisesRegex(ValueError, 'different review'):
            scout.markdown(self.session, decisions, foreign)

        wrong_fingerprint = dict(pool, pool_fingerprint='different')
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            scout.markdown(self.session, decisions, wrong_fingerprint)

    def test_cumulative_pool_export_rejects_unknown_pool_decision(self):
        pool_clips = [dict(id=f'pool-water-{i}', title=f'Pool water study {i}', source_url=f'https://pool.example/water-{i}',
                           source_media_url=f'https://cdn.pool.example/water-{i}.mp4',
                           start=30 + i, end=45 + i, preview_start=0, preview_end=15,
                           preview_url=f'media/pool-{i}.mp4', poster_url=None,
                           fit='A pool candidate.', observed='Pool observation.',
                           rights=dict(status='unverified', text='Pool evidence.', url=None)) for i in range(20)]
        pool_clips[0]['id'] = 'pool-water'
        pool = scout._pool_manifest(self.session, pool_clips, {})
        decisions = dict(version=1, session_id='session', session_fingerprint=self.session['fingerprint'],
                         pool_fingerprint=pool['pool_fingerprint'], decisions={'unknown': 'keep'}, notes={})
        with self.assertRaisesRegex(ValueError, 'Invalid clip'):
            scout.markdown(self.session, decisions, pool)


class MediaServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = pathlib.Path(cls.temp.name)
        cls.public = cls.root / 'review'
        cls.public.mkdir()
        (cls.public / 'index.html').write_text('<title>Review</title>')
        (cls.public / 'clip.mp4').write_bytes(bytes(range(100)))
        (cls.root / 'private.txt').write_text('private outside review')
        (cls.public / 'escape.txt').symlink_to(cls.root / 'private.txt')
        (cls.public / 'empty').mkdir()
        (cls.public / 'nested').mkdir()
        (cls.public / 'nested/index.html').symlink_to(cls.root / 'private.txt')
        cls.server = scout.http.server.ThreadingHTTPServer(
            ('127.0.0.1', 0), functools.partial(scout.ReviewHandler, directory=str(cls.public)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def test_video_byte_range_supports_seeking(self):
        request = urllib.request.Request(self.url + '/clip.mp4', headers={'Range': 'bytes=10-19'})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers['Content-Range'], 'bytes 10-19/100')
            self.assertEqual(response.read(), bytes(range(10, 20)))

    def test_out_of_bounds_range_returns_416(self):
        request = urllib.request.Request(self.url + '/clip.mp4', headers={'Range': 'bytes=100-200'})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 416)
        error.exception.close()

    def test_symlink_cannot_read_outside_review(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.url + '/escape.txt')
        self.assertEqual(error.exception.code, 403)
        error.exception.close()

    def test_directory_listing_is_disabled(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.url + '/empty/')
        self.assertEqual(error.exception.code, 404)
        error.exception.close()

    def test_directory_index_symlink_cannot_escape_review(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.url + '/nested/')
        self.assertEqual(error.exception.code, 403)
        error.exception.close()


if __name__ == '__main__':
    unittest.main()
