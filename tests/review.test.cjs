const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const review = require('../skills/brand-reference-scout/assets/review.js');

function makeSession(overrides = {}) {
  const clips = Array.from({ length: 10 }, (_, index) => ({
    id: `clip-${index + 1}`,
    title: `Reference ${index + 1}`,
    preview_url: `/media/reference-${index + 1}.mp4`,
    poster_url: `/media/reference-${index + 1}.jpg`,
    source_url: `https://example.test/source-${index + 1}`,
    source_media_url: `https://cdn.example.test/source-${index + 1}.mp4`,
    start: index * 10,
    end: index * 10 + 8,
    preview_start: 1,
    preview_end: 7,
    rights: {
      status: index % 2 ? 'review' : 'unknown',
      text: 'Verify licence before publishing.',
      url: index % 2 ? null : `https://example.test/rights-${index + 1}`,
    },
    fit: index % 2 ? 'Possible tonal match.' : 'Strong visual rhythm.',
    observed: 'A quiet, geometric movement.',
  }));

  return {
    version: 1,
    id: 'session-alpha',
    fingerprint: 'sha256-full-fingerprint-001',
    title: 'Campaign references',
    brief: 'A precise, kinetic launch film.',
    brand: { name: 'Northline', summary: 'Quiet precision.' },
    campaign_references: [{ label: 'Launch brief', source: 'https://example.test/brief' }],
    clips,
    ...overrides,
  };
}

function makePoolManifest(session) {
  const clips = Array.from({ length: 20 }, (_, index) => ({
    ...session.clips[index % 10],
    id: `pool-${index + 1}`,
    title: `Pool reference ${index + 1}`,
    source_url: `https://pool.example.test/source-${index + 1}`,
    source_media_url: `https://pool-cdn.example.test/media-${index + 1}.mp4`,
    tags: index < 10 ? ['kinetic', 'travel'] : ['courier', 'parcel'],
    features: { tone: index < 10 ? 'kinetic' : 'handoff' },
  }));
  return {
    version: 1,
    root_session_id: session.id,
    root_fingerprint: session.fingerprint,
    pool_fingerprint: 'pool-fingerprint',
    clips,
    initial_annotations: {
      'clip-1': { tags: ['kinetic', 'travel'] },
      'clip-2': { tags: ['courier', 'parcel'] },
    },
  };
}

test('validates the shared session contract and rejects duplicate source intervals', () => {
  const session = makeSession();
  const result = review.validateSession(session);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);

  const invalid = makeSession({
    clips: [
      ...session.clips.slice(0, 9),
      { ...session.clips[9], id: 'different-id', start: 0, end: 8, source_url: session.clips[0].source_url, source_media_url: session.clips[0].source_media_url },
    ],
  });
  const invalidResult = review.validateSession(invalid);
  assert.equal(invalidResult.valid, false);
  assert.match(invalidResult.errors.join(' '), /source interval/i);
  assert.throws(() => review.assertValidSession(invalid), /source interval/i);
});

test('normalizes tracking query parameters and checks page/media interval identities', () => {
  const session = makeSession();
  const pageDuplicate = makeSession({
    clips: session.clips.map((clip, index) => index === 1
      ? { ...clip, source_url: session.clips[0].source_url + '?utm_source=mail&fbclid=ignored', start: 0, end: 8 }
      : clip),
  });
  assert.equal(review.validateSession(pageDuplicate).valid, false);

  const mediaDuplicate = makeSession({
    clips: session.clips.map((clip, index) => index === 1
      ? { ...clip, source_url: 'https://example.test/another-page', source_media_url: session.clips[0].source_media_url, start: 0, end: 8 }
      : clip),
  });
  assert.equal(review.validateSession(mediaDuplicate).valid, false);

  const meaningfulQuery = makeSession({
    clips: session.clips.map((clip, index) => index === 1
      ? { ...clip, source_url: session.clips[0].source_url + '?scene=two', source_media_url: 'https://cdn.example.test/other.mp4', start: 0, end: 8 }
      : clip),
  });
  assert.equal(review.validateSession(meaningfulQuery).valid, true);
  assert.equal(review.normalizeSourceUrl('HTTPS://Example.Test/source-1/?utm_medium=x&id=42'), 'https://example.test/source-1?id=42');
});

test('accepts nullable prepared-session media and rights URLs', () => {
  const session = makeSession({
    clips: makeSession().clips.map((clip) => ({
      ...clip,
      poster_url: null,
      source_media_url: null,
      rights: { ...clip.rights, url: null },
    })),
  });
  assert.equal(review.validateSession(session).valid, true);
});

test('all pair choices apply explicit keep/discard verdicts', () => {
  const session = makeSession();
  const expected = {
    left: ['keep', 'discard'],
    both: ['keep', 'keep'],
    right: ['discard', 'keep'],
    neither: ['discard', 'discard'],
  };

  for (const [choice, verdicts] of Object.entries(expected)) {
    const state = review.applyPairChoice(review.createInitialState(session), session, 0, choice);
    assert.deepEqual(
      [state.decisions['clip-1'], state.decisions['clip-2']],
      verdicts,
      choice,
    );
    assert.equal(state.pair_choices['0'], choice);
    assert.equal(state.completed_pairs, 1);
    assert.deepEqual(state.shortlist.map((clip) => clip.id), verdicts.includes('keep')
      ? verdicts[0] === 'keep' && verdicts[1] === 'keep'
        ? ['clip-1', 'clip-2']
        : verdicts[0] === 'keep' ? ['clip-1'] : ['clip-2']
      : []);
  }
});

test('Undo restores both prior verdicts and the prior pair choice', () => {
  const session = makeSession();
  let state = review.createInitialState(session);
  state = review.applyPairChoice(state, session, 0, 'both');
  state = review.applyPairChoice(state, session, 1, 'right');
  state = review.applyPairChoice(state, session, 0, 'left');

  state = review.undoLast(state, session);
  assert.equal(state.pair_choices['0'], 'both');
  assert.equal(state.decisions['clip-1'], 'keep');
  assert.equal(state.decisions['clip-2'], 'keep');
  assert.equal(state.completed_pairs, 2);
  assert.equal(state.history.length, 2);

  state = review.undoLast(state, session);
  assert.equal(state.pair_choices['1'], undefined);
  assert.equal(state.decisions['clip-3'], undefined);
  assert.equal(state.decisions['clip-4'], undefined);
  assert.equal(state.completed_pairs, 1);
  assert.equal(state.history.length, 1);
});

test('persistence is scoped to the full session fingerprint', () => {
  const session = makeSession();
  const storage = {
    values: new Map(),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, value); },
    removeItem(key) { this.values.delete(key); },
  };
  let state = review.applyPairChoice(review.createInitialState(session), session, 0, 'left');
  review.saveState(session, state, storage);
  assert.ok(review.storageKey(session).includes(session.fingerprint));

  const loaded = review.loadState(session, storage);
  assert.equal(loaded.decisions['clip-1'], 'keep');
  assert.equal(loaded.decisions['clip-2'], 'discard');

  const foreignSession = makeSession({ fingerprint: 'sha256-full-fingerprint-002' });
  const foreign = review.createInitialState(foreignSession);
  foreign.decisions['clip-1'] = 'discard';
  storage.setItem(review.storageKey(foreignSession), JSON.stringify(foreign));
  assert.throws(
    () => review.importState(session, foreign),
    /fingerprint/i,
  );
  assert.deepEqual(review.loadState(session, storage).decisions, state.decisions);
});

test('reload restores a completed second round when the matching pool manifest is supplied', () => {
  const session = makeSession();
  const manifest = makePoolManifest(session);
  const storage = {
    values: new Map(),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, value); },
  };
  let rootState = review.applyPairChoice(review.createInitialState(session), session, 0, 'left');
  const firstBatch = review.nextPoolBatch(session, rootState, manifest).clips;
  const roundSession = review.sessionForRound(session, { clips: firstBatch });
  let roundState = review.createInitialState(roundSession);
  roundState = review.applyPairChoice(roundState, roundSession, 0, 'both');
  const container = {
    ...rootState,
    rounds: [
      review.roundRecordFromState(session, rootState, 0, 'root'),
      review.roundRecordFromState(roundSession, roundState, 1, 'pool:1'),
    ],
    active_round: 1,
    pool_fingerprint: manifest.pool_fingerprint,
  };
  review.saveState(session, container, storage);

  const restored = review.loadState(session, storage, undefined, manifest);
  assert.equal(restored.rounds.length, 2);
  assert.equal(restored.active_round, 1);
  assert.equal(restored.rounds[1].pair_choices['0'], 'both');
  assert.equal(restored.rounds[1].clips[0].id, firstBatch[0].id);
});

test('round imports reject wrong pool fingerprints, changed records, and cross-round duplicates', () => {
  const session = makeSession();
  const manifest = makePoolManifest(session);
  let rootState = review.applyPairChoice(review.createInitialState(session), session, 0, 'left');
  const firstBatch = review.nextPoolBatch(session, rootState, manifest).clips;
  const roundSession = review.sessionForRound(session, { clips: firstBatch });
  const roundState = review.applyPairChoice(review.createInitialState(roundSession), roundSession, 0, 'both');
  const exported = review.buildJsonExport(session, {
    ...rootState,
    rounds: [
      review.roundRecordFromState(session, rootState, 0, 'root'),
      review.roundRecordFromState(roundSession, roundState, 1, 'pool:1'),
    ],
    pool_fingerprint: manifest.pool_fingerprint,
  });

  const wrongFingerprint = JSON.parse(JSON.stringify(exported));
  wrongFingerprint.pool_fingerprint = 'wrong-pool';
  assert.throws(() => review.importState(session, wrongFingerprint, manifest), /pool fingerprint/i);

  const changedPoolRights = JSON.parse(JSON.stringify(exported));
  changedPoolRights.rounds[1].clips[0].rights.text = 'Tampered rights';
  assert.throws(() => review.importState(session, changedPoolRights, manifest), /approved source record/i);

  const changedRootRights = JSON.parse(JSON.stringify(exported));
  changedRootRights.rounds[0].clips[0].rights.text = 'Tampered root rights';
  assert.throws(() => review.importState(session, changedRootRights, manifest), /approved source record/i);

  const duplicateRoundClip = JSON.parse(JSON.stringify(exported));
  duplicateRoundClip.rounds[1].clips[0] = duplicateRoundClip.rounds[0].clips[0];
  assert.throws(() => review.importState(session, duplicateRoundClip, manifest), /more than one|outside the prepared|unknown clip/i);
});

test('corrupt or unreadable stored state reports a read warning instead of claiming a clean restore', () => {
  const session = makeSession();
  let warning;
  const unreadable = { getItem() { throw new Error('read denied'); } };
  const fresh = review.loadState(session, unreadable, (error) => { warning = error; });
  assert.equal(fresh.completed_pairs, 0);
  assert.match(warning.message, /read denied/);

  warning = null;
  const corrupt = { getItem() { return '{not json'; } };
  review.loadState(session, corrupt, (error) => { warning = error; });
  assert.match(warning.message, /JSON|Unexpected/i);
});

test('exports preserve original intervals, rights, notes, and shortlist records', () => {
  const session = makeSession();
  let state = review.createInitialState(session);
  state = review.applyPairChoice(state, session, 0, 'left');
  state = review.setNote(state, session, 'clip-1', 'Use the opening movement.');

  const json = review.buildJsonExport(session, state);
  assert.equal(json.session_fingerprint, session.fingerprint);
  assert.equal(json.shortlist.length, 1);
  assert.equal(json.shortlist[0].id, 'clip-1');
  assert.equal(json.shortlist[0].start, 0);
  assert.equal(json.shortlist[0].end, 8);
  assert.deepEqual(json.shortlist[0].rights, session.clips[0].rights);
  assert.equal(json.notes['clip-1'], 'Use the opening movement.');

  const markdown = review.buildMarkdownExport(session, state);
  assert.match(markdown, /Use the opening movement/);
  assert.match(markdown, /Original interval: 0s–8s/);
  assert.match(markdown, /Verify licence before publishing/);
  assert.match(markdown, /https:\/\/example\.test\/source-1/);
});

test('Markdown exports retain full numeric interval precision', () => {
  const session = makeSession({
    clips: makeSession().clips.map((clip, index) => index === 0
      ? { ...clip, start: 1.234567890123, end: 8.765432109876, preview_start: 0.123456789012, preview_end: 7.654321098765 }
      : clip),
  });
  const state = review.applyPairChoice(review.createInitialState(session), session, 0, 'left');
  const markdown = review.buildMarkdownExport(session, state);
  assert.match(markdown, /Original interval: 1\.234567890123s–8\.765432109876s/);
  assert.match(markdown, /Preview interval: 0\.123456789012s–7\.654321098765s/);
});

test('preview bounds clamp even tiny out-of-range seeks', () => {
  assert.equal(review.clampPreviewTime(0.99999, 1, 7), 1);
  assert.equal(review.clampPreviewTime(7.00001, 1, 7), 7);
  assert.equal(review.clampPreviewTime(4.25, 1, 7), 4.25);
});

test('a denied browser storage getter falls back without throwing', () => {
  const context = {
    document: { readyState: 'loading', addEventListener() {} },
    window: {},
  };
  Object.defineProperty(context.window, 'localStorage', {
    get() { throw new Error('storage denied'); },
  });
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../skills/brand-reference-scout/assets/review.js'), 'utf8'), context);
  assert.equal(context.BrandReferenceScoutReview.storageOrDefault(), null);
});

test('context presentation uses short supplied copy and falls back only to the legacy brief', () => {
  const session = makeSession({ brief: 'Use movement and arrival to make travel feel effortless.' });
  const supplied = review.contextValues(session, {
    brand_read: 'Premium luggage with the friction removed.',
    ad_target: 'Make a last-minute trip feel effortless.',
  });
  assert.equal(supplied.brandRead, 'Premium luggage with the friction removed.');
  assert.equal(supplied.adTarget, 'Make a last-minute trip feel effortless.');

  const fallback = review.contextValues(session, { brand_read: 'A concise interpretation.' });
  assert.equal(fallback.brandRead, 'A concise interpretation.');
  assert.equal(fallback.adTarget, session.brief);
  assert.doesNotMatch(JSON.stringify(fallback), /Quiet precision/);

  const longCopy = Array.from({ length: 101 }, () => 'word').join(' ');
  assert.equal(review.compactContextText(longCopy).split(/\s+/).length, 100);
  assert.match(review.compactContextText(longCopy), /…$/);
});

test('finish requires every pair and marks the shortlist ready', () => {
  const session = makeSession();
  let state = review.createInitialState(session);
  assert.throws(() => review.finishShortlist(state, session), /every pair/i);
  for (let pairIndex = 0; pairIndex < 5; pairIndex += 1) {
    state = review.applyPairChoice(state, session, pairIndex, 'neither');
  }
  state = review.finishShortlist(state, session);
  assert.equal(state.finished, true);
  assert.equal(state.completed_pairs, 5);
  assert.equal(state.shortlist.length, 0);
});

test('completed selections retain kept clip records through import and export', () => {
  const session = makeSession();
  let state = review.createInitialState(session);
  for (const [pairIndex, choice] of ['left', 'both', 'neither', 'right', 'neither'].entries()) {
    state = review.applyPairChoice(state, session, pairIndex, choice);
  }

  assert.equal(state.completed_pairs, 5);
  assert.deepEqual(state.shortlist.map((clip) => clip.id), ['clip-1', 'clip-3', 'clip-4', 'clip-8']);
  const imported = review.importState(session, JSON.parse(JSON.stringify(state)));
  assert.deepEqual(imported.shortlist.map((clip) => clip.id), ['clip-1', 'clip-3', 'clip-4', 'clip-8']);
  assert.deepEqual(review.buildJsonExport(session, imported).shortlist.map((clip) => clip.id), imported.shortlist.map((clip) => clip.id));
});

test('prepared pool ranks positive and negative feedback and excludes shown clips', () => {
  const session = makeSession();
  const root = review.createInitialState(session);
  const clips = Array.from({ length: 20 }, (_, index) => ({
    ...session.clips[index % 10],
    id: `pool-${index + 1}`,
    title: `Pool reference ${index + 1}`,
    source_url: `https://pool.example.test/source-${index + 1}`,
    source_media_url: `https://pool-cdn.example.test/media-${index + 1}.mp4`,
    tags: index < 10 ? ['kinetic', 'travel'] : ['courier', 'parcel'],
    features: { tone: index < 10 ? 'kinetic' : 'handoff' },
  }));
  const manifest = {
    version: 1,
    root_session_id: session.id,
    root_fingerprint: session.fingerprint,
    pool_fingerprint: 'pool-fingerprint',
    clips,
    initial_annotations: {
      'clip-1': { tags: ['kinetic', 'travel'] },
      'clip-2': { tags: ['courier', 'parcel'] },
    },
  };
  assert.equal(review.validatePoolManifest(session, manifest).valid, true);
  let state = review.applyPairChoice(root, session, 0, 'left');
  state = review.applyPairChoice(state, session, 1, 'neither');
  const batch = review.nextPoolBatch(session, state, manifest);
  assert.equal(batch.clips.length, 10);
  assert.ok(batch.clips.every((clip) => !session.clips.some((rootClip) => rootClip.id === clip.id)));
  assert.equal(batch.clips[0].tags[0], 'kinetic');

  const nextSession = review.sessionForRound(session, { clips: batch.clips });
  let nextState = review.createInitialState(nextSession);
  nextState = review.applyPairChoice(nextState, nextSession, 0, 'both');
  const container = {
    ...state,
    rounds: [review.roundRecordFromState(session, state, 0, 'root'), review.roundRecordFromState(nextSession, nextState, 1, 'pool:1')],
    pool_fingerprint: manifest.pool_fingerprint,
  };
  const remaining = review.nextPoolBatch(session, container, manifest);
  assert.equal(remaining.clips.length, 10);
  assert.ok(remaining.clips.every((clip) => !batch.clips.some((shown) => shown.id === clip.id)));
  assert.equal(review.cumulativeShortlistForState(session, container).length, 3);
  const exported = review.buildJsonExport(session, container);
  assert.equal(exported.rounds.length, 2);
  assert.equal(exported.shortlist.length, 3);
  assert.match(review.buildMarkdownExport(session, container), /Pool reference/);
  const imported = review.importState(session, JSON.parse(JSON.stringify(exported)), manifest);
  assert.equal(imported.rounds.length, 2);
  assert.equal(review.cumulativeShortlistForState(session, imported).length, 3);
});

test('import validates current session identity and clip references', () => {
  const session = makeSession();
  const valid = review.applyPairChoice(review.createInitialState(session), session, 0, 'neither');
  const imported = review.importState(session, JSON.parse(JSON.stringify(valid)));
  assert.equal(imported.pair_choices['0'], 'neither');

  assert.throws(
    () => review.importState(session, { ...valid, session_id: 'other-session' }),
    /session/i,
  );
  assert.throws(
    () => review.importState(session, { ...valid, decisions: { unknown: 'keep' } }),
    /clip/i,
  );
  assert.throws(
    () => review.importState(session, { ...valid, session_fingerprint: 'not-the-session' }),
    /fingerprint/i,
  );
  assert.throws(
    () => review.importState(session, { ...valid, finished: true }),
    /five reviewed pairs/i,
  );

  const contradictoryChoice = JSON.parse(JSON.stringify(valid));
  contradictoryChoice.pair_choices['0'] = 'right';
  assert.throws(() => review.importState(session, contradictoryChoice), /contradict/i);

  const contradictoryHistory = JSON.parse(JSON.stringify(valid));
  contradictoryHistory.history[0].previous_decisions['clip-1'] = 'keep';
  assert.throws(() => review.importState(session, contradictoryHistory), /previous_decisions/i);

  const contractHistory = JSON.parse(JSON.stringify(valid));
  delete contractHistory.history[0].previous_choice;
  const importedContractHistory = review.importState(session, contractHistory);
  assert.equal(review.undoLast(importedContractHistory, session).completed_pairs, 0);
});
