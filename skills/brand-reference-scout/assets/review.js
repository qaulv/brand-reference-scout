(function attachReviewModel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(false);
  } else {
    root.BrandReferenceScoutReview = factory(true);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createReviewModule(isBrowser) {
  'use strict';

  var SESSION_VERSION = 1;
  var DECISIONS_VERSION = 1;
  var PAIR_CHOICES = ['left', 'both', 'right', 'neither'];
  var DECISIONS = ['keep', 'discard'];

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function now() {
    return new Date().toISOString();
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function normalizeSourceUrl(value) {
    var raw = String(value);
    try {
      var parsed = new URL(raw);
      var query = [];
      parsed.searchParams.forEach(function keepMeaningfulQuery(queryValue, queryKey) {
        if (!queryKey.toLowerCase().startsWith('utm_') && queryKey.toLowerCase() !== 'fbclid' && queryKey.toLowerCase() !== 'gclid') {
          query.push([queryKey, queryValue]);
        }
      });
      query.sort(function sortQuery(left, right) {
        return left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]);
      });
      var encodedQuery = query.map(function encodeQuery(pair) {
        return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]);
      }).join('&');
      var path = parsed.pathname.replace(/\/+$/, '');
      return parsed.protocol.toLowerCase() + '//' + parsed.host.toLowerCase() + path + (encodedQuery ? '?' + encodedQuery : '');
    } catch (error) {
      return raw.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    }
  }

  function number(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function addError(errors, message) {
    errors.push(message);
  }

  function getSessionValidationErrors(session) {
    var errors = [];
    if (!isObject(session)) return ['Session must be a JSON object.'];
    if (session.version !== SESSION_VERSION) addError(errors, 'Session version must be 1.');
    ['id', 'title', 'brief', 'fingerprint'].forEach(function checkField(field) {
      if (!nonEmptyString(session[field])) addError(errors, 'Session ' + field + ' must be a non-empty string.');
    });
    if (!isObject(session.brand)) {
      addError(errors, 'Session brand must be an object.');
    } else {
      if (!nonEmptyString(session.brand.name)) addError(errors, 'Brand name must be a non-empty string.');
      if (!nonEmptyString(session.brand.summary)) addError(errors, 'Brand summary must be a non-empty string.');
    }
    if (!Array.isArray(session.campaign_references)) {
      addError(errors, 'campaign_references must be an array.');
    } else {
      session.campaign_references.forEach(function checkReference(reference, index) {
        if (!isObject(reference) || !nonEmptyString(reference.label) || !nonEmptyString(reference.source)) {
          addError(errors, 'Campaign reference ' + index + ' needs label and source.');
        }
      });
    }
    if (!Array.isArray(session.clips) || session.clips.length !== 10) {
      addError(errors, 'Session must contain exactly ten clips.');
      return errors;
    }

    var ids = new Set();
    var intervals = new Set();
    var sourcePageIntervals = new Set();
    var sourceMediaIntervals = new Set();
    session.clips.forEach(function checkClip(clip, index) {
      var label = 'Clip ' + index;
      if (!isObject(clip)) {
        addError(errors, label + ' must be an object.');
        return;
      }
      if (!nonEmptyString(clip.id)) addError(errors, label + ' id must be a non-empty string.');
      else if (ids.has(clip.id)) addError(errors, 'Duplicate clip id: ' + clip.id + '.');
      else ids.add(clip.id);
      ['title', 'preview_url', 'source_url', 'fit'].forEach(function checkClipField(field) {
        if (!nonEmptyString(clip[field])) addError(errors, label + ' ' + field + ' must be a non-empty string.');
      });
      ['poster_url', 'source_media_url', 'observed'].forEach(function checkOptionalField(field) {
        if (clip[field] !== undefined && clip[field] !== null && typeof clip[field] !== 'string') {
          addError(errors, label + ' ' + field + ' must be a string when present.');
        }
      });
      if (!number(clip.start) || !number(clip.end) || clip.start < 0 || clip.end <= clip.start) {
        addError(errors, label + ' original interval must be finite, non-negative, and end after start.');
      }
      if (!number(clip.preview_start) || !number(clip.preview_end) || clip.preview_start < 0 || clip.preview_end <= clip.preview_start) {
        addError(errors, label + ' preview interval must be finite, non-negative, and end after start.');
      }
      var intervalSource = clip.source_media_url || clip.source_url;
      var intervalKey = [intervalSource, clip.start, clip.end].join('\u001f');
      var pageKey = [normalizeSourceUrl(clip.source_url), clip.start, clip.end].join('\u001f');
      var mediaKey = clip.source_media_url ? [normalizeSourceUrl(clip.source_media_url), clip.start, clip.end].join('\u001f') : null;
      if (intervals.has(intervalKey) || sourcePageIntervals.has(pageKey) || (mediaKey && sourceMediaIntervals.has(mediaKey))) {
        addError(errors, 'Duplicate source interval for ' + intervalSource + '.');
      } else {
        intervals.add(intervalKey);
      }
      sourcePageIntervals.add(pageKey);
      if (mediaKey) sourceMediaIntervals.add(mediaKey);
      if (!isObject(clip.rights)) {
        addError(errors, label + ' rights must be an object.');
      } else {
        ['status', 'text', 'url'].forEach(function checkRightsField(field) {
          if (field === 'url' && (clip.rights[field] === null || clip.rights[field] === undefined)) return;
          if (typeof clip.rights[field] !== 'string') addError(errors, label + ' rights.' + field + ' must be a string when present.');
        });
      }
    });
    return errors;
  }

  function validateSession(session) {
    var errors = getSessionValidationErrors(session);
    return { valid: errors.length === 0, errors: errors };
  }

  function assertValidSession(session) {
    var result = validateSession(session);
    if (!result.valid) throw new Error('Invalid session: ' + result.errors.join(' '));
    return session;
  }

  function isValidSession(session) {
    return validateSession(session).valid;
  }

  function getPair(session, pairIndex) {
    var first = pairIndex * 2;
    if (!Number.isInteger(pairIndex) || pairIndex < 0 || first + 1 >= session.clips.length) {
      throw new Error('Pair index is out of range.');
    }
    return [session.clips[first], session.clips[first + 1]];
  }

  function pairKey(pairIndex) {
    return String(pairIndex);
  }

  function countReviewedPairs(pairChoices) {
    return Object.keys(pairChoices || {}).filter(function hasChoice(key) {
      return PAIR_CHOICES.indexOf(pairChoices[key]) !== -1;
    }).length;
  }

  function choiceForDecisions(left, right) {
    if (left === 'keep' && right === 'keep') return 'both';
    if (left === 'keep' && right === 'discard') return 'left';
    if (left === 'discard' && right === 'keep') return 'right';
    if (left === 'discard' && right === 'discard') return 'neither';
    return null;
  }

  function pairChoiceLabel(choice) {
    return {
      left: 'Left kept',
      both: 'Both kept',
      right: 'Right kept',
      neither: 'Neither kept',
    }[choice] || 'Choose what to keep';
  }

  function verdictsForChoice(choice) {
    return {
      left: ['keep', 'discard'],
      both: ['keep', 'keep'],
      right: ['discard', 'keep'],
      neither: ['discard', 'discard'],
    }[choice] || null;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function mapsEqual(left, right) {
    var leftKeys = Object.keys(left || {});
    var rightKeys = Object.keys(right || {});
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(function sameValue(key) {
      return hasOwn(right || {}, key) && left[key] === right[key];
    });
  }

  function pairChoiceFromState(state, session, pairIndex) {
    var key = pairKey(pairIndex);
    if (state.pair_choices && PAIR_CHOICES.indexOf(state.pair_choices[key]) !== -1) {
      return state.pair_choices[key];
    }
    var pair = getPair(session, pairIndex);
    var decisions = isObject(state.decisions) ? state.decisions : {};
    return choiceForDecisions(decisions[pair[0].id], decisions[pair[1].id]);
  }

  function derivePairChoices(state, session) {
    var choices = {};
    for (var index = 0; index < session.clips.length / 2; index += 1) {
      var choice = pairChoiceFromState(state, session, index);
      if (choice) choices[pairKey(index)] = choice;
    }
    return choices;
  }

  function deriveShortlist(session, state) {
    return session.clips.filter(function isKept(clip) {
      return state.decisions && state.decisions[clip.id] === 'keep';
    }).map(function copyClip(clip) {
      return clone(clip);
    });
  }

  function roundRecordFromState(session, state, roundIndex, roundKey) {
    return {
      round_index: roundIndex,
      round_key: roundKey || (roundIndex === 0 ? 'root' : String(roundIndex)),
      session_id: session.id,
      session_fingerprint: session.fingerprint,
      clip_ids: session.clips.map(function clipId(clip) { return clip.id; }),
      clips: clone(session.clips),
      decisions: clone(state.decisions || {}),
      notes: clone(state.notes || {}),
      history: clone(state.history || []),
      completed_pairs: state.completed_pairs || 0,
      pair_choices: clone(state.pair_choices || {}),
      shortlist: deriveShortlist(session, state),
      finished: Boolean(state.finished),
      updated_at: state.updated_at || now(),
    };
  }

  function stateFromRoundRecord(record, session) {
    var candidate = {
      version: DECISIONS_VERSION,
      session_id: session.id,
      session_fingerprint: session.fingerprint,
      updated_at: record.updated_at || now(),
      decisions: isObject(record.decisions) ? clone(record.decisions) : {},
      notes: isObject(record.notes) ? clone(record.notes) : {},
      history: Array.isArray(record.history) ? clone(record.history) : [],
      completed_pairs: Number.isInteger(record.completed_pairs) ? record.completed_pairs : 0,
      pair_choices: isObject(record.pair_choices) ? clone(record.pair_choices) : {},
      shortlist: Array.isArray(record.shortlist) ? clone(record.shortlist) : [],
      finished: Boolean(record.finished),
    };
    var validation = validatePersistedState(candidate, session);
    if (!validation.valid) throw new Error(validation.errors.join(' '));
    return normalizeState(candidate, session);
  }

  function migrateRoundRecords(session, state) {
    var source = Array.isArray(state.rounds) && state.rounds.length
      ? state.rounds
      : [roundRecordFromState(session, state, 0, 'root')];
    return source.map(function migrateRound(record, index) {
      if (!isObject(record)) throw new Error('Saved review round ' + index + ' must be an object.');
      var round = clone(record);
      if (!Array.isArray(round.clips) && index === 0) round.clips = clone(session.clips);
      if (!Array.isArray(round.clips) || round.clips.length !== session.clips.length) throw new Error('Saved review round ' + index + ' does not contain ten clips.');
      var roundSession = sessionForRound(session, round);
      assertValidSession(roundSession);
      var roundState = stateFromRoundRecord(round, roundSession);
      return roundRecordFromState(roundSession, roundState, index, round.round_key || (index === 0 ? 'root' : String(index)));
    });
  }

  function deepValuesEqual(left, right) {
    if (left === right) return true;
    if (typeof left !== typeof right || left === null || right === null) return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      return left.every(function sameArrayValue(value, index) { return deepValuesEqual(value, right[index]); });
    }
    if (typeof left !== 'object') return false;
    var leftKeys = Object.keys(left).sort();
    var rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(function sameObjectValue(key, index) {
      return key === rightKeys[index] && deepValuesEqual(left[key], right[key]);
    });
  }

  function validateRoundRecordsAgainstPool(session, rounds, manifest, poolFingerprint) {
    if (!Array.isArray(rounds) || !rounds.length) return { valid: true, errors: [] };
    var errors = [];
    var hasAdditionalRounds = rounds.length > 1;
    if (hasAdditionalRounds && (!manifest || !Array.isArray(manifest.clips))) {
      return { valid: false, errors: ['Additional review rounds require the matching prepared candidate pool.'] };
    }
    if (hasAdditionalRounds && poolFingerprint !== undefined && poolFingerprint !== manifest.pool_fingerprint) {
      errors.push('Additional review rounds require the matching prepared candidate pool fingerprint.');
    }
    var rootApproved = new Map(session.clips.map(function approvedRootClip(clip) { return [clip.id, clip]; }));
    var poolApproved = manifest && Array.isArray(manifest.clips)
      ? new Map(manifest.clips.map(function approvedPoolClip(clip) { return [clip.id, clip]; }))
      : new Map();
    var seenIds = new Set();
    rounds.forEach(function validateRound(round, roundIndex) {
      if (!isObject(round) || !Array.isArray(round.clips) || round.clips.length !== session.clips.length) {
        errors.push('Review round ' + (roundIndex + 1) + ' must contain exactly ten clips.');
        return;
      }
      var clipIds = round.clips.map(function roundClipId(clip) { return isObject(clip) ? clip.id : null; });
      if (round.clip_ids !== undefined && (!Array.isArray(round.clip_ids) || !deepValuesEqual(round.clip_ids, clipIds))) {
        errors.push('Review round ' + (roundIndex + 1) + ' clip_ids do not match its clip records.');
      }
      var approved = roundIndex === 0 ? rootApproved : poolApproved;
      round.clips.forEach(function validateRoundClip(clip) {
        if (!isObject(clip) || !nonEmptyString(clip.id)) {
          errors.push('Review round ' + (roundIndex + 1) + ' contains an invalid clip record.');
          return;
        }
        if (seenIds.has(clip.id)) errors.push('Clip ' + clip.id + ' appears in more than one review round.');
        seenIds.add(clip.id);
        var candidate = approved.get(clip.id);
        if (!candidate) {
          errors.push(roundIndex === 0
            ? 'Root review round contains a clip outside the current session.'
            : 'Review round ' + (roundIndex + 1) + ' contains a clip outside the prepared candidate pool.');
          return;
        }
        if (!deepValuesEqual(candidate, clip)) {
          errors.push('Review round ' + (roundIndex + 1) + ' changed the approved source record for ' + clip.id + '.');
        }
      });
    });
    return { valid: errors.length === 0, errors: errors };
  }

  function roundRecordsForState(session, state) {
    if (Array.isArray(state.rounds) && state.rounds.length) return state.rounds;
    return [roundRecordFromState(session, state, 0, 'root')];
  }

  function cumulativeNotesForState(session, state) {
    var notes = {};
    roundRecordsForState(session, state).forEach(function mergeRoundNotes(round) {
      if (!isObject(round.notes)) return;
      Object.keys(round.notes).forEach(function mergeNote(id) {
        if (typeof round.notes[id] === 'string' && round.notes[id].trim()) notes[id] = round.notes[id];
      });
    });
    return notes;
  }

  function cumulativeShortlistForState(session, state) {
    var shortlist = [];
    var seen = new Set();
    roundRecordsForState(session, state).forEach(function collectRoundShortlist(round, roundIndex) {
      var clips = Array.isArray(round.clips) ? round.clips : (roundIndex === 0 ? session.clips : []);
      var decisions = isObject(round.decisions) ? round.decisions : {};
      clips.forEach(function collectClip(clip) {
        if (!isObject(clip) || decisions[clip.id] !== 'keep' || seen.has(clip.id)) return;
        seen.add(clip.id);
        shortlist.push(clone(clip));
      });
    });
    return shortlist;
  }

  function activePairIndex(session, state) {
    for (var index = 0; index < session.clips.length / 2; index += 1) {
      if (!pairChoiceFromState(state, session, index)) return index;
    }
    return session.clips.length / 2;
  }

  function createInitialState(session) {
    assertValidSession(session);
    var state = {
      version: DECISIONS_VERSION,
      session_id: session.id,
      session_fingerprint: session.fingerprint,
      updated_at: now(),
      decisions: {},
      notes: {},
      history: [],
      completed_pairs: 0,
      pair_choices: {},
      shortlist: [],
      finished: false,
    };
    state.active_pair = 0;
    return state;
  }

  function validatePersistedState(state, session) {
    var errors = [];
    if (!isObject(state)) return { valid: false, errors: ['Review state must be a JSON object.'] };
    if (state.version !== DECISIONS_VERSION) addError(errors, 'Review state version must be 1.');
    if (state.session_id !== session.id) addError(errors, 'Review state session id does not match this session.');
    if (state.session_fingerprint !== session.fingerprint) addError(errors, 'Review state fingerprint does not match this session.');
    if (!nonEmptyString(state.updated_at)) addError(errors, 'Review state updated_at must be a non-empty string.');
    var knownStateClipIds = new Set(session.clips.map(function knownRootId(clip) { return clip.id; }));
    if (state.rounds !== undefined && !Array.isArray(state.rounds)) addError(errors, 'Review state rounds must be an array.');
    if (Array.isArray(state.rounds)) state.rounds.forEach(function collectRoundIds(round) {
      if (isObject(round) && Array.isArray(round.clips)) round.clips.forEach(function collectRoundClip(clip) {
        if (isObject(clip) && nonEmptyString(clip.id)) knownStateClipIds.add(clip.id);
      });
    });
    ['decisions', 'notes'].forEach(function checkMap(field) {
      if (!isObject(state[field])) addError(errors, 'Review state ' + field + ' must be an object.');
    });
    if (!Array.isArray(state.history)) addError(errors, 'Review state history must be an array.');
    if (!Number.isInteger(state.completed_pairs) || state.completed_pairs < 0 || state.completed_pairs > 5) {
      addError(errors, 'Review state completed_pairs must be an integer from 0 to 5.');
    }
    if (state.pair_choices !== undefined && !isObject(state.pair_choices)) {
      addError(errors, 'Review state pair_choices must be an object.');
    }

    if (isObject(state.decisions)) {
      Object.keys(state.decisions).forEach(function checkDecision(id) {
        if (!knownStateClipIds.has(id)) addError(errors, 'Decision references unknown clip ' + id + '.');
        if (DECISIONS.indexOf(state.decisions[id]) === -1) addError(errors, 'Decision for ' + id + ' must be keep or discard.');
      });
    }
    if (isObject(state.notes)) {
      Object.keys(state.notes).forEach(function checkNote(id) {
        if (!knownStateClipIds.has(id)) addError(errors, 'Note references unknown clip ' + id + '.');
        if (typeof state.notes[id] !== 'string') addError(errors, 'Note for ' + id + ' must be a string.');
      });
    }
    var pairChoices = state.pair_choices || derivePairChoices(state, session);
    if (isObject(pairChoices)) {
      Object.keys(pairChoices).forEach(function checkPairChoice(key) {
        var index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= 5) addError(errors, 'Pair choice index ' + key + ' is out of range.');
        if (PAIR_CHOICES.indexOf(pairChoices[key]) === -1) addError(errors, 'Pair choice ' + key + ' is invalid.');
      });
      if (Number.isInteger(state.completed_pairs) && state.completed_pairs !== countReviewedPairs(pairChoices)) {
        addError(errors, 'completed_pairs does not match the pair choices.');
      }
      var decisionsMap = isObject(state.decisions) ? state.decisions : {};
      for (var pairIndex = 0; pairIndex < 5; pairIndex += 1) {
        var pair = getPair(session, pairIndex);
        var pairChoice = pairChoices[pairKey(pairIndex)];
        var leftPresent = hasOwn(decisionsMap, pair[0].id);
        var rightPresent = hasOwn(decisionsMap, pair[1].id);
        if (leftPresent !== rightPresent) {
          addError(errors, 'Pair ' + pairIndex + ' has only one imported clip decision.');
          continue;
        }
        if (PAIR_CHOICES.indexOf(pairChoice) !== -1) {
          var expectedVerdicts = verdictsForChoice(pairChoice);
          if (!leftPresent || decisionsMap[pair[0].id] !== expectedVerdicts[0] || decisionsMap[pair[1].id] !== expectedVerdicts[1]) {
            addError(errors, 'Pair choice ' + pairIndex + ' contradicts its clip decisions.');
          }
        } else if (leftPresent) {
          addError(errors, 'Pair ' + pairIndex + ' has decisions without a matching pair choice.');
        }
      }
    }
    if (Array.isArray(state.history)) {
      state.history.forEach(function checkHistory(entry, historyIndex) {
        if (!isObject(entry)) {
          addError(errors, 'History entry ' + historyIndex + ' must be an object.');
          return;
        }
        if (!Number.isInteger(entry.pair_index) || entry.pair_index < 0 || entry.pair_index >= 5) addError(errors, 'History entry ' + historyIndex + ' has an invalid pair index.');
        if (PAIR_CHOICES.indexOf(entry.choice) === -1) addError(errors, 'History entry ' + historyIndex + ' has an invalid choice.');
        if (!isObject(entry.previous_decisions)) addError(errors, 'History entry ' + historyIndex + ' needs previous_decisions.');
        else Object.keys(entry.previous_decisions).forEach(function checkPrevious(id) {
          if (!knownStateClipIds.has(id)) addError(errors, 'History entry references unknown clip ' + id + '.');
          if (entry.previous_decisions[id] !== null && DECISIONS.indexOf(entry.previous_decisions[id]) === -1) addError(errors, 'History entry has an invalid previous decision.');
        });
        if (entry.previous_choice !== undefined && entry.previous_choice !== null && PAIR_CHOICES.indexOf(entry.previous_choice) === -1) addError(errors, 'History entry has an invalid previous choice.');
      });

      // History is an undo log, so replay it and require the imported state to
      // agree with every prior pair verdict and the final pair map.
      var replayDecisions = {};
      var replayChoices = {};
      state.history.forEach(function replayHistory(entry, historyIndex) {
        if (!isObject(entry) || !Number.isInteger(entry.pair_index) || entry.pair_index < 0 || entry.pair_index >= 5 || PAIR_CHOICES.indexOf(entry.choice) === -1) return;
        var pair = getPair(session, entry.pair_index);
        var key = pairKey(entry.pair_index);
        var expectedPreviousChoice = replayChoices[key] || null;
        var previousDecisions = isObject(entry.previous_decisions) ? entry.previous_decisions : {};
        var recordedPreviousChoice = entry.previous_choice !== undefined
          ? entry.previous_choice
          : choiceForDecisions(previousDecisions[pair[0].id], previousDecisions[pair[1].id]);
        if ((recordedPreviousChoice || null) !== expectedPreviousChoice) {
          addError(errors, 'History entry ' + historyIndex + ' previous_choice does not match the preceding pair state.');
        }
        pair.forEach(function checkPreviousDecision(clip) {
          var expected = replayDecisions[clip.id] || null;
          if (!isObject(entry.previous_decisions) || !hasOwn(entry.previous_decisions, clip.id) || (entry.previous_decisions[clip.id] || null) !== expected) {
            addError(errors, 'History entry ' + historyIndex + ' previous_decisions do not match the preceding pair state.');
          }
        });
        var verdicts = verdictsForChoice(entry.choice);
        replayDecisions[pair[0].id] = verdicts[0];
        replayDecisions[pair[1].id] = verdicts[1];
        replayChoices[key] = entry.choice;
      });
      var importedChoices = state.pair_choices || derivePairChoices(state, session);
      if (!mapsEqual(replayDecisions, state.decisions)) addError(errors, 'History does not reconstruct the imported decisions.');
      if (!mapsEqual(replayChoices, importedChoices)) addError(errors, 'History does not reconstruct the imported pair choices.');
    }
    if (state.shortlist !== undefined) {
      if (!Array.isArray(state.shortlist)) addError(errors, 'Review state shortlist must be an array.');
      else state.shortlist.forEach(function checkShortlist(clip) {
        if (!isObject(clip) || !knownStateClipIds.has(clip.id)) addError(errors, 'Shortlist contains an unknown clip.');
      });
    }
    if (state.finished !== undefined && typeof state.finished !== 'boolean') addError(errors, 'Review state finished must be boolean.');
    if (state.finished === true && state.completed_pairs !== 5) addError(errors, 'Finished review state must contain all five reviewed pairs.');
    return { valid: errors.length === 0, errors: errors };
  }

  function assertStateForSession(state, session) {
    var result = validatePersistedState(state, session);
    if (!result.valid) throw new Error('Invalid review state: ' + result.errors.join(' '));
    return state;
  }

  function normalizeState(state, session) {
    var normalized = clone(state);
    normalized.pair_choices = derivePairChoices(normalized, session);
    normalized.completed_pairs = countReviewedPairs(normalized.pair_choices);
    normalized.shortlist = deriveShortlist(session, normalized);
    normalized.active_pair = activePairIndex(session, normalized);
    if (normalized.finished === undefined) normalized.finished = false;
    if (!nonEmptyString(normalized.updated_at)) normalized.updated_at = now();
    return normalized;
  }

  function applyPairChoice(state, session, pairIndex, choice) {
    assertValidSession(session);
    assertStateForSession(state, session);
    if (PAIR_CHOICES.indexOf(choice) === -1) throw new Error('Pair choice must be left, both, right, or neither.');
    var pair = getPair(session, pairIndex);
    var next = clone(state);
    var previousChoice = pairChoiceFromState(state, session, pairIndex);
    var previousDecisions = {};
    pair.forEach(function remember(clip) {
      previousDecisions[clip.id] = state.decisions[clip.id] || null;
    });
    var verdicts = verdictsForChoice(choice);
    next.decisions[pair[0].id] = verdicts[0];
    next.decisions[pair[1].id] = verdicts[1];
    next.pair_choices[pairKey(pairIndex)] = choice;
    next.history.push({
      pair_index: pairIndex,
      choice: choice,
      previous_choice: previousChoice,
      previous_decisions: previousDecisions,
    });
    next.finished = false;
    next.updated_at = now();
    return normalizeState(next, session);
  }

  function setNote(state, session, clipId, note) {
    assertValidSession(session);
    assertStateForSession(state, session);
    if (!session.clips.some(function hasClip(clip) { return clip.id === clipId; })) throw new Error('Cannot add a note to an unknown clip.');
    var next = clone(state);
    var text = String(note === undefined || note === null ? '' : note);
    if (text.trim()) next.notes[clipId] = text;
    else delete next.notes[clipId];
    next.shortlist = deriveShortlist(session, next);
    next.updated_at = now();
    return next;
  }

  function undoLast(state, session) {
    assertValidSession(session);
    assertStateForSession(state, session);
    if (!state.history.length) return clone(state);
    var next = clone(state);
    var entry = next.history.pop();
    var pair = getPair(session, entry.pair_index);
    pair.forEach(function restore(clip) {
      var oldValue = entry.previous_decisions ? entry.previous_decisions[clip.id] : null;
      if (oldValue === 'keep' || oldValue === 'discard') next.decisions[clip.id] = oldValue;
      else delete next.decisions[clip.id];
    });
    var previousChoice = entry.previous_choice !== undefined
      ? entry.previous_choice
      : choiceForDecisions(entry.previous_decisions && entry.previous_decisions[pair[0].id], entry.previous_decisions && entry.previous_decisions[pair[1].id]);
    if (previousChoice) next.pair_choices[pairKey(entry.pair_index)] = previousChoice;
    else delete next.pair_choices[pairKey(entry.pair_index)];
    next.finished = false;
    next.updated_at = now();
    return normalizeState(next, session);
  }

  function finishShortlist(state, session) {
    assertValidSession(session);
    assertStateForSession(state, session);
    var normalized = normalizeState(state, session);
    if (normalized.completed_pairs !== session.clips.length / 2) throw new Error('Review every pair before finishing the shortlist.');
    normalized.finished = true;
    normalized.updated_at = now();
    return normalized;
  }

  function storageKey(session) {
    assertValidSession(session);
    return 'brand-reference-scout:review:' + session.id + ':' + session.fingerprint;
  }

  function storageOrDefault(storage) {
    if (storage) return storage;
    if (isBrowser && typeof window !== 'undefined') {
      try {
        return window.localStorage || null;
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  function saveState(session, state, storage) {
    assertValidSession(session);
    assertStateForSession(state, session);
    var target = storageOrDefault(storage);
    if (!target) throw new Error('Persistent browser storage is unavailable.');
    var next = normalizeState(state, session);
    next.updated_at = now();
    target.setItem(storageKey(session), JSON.stringify(next));
    return next;
  }

  function rootStateFallback(session, payload) {
    if (!isObject(payload)) return null;
    var candidate = clone(payload);
    if (Array.isArray(payload.rounds) && payload.rounds.length && isObject(payload.rounds[0])) {
      var rootRound = payload.rounds[0];
      candidate = {
        version: payload.version,
        session_id: payload.session_id,
        session_fingerprint: payload.session_fingerprint,
        updated_at: rootRound.updated_at || payload.updated_at,
        decisions: clone(rootRound.decisions || {}),
        notes: clone(rootRound.notes || {}),
        history: clone(rootRound.history || []),
        completed_pairs: rootRound.completed_pairs,
        pair_choices: clone(rootRound.pair_choices || {}),
        shortlist: clone(rootRound.shortlist || []),
        finished: Boolean(rootRound.finished),
      };
    }
    var result = validatePersistedState(candidate, session);
    return result.valid ? normalizeState(candidate, session) : null;
  }

  function loadState(session, storage, onReadError, poolManifest) {
    assertValidSession(session);
    var target = storageOrDefault(storage);
    if (!target) return createInitialState(session);
    var raw;
    try {
      raw = target.getItem(storageKey(session));
      if (!raw) return createInitialState(session);
      var parsed = JSON.parse(raw);
      return importState(session, parsed, poolManifest || null);
    } catch (error) {
      if (typeof onReadError === 'function') onReadError(error);
      // A changed or unavailable candidate pool must not erase the completed
      // root review. Keep only the canonical root round and let the caller
      // surface that the additional rounds need a fresh matching pool.
      try {
        var fallback = rootStateFallback(session, parsed);
        if (fallback) return fallback;
      } catch (fallbackError) {
        // Fall through to a clean state for corrupt or invalid root data.
      }
      return createInitialState(session);
    }
  }

  function clearState(session, storage) {
    var target = storageOrDefault(storage);
    if (target) target.removeItem(storageKey(session));
  }

  function importState(session, payload, poolManifest) {
    assertValidSession(session);
    var parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    var result = validatePersistedState(parsed, session);
    if (!result.valid) throw new Error('Cannot import review state: ' + result.errors.join(' '));
    var normalized = normalizeState(parsed, session);
    if (Array.isArray(normalized.rounds) && normalized.rounds.length > 1 && (!nonEmptyString(normalized.pool_fingerprint) || !poolManifest || normalized.pool_fingerprint !== poolManifest.pool_fingerprint)) {
      throw new Error('Cannot import review state: Additional review rounds require the matching prepared candidate pool fingerprint.');
    }
    var poolValidation = validateRoundRecordsAgainstPool(session, normalized.rounds, poolManifest || null, normalized.pool_fingerprint);
    if (!poolValidation.valid) throw new Error('Cannot import review state: ' + poolValidation.errors.join(' '));
    return normalized;
  }

  function buildJsonExport(session, state) {
    assertValidSession(session);
    assertStateForSession(state, session);
    var normalized = normalizeState(state, session);
    var exported = {
      version: DECISIONS_VERSION,
      session_id: session.id,
      session_fingerprint: session.fingerprint,
      updated_at: normalized.updated_at,
      decisions: clone(normalized.decisions),
      notes: clone(normalized.notes),
      history: clone(normalized.history),
      completed_pairs: normalized.completed_pairs,
      pair_choices: clone(normalized.pair_choices),
      finished: Boolean(normalized.finished),
      title: session.title,
      brief: session.brief,
      brand: clone(session.brand),
      campaign_references: clone(session.campaign_references),
      shortlist: cumulativeShortlistForState(session, normalized),
    };
    exported.notes = cumulativeNotesForState(session, normalized);
    if (Array.isArray(normalized.rounds) && normalized.rounds.length) {
      exported.rounds = clone(normalized.rounds);
      exported.active_round = Number.isInteger(normalized.active_round) ? normalized.active_round : 0;
      exported.campaign_key = normalized.campaign_key || session.fingerprint;
      if (nonEmptyString(normalized.pool_fingerprint)) exported.pool_fingerprint = normalized.pool_fingerprint;
    }
    return exported;
  }

  function formatSeconds(value) {
    var rounded = Math.round(value * 100) / 100;
    return String(rounded).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') + 's';
  }

  function formatExportSeconds(value) {
    return String(value) + 's';
  }

  function clampPreviewTime(value, start, end) {
    if (!Number.isFinite(value)) return start;
    return Math.max(start, Math.min(end, value));
  }

  function markdownLine(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  }

  function buildMarkdownExport(session, state) {
    var exported = buildJsonExport(session, state);
    var lines = [
      '# ' + markdownLine(session.title),
      '',
      '**Brand:** ' + markdownLine(session.brand.name),
      '**Session:** ' + markdownLine(session.id),
      '**Fingerprint:** ' + markdownLine(session.fingerprint),
      '**Reviewed pairs:** ' + exported.completed_pairs + '/5',
      '',
      '## Shortlist',
      '',
    ];
    if (!exported.shortlist.length) lines.push('_No clips kept yet._', '');
    exported.shortlist.forEach(function addClip(clip, index) {
      var note = exported.notes[clip.id];
      lines.push('### ' + String(index + 1).padStart(2, '0') + ' — ' + markdownLine(clip.title));
      lines.push('- Fit: ' + markdownLine(clip.fit));
      if (clip.observed) lines.push('- Observed: ' + markdownLine(clip.observed));
      lines.push('- Original interval: ' + formatExportSeconds(clip.start) + '–' + formatExportSeconds(clip.end));
      lines.push('- Preview interval: ' + formatExportSeconds(clip.preview_start) + '–' + formatExportSeconds(clip.preview_end));
      lines.push('- Source: [' + markdownLine(clip.source_url) + '](' + clip.source_url + ')');
      if (clip.source_media_url) lines.push('- Source media: [' + markdownLine(clip.source_media_url) + '](' + clip.source_media_url + ')');
      lines.push('- Rights: ' + markdownLine(clip.rights.status) + ' — ' + markdownLine(clip.rights.text));
      if (clip.rights.url) lines.push('- Rights reference: [' + markdownLine(clip.rights.url) + '](' + clip.rights.url + ')');
      if (note) lines.push('- Note: ' + markdownLine(note));
      lines.push('');
    });
    return lines.join('\n');
  }

  function serializeJsonExport(session, state) {
    return JSON.stringify(buildJsonExport(session, state), null, 2) + '\n';
  }

  function sessionForRound(session, round) {
    var next = clone(session);
    next.clips = clone(round.clips || []);
    return next;
  }

  function getPoolManifestErrors(session, manifest) {
    var errors = [];
    if (!isObject(manifest)) return ['Candidate pool is not a JSON object.'];
    if (manifest.version !== 1) errors.push('Candidate pool version must be 1.');
    if (manifest.root_session_id !== session.id || manifest.root_fingerprint !== session.fingerprint) {
      errors.push('Candidate pool belongs to a different review session or fingerprint.');
    }
    if (!nonEmptyString(manifest.pool_fingerprint)) errors.push('Candidate pool fingerprint is missing.');
    if (!Array.isArray(manifest.clips)) {
      errors.push('Candidate pool clips must be an array.');
      return errors;
    }
    if (!isObject(manifest.initial_annotations || {})) errors.push('Candidate pool initial_annotations must be an object.');
    var ids = new Set(session.clips.map(function rootClipId(clip) { return clip.id; }));
    var sourceIntervals = new Set();
    var mediaIntervals = new Set();
    session.clips.forEach(function seedSourceIdentity(clip) {
      sourceIntervals.add([normalizeSourceUrl(clip.source_url), clip.start, clip.end].join('\u001f'));
      if (clip.source_media_url) mediaIntervals.add([normalizeSourceUrl(clip.source_media_url), clip.start, clip.end].join('\u001f'));
    });
    manifest.clips.forEach(function validatePoolClip(clip, index) {
      var label = 'Pool clip ' + index;
      if (!isObject(clip)) {
        errors.push(label + ' must be an object.');
        return;
      }
      if (!nonEmptyString(clip.id)) errors.push(label + ' id must be a non-empty string.');
      else if (ids.has(clip.id)) errors.push('Duplicate pool clip id: ' + clip.id + '.');
      else ids.add(clip.id);
      ['title', 'preview_url', 'source_url', 'fit'].forEach(function requirePoolField(field) {
        if (!nonEmptyString(clip[field])) errors.push(label + ' ' + field + ' must be a non-empty string.');
      });
      if (!number(clip.start) || !number(clip.end) || clip.start < 0 || clip.end <= clip.start) errors.push(label + ' original interval is invalid.');
      if (!number(clip.preview_start) || !number(clip.preview_end) || clip.preview_start < 0 || clip.preview_end <= clip.preview_start) errors.push(label + ' preview interval is invalid.');
      if (!isObject(clip.rights) || !nonEmptyString(clip.rights.status) || !nonEmptyString(clip.rights.text)) errors.push(label + ' rights are invalid.');
      var sourceKey = [normalizeSourceUrl(clip.source_url), clip.start, clip.end].join('\u001f');
      if (sourceIntervals.has(sourceKey)) errors.push('Duplicate pool source interval for ' + clip.id + '.');
      sourceIntervals.add(sourceKey);
      if (clip.source_media_url) {
        var mediaKey = [normalizeSourceUrl(clip.source_media_url), clip.start, clip.end].join('\u001f');
        if (mediaIntervals.has(mediaKey)) errors.push('Duplicate pool media interval for ' + clip.id + '.');
        mediaIntervals.add(mediaKey);
      }
      if (clip.tags !== undefined && (!Array.isArray(clip.tags) || clip.tags.some(function invalidTag(tag) { return !nonEmptyString(tag); }))) errors.push(label + ' tags must be non-empty strings.');
    });
    return errors;
  }

  function validatePoolManifest(session, manifest) {
    var errors = getPoolManifestErrors(session, manifest);
    return { valid: errors.length === 0, errors: errors };
  }

  function poolManifestFromDocument(documentObject) {
    if (isBrowser && typeof window !== 'undefined' && isObject(window.BrandReferenceScoutPool)) return window.BrandReferenceScoutPool;
    if (!documentObject || typeof documentObject.getElementById !== 'function') return null;
    var script = documentObject.getElementById('review-pool');
    if (!script || !script.textContent) return null;
    var raw = script.textContent.trim();
    if (!raw || raw === '__SCOUT_POOL_JSON__') return null;
    try { return JSON.parse(raw); } catch (error) { return { invalid: error.message }; }
  }

  function poolDescriptorTokens(clip, annotation) {
    var values = [clip.title, clip.fit, clip.observed];
    if (annotation) values.push(annotation.tags, annotation.features);
    values.push(clip.tags, clip.features);
    var tokens = new Set();
    values.forEach(function addDescriptor(value) {
      var text = typeof value === 'string' ? value : JSON.stringify(value || '');
      (text.toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function addToken(token) {
        if (token.length > 2) tokens.add(token);
      });
    });
    return tokens;
  }

  function rankPoolCandidates(session, state, manifest) {
    var available = manifest.clips.filter(function unseen(clip) {
      return !roundRecordsForState(session, state).some(function shownInRound(round) {
        var shownIds = Array.isArray(round.clip_ids) ? round.clip_ids : (Array.isArray(round.clips) ? round.clips.map(function shownClipId(shownClip) { return shownClip.id; }) : []);
        return shownIds.indexOf(clip.id) !== -1;
      });
    });
    var annotations = isObject(manifest.initial_annotations) ? manifest.initial_annotations : {};
    var positive = new Set();
    var negative = new Set();
    roundRecordsForState(session, state).forEach(function collectFeedback(round, roundIndex) {
      var clips = Array.isArray(round.clips) ? round.clips : (roundIndex === 0 ? session.clips : []);
      clips.forEach(function collectDecision(clip) {
        if (!isObject(clip)) return;
        var decision = round.decisions && round.decisions[clip.id];
        if (decision !== 'keep' && decision !== 'discard') return;
        var tokens = poolDescriptorTokens(clip, roundIndex === 0 ? annotations[clip.id] : null);
        var target = decision === 'keep' ? positive : negative;
        tokens.forEach(function addFeedback(token) { target.add(token); });
      });
    });
    return available.map(function scoreCandidate(clip, index) {
      var tokens = poolDescriptorTokens(clip, null);
      var positiveMatches = 0;
      var negativeMatches = 0;
      tokens.forEach(function scoreToken(token) {
        if (positive.has(token)) positiveMatches += 1;
        if (negative.has(token)) negativeMatches += 1;
      });
      return { clip: clip, score: positiveMatches * 3 - negativeMatches * 2, index: index };
    }).sort(function highestScore(left, right) {
      return right.score - left.score || left.index - right.index || left.clip.id.localeCompare(right.clip.id);
    }).map(function copyRanked(item) { return clone(item.clip); });
  }

  function nextPoolBatch(session, state, manifest) {
    if (!manifest) return { clips: [], reason: 'No prepared candidate pool is available.' };
    var ranked = rankPoolCandidates(session, state, manifest);
    if (ranked.length < session.clips.length) {
      return { clips: [], reason: 'Candidate pool exhausted: only ' + ranked.length + ' unseen clips remain; a full next ten is unavailable.' };
    }
    return { clips: ranked.slice(0, session.clips.length), reason: '' };
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function compactContextText(value) {
    if (!nonEmptyString(value)) return '';
    var words = value.replace(/\s+/g, ' ').trim().split(' ');
    return words.slice(0, 100).join(' ') + (words.length > 100 ? '…' : '');
  }

  function contextValues(session, context) {
    var source = isObject(context) ? context : {};
    return {
      brandRead: compactContextText(source.brand_read),
      adTarget: compactContextText(source.ad_target) || compactContextText(session && session.brief),
    };
  }

  function contextFromDocument(documentObject) {
    if (!documentObject || typeof documentObject.getElementById !== 'function') return null;
    var script = documentObject.getElementById('review-context');
    if (!script || !script.textContent) return null;
    var raw = script.textContent.trim();
    if (!raw || raw === '__SCOUT_CONTEXT_JSON__') return null;
    try { return JSON.parse(raw); } catch (error) { return null; }
  }

  function renderContextStrip(context) {
    if (!context || (!context.brandRead && !context.adTarget)) return '';
    var brand = context.brandRead
      ? '<div><p class="eyebrow">Brand read <span class="context-label-note">(interpretation)</span></p><p>' + escapeHtml(context.brandRead) + '</p></div>'
      : '';
    var target = context.adTarget
      ? '<div><p class="eyebrow">Ad target</p><p>' + escapeHtml(context.adTarget) + '</p></div>'
      : '';
    return '<section class="context-strip" aria-label="Review context">' + brand + target + '</section>';
  }

  function renderInterval(start, end) {
    return formatSeconds(start) + '–' + formatSeconds(end);
  }

  function downloadText(name, text, type) {
    if (!isBrowser || typeof document === 'undefined') return;
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function revoke() { URL.revokeObjectURL(url); }, 0);
  }

  function renderMedia(clip) {
    var poster = clip.poster_url ? ' poster="' + escapeHtml(clip.poster_url) + '"' : '';
    return '<div class="media-frame" data-media-frame>' +
      '<video class="clip-video" controls preload="metadata" playsinline' + poster +
      ' src="' + escapeHtml(clip.preview_url) + '" aria-label="Preview: ' + escapeHtml(clip.title) + '"' +
      ' data-preview-start="' + escapeHtml(clip.preview_start) + '" data-preview-end="' + escapeHtml(clip.preview_end) + '"></video>' +
      '<div class="media-loading" data-media-status aria-live="polite">Loading preview…</div>' +
      '<div class="media-actions" aria-label="Preview controls">' +
      '<button class="media-action" type="button" data-media-action="play" aria-label="Play preview">Play</button>' +
      '<button class="media-action" type="button" data-media-action="mute" aria-pressed="false">Sound on</button>' +
      '<button class="media-action" type="button" data-media-action="fullscreen">Fullscreen</button>' +
      '<button class="media-action media-retry" type="button" data-media-action="retry" hidden>Retry</button>' +
      '</div>' +
      '</div>';
  }

  function renderClipCard(clip, state, kicker) {
    var verdict = state.decisions[clip.id];
    var note = state.notes[clip.id] || '';
    var rightsMarker = clip.rights && clip.rights.status === 'restricted' ? '<span class="rights-flag">Restricted licence</span>' : '';
    var sourceDetails = '<div class="source-details">' +
      '<dl class="source-meta">' +
      '<div><dt>Original interval</dt><dd>' + escapeHtml(renderInterval(clip.start, clip.end)) + '</dd></div>' +
      '<div><dt>Preview interval</dt><dd>' + escapeHtml(renderInterval(clip.preview_start, clip.preview_end)) + '</dd></div>' +
      '<div><dt>Rights</dt><dd>' + escapeHtml(clip.rights.status) + ' — ' + escapeHtml(clip.rights.text) + '</dd></div>' +
      '</dl>' +
      '<p class="source-links"><a href="' + escapeHtml(clip.source_url) + '" target="_blank" rel="noreferrer">Open source</a>' +
      (clip.source_media_url ? ' <a href="' + escapeHtml(clip.source_media_url) + '" target="_blank" rel="noreferrer">Source media</a>' : '') +
      (clip.rights.url ? ' <a href="' + escapeHtml(clip.rights.url) + '" target="_blank" rel="noreferrer">Rights reference</a>' : '') +
      '</p></div>';
    return '<article class="clip-card" data-clip-id="' + escapeHtml(clip.id) + '">' +
      renderMedia(clip) +
      '<div class="media-caption"><div><p class="clip-kicker">' + escapeHtml(kicker) + '</p><h3>' + escapeHtml(clip.title) + '</h3></div>' +
      '<span class="clip-status"><span class="verdict verdict-' + escapeHtml(verdict || 'neutral') + '" data-verdict>' + escapeHtml(verdict || 'Unreviewed') + '</span>' + rightsMarker + '</span></div>' +
      '<p class="fit-copy">' + escapeHtml(clip.fit) + '</p>' +
      '<details class="clip-inspector"><summary>Source, rights &amp; notes</summary>' +
      sourceDetails +
      '<label class="note-field">Note<span class="sr-only"> for ' + escapeHtml(clip.title) + '</span><textarea data-note rows="2" placeholder="What should we remember?">' + escapeHtml(note) + '</textarea></label>' +
      '</details>' +
      '</article>';
  }

  function renderPair(session, state, pairIndex) {
    var pair = getPair(session, pairIndex);
    var selected = pairChoiceFromState(state, session, pairIndex);
    var options = [
      ['left', 'Keep left'],
      ['both', 'Keep both'],
      ['right', 'Keep right'],
      ['neither', 'Neither'],
    ];
    var cards = pair.map(function card(clip, cardIndex) {
      return renderClipCard(clip, state, cardIndex === 0 ? 'A' : 'B');
    }).join('');
    var choiceButtons = options.map(function choiceButton(option) {
      return '<button type="button" class="choice-button' + (selected === option[0] ? ' is-selected' : '') + '" data-choice="' + option[0] + '" data-pair-index="' + pairIndex + '" aria-pressed="' + (selected === option[0] ? 'true' : 'false') + '">' + option[1] + '</button>';
    }).join('');
    return '<section class="pair" id="pair-' + pairIndex + '" data-pair-index="' + pairIndex + '" tabindex="-1">' +
      '<div class="pair-heading"><div><p class="eyebrow">Pair ' + (pairIndex + 1) + ' / 5</p><h2>' + escapeHtml(pair[0].title) + ' <span aria-hidden="true">×</span> ' + escapeHtml(pair[1].title) + '</h2></div>' +
      '<span class="pair-state" data-pair-state>' + escapeHtml(pairChoiceLabel(selected)) + '</span></div>' +
      '<div class="clip-grid">' + cards + '</div>' +
      '<div class="choice-row" role="group" aria-label="Choose between pair ' + (pairIndex + 1) + '">' + choiceButtons + '</div>' +
      '</section>';
  }

  function renderResultView(session, state, shortlist, notes, roundInfo) {
    shortlist = Array.isArray(shortlist) ? shortlist : deriveShortlist(session, state);
    notes = isObject(notes) ? notes : state.notes;
    roundInfo = roundInfo || {};
    var cardState = { decisions: {}, notes: notes || {} };
    shortlist.forEach(function markKept(clip) { cardState.decisions[clip.id] = 'keep'; });
    var cards = shortlist.map(function renderShortlistClip(clip, index) {
      return renderClipCard(clip, cardState, String(index + 1).padStart(2, '0'));
    }).join('');
    var countLabel = shortlist.length === 1 ? '1 clip selected' : shortlist.length + ' clips selected';
    var emptyCopy = 'No clips kept. This review is complete; you can revisit the pair choices or export the empty shortlist.';
    return '<section class="result-view" aria-labelledby="result-title" tabindex="-1">' +
      '<div class="result-heading"><div><p class="eyebrow">' + (state.finished ? 'Shortlist ready' : 'Review complete') + '</p><h2 id="result-title">' + escapeHtml(countLabel) + '</h2><p>' + escapeHtml(shortlist.length ? 'Your selected clips are ready to inspect, annotate, and export.' : emptyCopy) + '</p></div>' +
      '<div class="result-actions"><button type="button" class="text-button result-review-button" data-action="review-choices">Review choices</button><button type="button" class="text-button result-copy-button" data-action="copy-shortlist">Copy shortlist</button>' +
      '<button type="button" class="text-button result-next-button" data-action="next-round"' + (roundInfo.canNext ? '' : ' disabled') + '>Next ten</button></div></div>' +
      (shortlist.length ? '<div class="result-grid">' + cards + '</div>' : '<div class="result-empty" role="status"><p>' + escapeHtml(emptyCopy) + '</p></div>') +
      '<p class="result-pool-status" role="status">' + escapeHtml(roundInfo.poolMessage || (roundInfo.canNext ? 'A fresh ten will be ranked from the prepared unseen pool using this round’s keep and discard signals.' : '')) + '</p>' +
      '<div class="result-footer"><div><p class="eyebrow">' + (state.finished ? 'Saved shortlist' : 'Next step') + '</p><p>' + (state.finished ? 'Your source links, original intervals, rights notes, and clip notes are preserved in the exports.' : 'Finish the shortlist when these selections are ready to hand off.') + '</p></div>' +
      '<button type="button" class="finish-button" data-action="finish">' + (state.finished ? 'Update shortlist' : 'Finish shortlist') + '</button></div>' +
      '</section>';
  }

  function renderApp(app, session, state, statusMessage, storageWarning, showResults, pairIndex, reviewMode, resultData, context) {
    var completed = state.completed_pairs;
    var allReviewed = completed === session.clips.length / 2;
    var visiblePair = Number.isInteger(pairIndex) ? pairIndex : activePairIndex(session, state);
    var pairMarkup = visiblePair >= 0 && visiblePair < session.clips.length / 2 ? renderPair(session, state, visiblePair) : '';
    var pairNavigation = reviewMode
      ? '<div class="pair-nav"><span>Reviewing saved choices · Pair ' + (visiblePair + 1) + ' / ' + (session.clips.length / 2) + '</span><button type="button" class="text-button" data-action="back-results">Back to shortlist</button></div>'
      : '';
    var mainContent = showResults && allReviewed
      ? renderResultView(session, state, resultData && resultData.shortlist, resultData && resultData.notes, resultData && resultData.roundInfo)
      : pairNavigation + '<div class="pair-list">' + pairMarkup + '</div>' +
        '<section class="finish-panel" aria-labelledby="finish-title">' +
        '<div><p class="eyebrow">' + (state.finished ? 'Shortlist ready' : 'Finish when ready') + '</p><h2 id="finish-title">' + (state.finished ? escapeHtml(String(state.shortlist.length) + ' clips kept') : 'Shape the shortlist') + '</h2><p>' + (state.finished ? 'Your chosen records retain source links, original intervals, rights notes, and your clip notes.' : (allReviewed ? 'All five pairs are reviewed. Finish the shortlist when ready.' : 'Review all five pairs to unlock the shortlist export.')) + '</p></div>' +
        '<button type="button" class="finish-button" data-action="finish"' + (allReviewed ? '' : ' disabled') + '>' + (state.finished ? 'Update shortlist' : 'Finish shortlist') + '</button>' +
        '</section>';
    app.innerHTML = '<div class="page-shell">' +
      '<header class="site-header">' +
      '<div class="brand-lockup"><span class="brand-mark" aria-hidden="true">BR</span><span>Brand Reference Scout</span></div>' +
      '<div class="header-actions">' +
      '<button type="button" class="text-button" data-action="undo"' + (state.history.length ? '' : ' disabled') + '>Undo</button>' +
      '<button type="button" class="text-button" data-action="import">Import JSON</button>' +
      '<button type="button" class="text-button" data-action="export-json">Export JSON</button>' +
      '<button type="button" class="text-button" data-action="export-markdown">Export Markdown</button>' +
      '<input type="file" accept="application/json,.json" data-import-input hidden>' +
      '</div>' +
      '</header>' +
      '<main>' +
      '<section class="intro" aria-labelledby="review-title">' +
      '<p class="eyebrow">' + escapeHtml(session.brand.name) + ' / visual references</p>' +
      '<h1 id="review-title">' + escapeHtml(session.title) + '</h1>' +
      '<p class="brief">' + escapeHtml(session.brief) + '</p>' +
      '<div class="intro-meta"><span>' + completed + ' of 5 pairs reviewed</span><span>·</span><span>' + (storageWarning ? 'Saved only in this tab' : 'Saved on this device') + '</span></div>' +
      '</section>' +
      '<div class="progress-track" aria-label="Review progress"><span style="width:' + ((completed / 5) * 100) + '%"></span></div>' +
      '<div class="status-line" role="status" aria-live="polite" tabindex="-1">' + escapeHtml(statusMessage || (state.finished ? 'Shortlist finished. You can still adjust and export your selections.' : (allReviewed ? 'Review complete. Inspect the shortlist below or revisit your choices.' : 'Choose how each pair should move forward.'))) + '</div>' +
      renderContextStrip(context) +
      mainContent +
      '</main>' +
      '<footer class="site-footer"><span>Session fingerprint</span><code>' + escapeHtml(session.fingerprint) + '</code><span class="footer-note">Source links and rights notes travel with exports</span></footer>' +
      '</div>';
  }

  function mountReview(documentObject) {
    if (!isBrowser || !documentObject) return null;
    var app = documentObject.getElementById('review-app');
    var script = documentObject.getElementById('review-session');
    if (!app || !script) return null;
    var raw = script.textContent.trim();
    if (!raw || raw === '__SCOUT_SESSION_JSON__') {
      app.innerHTML = '<div class="fatal-state"><p class="eyebrow">Review unavailable</p><h1>Session data is missing.</h1><p>Render this page with a prepared review-session.json payload.</p></div>';
      return null;
    }
    var session;
    try {
      session = JSON.parse(raw);
      assertValidSession(session);
    } catch (error) {
      app.innerHTML = '<div class="fatal-state"><p class="eyebrow">Review unavailable</p><h1>Session data is invalid.</h1><p>' + escapeHtml(error.message) + '</p></div>';
      return null;
    }

    var storage = storageOrDefault(null);
    var storageUnavailable = !storage;
    var storageWarning = storageUnavailable;
    var statusMessage = storageUnavailable ? 'Saved only in this tab. Browser storage is unavailable; exports remain available.' : '';
    var poolManifest = poolManifestFromDocument(documentObject);
    var reviewContext = contextValues(session, contextFromDocument(documentObject));
    var poolValidation = poolManifest ? validatePoolManifest(session, poolManifest) : { valid: false, errors: [] };
    var poolProblem = poolManifest && !poolValidation.valid
      ? 'Prepared candidate pool could not be used: ' + poolValidation.errors.join(' ')
      : (!poolManifest ? 'No prepared candidate pool is available for a fresh ten.' : '');
    var state = loadState(session, storage, function onReadError() {
      storageWarning = true;
      statusMessage = 'Saved review could not be restored. Starting a fresh state; export or choose again.';
    }, poolManifest && poolValidation.valid ? poolManifest : null);
    var rounds;
    try {
      rounds = migrateRoundRecords(session, state);
      var roundPoolValidation = validateRoundRecordsAgainstPool(session, rounds, poolManifest && poolValidation.valid ? poolManifest : null, state.pool_fingerprint);
      if (!roundPoolValidation.valid) throw new Error(roundPoolValidation.errors.join(' '));
    } catch (error) {
      storageWarning = true;
      statusMessage = 'Saved review rounds could not be restored. The original session choices remain available.';
      rounds = [roundRecordFromState(session, state, 0, 'root')];
    }
    var activeRoundIndex = Number.isInteger(state.active_round) && state.active_round >= 0 && state.active_round < rounds.length
      ? state.active_round
      : 0;
    var activeSession = sessionForRound(session, rounds[activeRoundIndex]);
    var activeViewState = stateFromRoundRecord(rounds[activeRoundIndex], activeSession);
    var showResults = activeViewState.completed_pairs === activeSession.clips.length / 2;
    var reviewMode = false;
    var reviewPairIndex = activePairIndex(activeSession, activeViewState);
    state.rounds = clone(rounds);
    state.active_round = activeRoundIndex;
    state.campaign_key = state.campaign_key || session.fingerprint;
    if (poolManifest && poolValidation.valid) state.pool_fingerprint = poolManifest.pool_fingerprint;

    function showStatus(message) {
      statusMessage = message;
      var status = app.querySelector('.status-line');
      if (status) status.textContent = message;
    }

    function persistContainer() {
      state.rounds = clone(rounds);
      state.active_round = activeRoundIndex;
      state.campaign_key = session.fingerprint;
      if (poolManifest && poolValidation.valid) state.pool_fingerprint = poolManifest.pool_fingerprint;
      state.updated_at = now();
      try {
        state = saveState(session, state, storage);
      } catch (error) {
        storageUnavailable = true;
        storageWarning = true;
        showStatus('This browser blocked local persistence. Exports remain available.');
      }
    }

    function commitActive(nextState) {
      activeViewState = nextState;
      rounds[activeRoundIndex] = roundRecordFromState(activeSession, activeViewState, activeRoundIndex, rounds[activeRoundIndex].round_key);
      if (activeRoundIndex === 0) {
        ['decisions', 'notes', 'history', 'completed_pairs', 'pair_choices', 'shortlist', 'finished', 'active_pair', 'updated_at'].forEach(function copyRootField(field) {
          state[field] = clone(activeViewState[field]);
        });
      }
      persistContainer();
    }

    function activateRound(index) {
      activeRoundIndex = index;
      activeSession = sessionForRound(session, rounds[activeRoundIndex]);
      activeViewState = stateFromRoundRecord(rounds[activeRoundIndex], activeSession);
      reviewPairIndex = activePairIndex(activeSession, activeViewState);
    }

    function savedMessage(message) {
      if (storageUnavailable) return message + ' Saved only in this tab; exports remain available.';
      if (storageWarning) return message + ' The previous saved state could not be restored.';
      return message;
    }

    function roundInfo() {
      if (poolProblem) return { canNext: false, poolMessage: poolProblem };
      if (activeRoundIndex >= 2) return { canNext: false, poolMessage: 'Candidate pool exhausted: all three prepared tens have been reviewed.' };
      var next = nextPoolBatch(session, state, poolManifest);
      return next.clips.length ? { canNext: true, poolMessage: 'A fresh ten will use keep and discard feedback from the reviewed rounds.' } : { canNext: false, poolMessage: next.reason };
    }

    function beginClipboardCopy() {
      var markdown = buildMarkdownExport(session, state);
      if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        return { started: false, promise: null };
      }
      try {
        return { started: true, promise: Promise.resolve(navigator.clipboard.writeText(markdown)) };
      } catch (error) {
        return { started: false, promise: null };
      }
    }

    function finishClipboardStatus(attempt, message) {
      if (!attempt.started) {
        statusMessage = savedMessage(message + ' Clipboard access was unavailable; use Copy shortlist below.');
        return;
      }
      statusMessage = savedMessage(message + ' Copying shortlist…');
      attempt.promise.then(function copied() {
        showStatus(savedMessage('Shortlist saved and copied to the clipboard.'));
      }).catch(function copyDenied() {
        showStatus(savedMessage('Shortlist saved. Clipboard access was blocked; use Copy shortlist to retry.'));
      });
    }

    function focusReviewTarget(pairIndex, selector) {
      var target = selector ? app.querySelector(selector) : (Number.isInteger(pairIndex) && pairIndex >= 0 && pairIndex < session.clips.length / 2
        ? app.querySelector('[data-pair-index="' + pairIndex + '"]')
        : app.querySelector('.status-line'));
      if (!target) target = app.querySelector('.status-line');
      if (!target) return;
      var focus = function focusTarget() {
        try { target.focus({ preventScroll: true }); } catch (error) { target.focus(); }
        if (target.classList.contains('pair') || target.classList.contains('result-view')) {
          var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        }
      };
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(focus);
      else window.setTimeout(focus, 0);
    }

    function bindVideos() {
      var videos = Array.prototype.slice.call(app.querySelectorAll('video[data-preview-start]'));
      videos.forEach(function bindVideo(video) {
        var frame = video.closest('[data-media-frame]');
        var status = frame.querySelector('[data-media-status]');
        var retry = frame.querySelector('[data-media-action="retry"]');
        var playButton = frame.querySelector('[data-media-action="play"]');
        var muteButton = frame.querySelector('[data-media-action="mute"]');
        var start = Number(video.dataset.previewStart);
        var end = Number(video.dataset.previewEnd);
        function bounded(value) {
          return clampPreviewTime(value, start, end);
        }
        function setStart() {
          if (Number.isFinite(video.duration)) video.currentTime = Math.min(start, Math.max(0, video.duration));
        }
        function clearLoading() {
          status.textContent = 'Preview excerpt · ' + renderInterval(start, end);
          status.classList.remove('is-error');
        }
        video.addEventListener('loadedmetadata', function onMetadata() {
          setStart();
          clearLoading();
        });
        video.addEventListener('loadeddata', clearLoading);
        video.addEventListener('play', function onPlay() {
          Array.prototype.slice.call(app.querySelectorAll('video')).forEach(function pauseOther(other) {
            if (other !== video && !other.paused) other.pause();
          });
          playButton.textContent = 'Pause';
          playButton.setAttribute('aria-label', 'Pause preview');
          status.classList.remove('is-error');
        });
        video.addEventListener('pause', function onPause() {
          playButton.textContent = 'Play';
          playButton.setAttribute('aria-label', 'Play preview');
        });
        video.addEventListener('timeupdate', function onTimeUpdate() {
          if (video.currentTime >= end) {
            video.pause();
            video.currentTime = bounded(end);
          }
        });
        video.addEventListener('seeking', function onSeeking() {
          var target = bounded(video.currentTime);
          if (target !== video.currentTime) video.currentTime = target;
        });
        video.addEventListener('error', function onError() {
          status.textContent = 'Preview unavailable. Retry or choose explicitly.';
          status.classList.add('is-error');
          retry.hidden = false;
        });
        playButton.addEventListener('click', function togglePlay() {
          if (video.paused) {
            if (video.currentTime < start || video.currentTime >= end) setStart();
            var promise = video.play();
            if (promise && promise.catch) promise.catch(function playbackError() {
              status.textContent = 'Playback was blocked. Use the native play control to retry.';
            });
          } else video.pause();
        });
        muteButton.addEventListener('click', function toggleMute() {
          video.muted = !video.muted;
          muteButton.textContent = video.muted ? 'Sound off' : 'Sound on';
          muteButton.setAttribute('aria-pressed', String(video.muted));
        });
        frame.querySelector('[data-media-action="fullscreen"]').addEventListener('click', function fullscreen() {
          var target = frame.requestFullscreen || frame.webkitRequestFullscreen;
          if (target) target.call(frame);
          else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        });
        retry.addEventListener('click', function retryPreview() {
          retry.hidden = true;
          status.textContent = 'Retrying preview…';
          status.classList.remove('is-error');
          video.load();
        });
      });
    }

    function render(status) {
      Array.prototype.slice.call(app.querySelectorAll('video')).forEach(function pauseBeforeRender(video) {
        if (!video.paused) video.pause();
      });
      var shortlist = cumulativeShortlistForState(session, state);
      var notes = cumulativeNotesForState(session, state);
      var visiblePair = reviewMode ? reviewPairIndex : activePairIndex(activeSession, activeViewState);
      renderApp(app, activeSession, activeViewState, status || (storageWarning ? statusMessage : ''), storageUnavailable, showResults, visiblePair, reviewMode, {
        shortlist: shortlist,
        notes: notes,
        roundInfo: roundInfo(),
      }, reviewContext);
      bindVideos();
    }

    function onClick(event) {
      var actionTarget = event.target.closest('[data-action]');
      var choiceTarget = event.target.closest('[data-choice]');
      if (choiceTarget) {
        var pairIndex = Number(choiceTarget.dataset.pairIndex);
        try {
          var nextChoiceState = applyPairChoice(activeViewState, activeSession, pairIndex, choiceTarget.dataset.choice);
          var completedFinalPair = nextChoiceState.completed_pairs === activeSession.clips.length / 2 && (!reviewMode || pairIndex === activeSession.clips.length / 2 - 1);
          if (completedFinalPair) {
            commitActive(finishShortlist(nextChoiceState, activeSession));
            showResults = true;
            reviewMode = false;
            var finalCopy = beginClipboardCopy();
            finishClipboardStatus(finalCopy, 'Shortlist saved.');
          } else {
            commitActive(nextChoiceState);
            if (reviewMode) {
              reviewPairIndex = pairIndex + 1;
              showResults = reviewPairIndex >= activeSession.clips.length / 2;
              if (showResults) reviewMode = false;
            } else {
              showResults = activeViewState.completed_pairs === activeSession.clips.length / 2;
              reviewPairIndex = activePairIndex(activeSession, activeViewState);
            }
            statusMessage = savedMessage('Pair ' + (pairIndex + 1) + ' saved.');
          }
          render(statusMessage);
          focusReviewTarget(showResults ? null : (reviewMode ? reviewPairIndex : activePairIndex(activeSession, activeViewState)), showResults ? '.result-view' : null);
        } catch (error) { render('Could not save that choice: ' + error.message); focusReviewTarget(null); }
        return;
      }
      if (!actionTarget) return;
      var action = actionTarget.dataset.action;
      if (action === 'undo') {
        try {
          commitActive(undoLast(activeViewState, activeSession));
          if (activeViewState.completed_pairs < activeSession.clips.length / 2) showResults = false;
          else showResults = showResults && activeViewState.completed_pairs === activeSession.clips.length / 2;
          if (!showResults && !reviewMode) reviewPairIndex = activePairIndex(activeSession, activeViewState);
          statusMessage = savedMessage('Last pair choice undone.');
          render(statusMessage);
          focusReviewTarget(showResults ? null : (reviewMode ? reviewPairIndex : activePairIndex(activeSession, activeViewState)), showResults ? '.result-view' : null);
        } catch (error) { render('Could not undo: ' + error.message); focusReviewTarget(null); }
      } else if (action === 'finish') {
        try {
          commitActive(finishShortlist(activeViewState, activeSession));
          showResults = true;
          reviewMode = false;
          var finishCopy = beginClipboardCopy();
          finishClipboardStatus(finishCopy, 'Shortlist saved.');
          render(statusMessage);
          focusReviewTarget(null, '.result-view');
        } catch (error) { render(error.message); focusReviewTarget(null); }
      } else if (action === 'import') {
        var input = app.querySelector('[data-import-input]');
        if (input) input.click();
      } else if (action === 'review-choices') {
        showResults = false;
        reviewMode = true;
        reviewPairIndex = 0;
        statusMessage = 'Review choices without changing your saved selections.';
        render(statusMessage);
        focusReviewTarget(0);
      } else if (action === 'back-results') {
        showResults = true;
        reviewMode = false;
        statusMessage = 'Shortlist restored. Your choices remain saved.';
        render(statusMessage);
        focusReviewTarget(null, '.result-view');
      } else if (action === 'copy-shortlist') {
        var copyAttempt = beginClipboardCopy();
        finishClipboardStatus(copyAttempt, 'Shortlist copy requested.');
        render(statusMessage);
        focusReviewTarget(null, '[data-action="copy-shortlist"]');
      } else if (action === 'next-round') {
        if (activeViewState.completed_pairs < activeSession.clips.length / 2) {
          showStatus('Review every pair before loading the next ten.');
          return;
        }
        if (activeRoundIndex >= 2) {
          showStatus('Candidate pool exhausted: all three prepared tens have been reviewed.');
          return;
        }
        if (poolProblem) {
          showStatus(poolProblem);
          return;
        }
        var next = nextPoolBatch(session, state, poolManifest);
        if (!next.clips.length) {
          showStatus(next.reason);
          return;
        }
        var nextRound = { clips: next.clips };
        var nextSession = sessionForRound(session, nextRound);
        var nextState = createInitialState(nextSession);
        rounds.push(roundRecordFromState(nextSession, nextState, rounds.length, poolManifest.pool_fingerprint + ':' + rounds.length));
        activateRound(rounds.length - 1);
        state.rounds = clone(rounds);
        persistContainer();
        showResults = false;
        reviewMode = false;
        statusMessage = savedMessage('Next ten loaded from the prepared unseen pool.');
        render(statusMessage);
        focusReviewTarget(0);
      } else if (action === 'export-json') {
        downloadText(session.id + '-review-decisions.json', serializeJsonExport(session, state), 'application/json');
        statusMessage = 'JSON export downloaded.';
        render(statusMessage);
        focusReviewTarget(null, '[data-action="export-json"]');
      } else if (action === 'export-markdown') {
        downloadText(session.id + '-shortlist.md', buildMarkdownExport(session, state), 'text/markdown');
        statusMessage = 'Markdown export downloaded.';
        render(statusMessage);
        focusReviewTarget(null, '[data-action="export-markdown"]');
      }
    }

    app.addEventListener('click', onClick);
    app.addEventListener('input', function onInput(event) {
      var note = event.target.closest('[data-note]');
      if (!note) return;
      var card = note.closest('[data-clip-id]');
      if (!card) return;
      try {
        var noteClipId = card.dataset.clipId;
        var noteRoundIndex = rounds.findIndex(function findNoteRound(round) { return Array.isArray(round.clip_ids) && round.clip_ids.indexOf(noteClipId) !== -1; });
        if (noteRoundIndex < 0) throw new Error('Cannot add a note to an unknown clip.');
        var noteSession = sessionForRound(session, rounds[noteRoundIndex]);
        var noteState = stateFromRoundRecord(rounds[noteRoundIndex], noteSession);
        var nextNoteState = setNote(noteState, noteSession, noteClipId, note.value);
        rounds[noteRoundIndex] = roundRecordFromState(noteSession, nextNoteState, noteRoundIndex, rounds[noteRoundIndex].round_key);
        if (noteRoundIndex === activeRoundIndex) activeViewState = nextNoteState;
        if (noteRoundIndex === 0) {
          ['notes', 'shortlist', 'updated_at'].forEach(function copyNoteField(field) { state[field] = clone(nextNoteState[field]); });
        }
        persistContainer();
      } catch (error) { showStatus('Could not save note: ' + error.message); }
    });
    app.addEventListener('change', function onChange(event) {
      if (!event.target.matches('[data-import-input]') || !event.target.files || !event.target.files[0]) return;
      var file = event.target.files[0];
      file.text().then(function readImport(text) {
        try {
          var imported = importState(session, text, poolManifest && poolValidation.valid ? poolManifest : null);
          state = imported;
          rounds = migrateRoundRecords(session, state);
          var importedRoundPoolValidation = validateRoundRecordsAgainstPool(session, rounds, poolManifest && poolValidation.valid ? poolManifest : null, state.pool_fingerprint);
          if (!importedRoundPoolValidation.valid) throw new Error(importedRoundPoolValidation.errors.join(' '));
          activeRoundIndex = Number.isInteger(state.active_round) && state.active_round >= 0 && state.active_round < rounds.length ? state.active_round : 0;
          activateRound(activeRoundIndex);
          persistContainer();
          showResults = activeViewState.completed_pairs === activeSession.clips.length / 2;
          reviewMode = false;
          statusMessage = savedMessage('Review state imported for this session.');
          render(statusMessage);
          focusReviewTarget(showResults ? null : activePairIndex(activeSession, activeViewState), showResults ? '.result-view' : null);
        } catch (error) { render('Import rejected: ' + error.message); focusReviewTarget(null); }
        event.target.value = '';
      }).catch(function importError(error) { render('Import rejected: ' + error.message); focusReviewTarget(null); });
    });
    render();
    return { session: session, getState: function getState() { return state; }, render: render };
  }

  var api = {
    SESSION_VERSION: SESSION_VERSION,
    DECISIONS_VERSION: DECISIONS_VERSION,
    PAIR_CHOICES: PAIR_CHOICES.slice(),
    DECISIONS: DECISIONS.slice(),
    getSessionValidationErrors: getSessionValidationErrors,
    normalizeSourceUrl: normalizeSourceUrl,
    validateSession: validateSession,
    assertValidSession: assertValidSession,
    isValidSession: isValidSession,
    createInitialState: createInitialState,
    createReviewState: createInitialState,
    getPair: getPair,
    pairChoiceFromState: pairChoiceFromState,
    derivePairChoices: derivePairChoices,
    deriveShortlist: deriveShortlist,
    roundRecordFromState: roundRecordFromState,
    stateFromRoundRecord: stateFromRoundRecord,
    migrateRoundRecords: migrateRoundRecords,
    validateRoundRecordsAgainstPool: validateRoundRecordsAgainstPool,
    cumulativeShortlistForState: cumulativeShortlistForState,
    cumulativeNotesForState: cumulativeNotesForState,
    sessionForRound: sessionForRound,
    validatePoolManifest: validatePoolManifest,
    rankPoolCandidates: rankPoolCandidates,
    nextPoolBatch: nextPoolBatch,
    activePairIndex: activePairIndex,
    validatePersistedState: validatePersistedState,
    validateState: validatePersistedState,
    applyPairChoice: applyPairChoice,
    applyChoice: applyPairChoice,
    choosePair: applyPairChoice,
    setPairChoice: applyPairChoice,
    setNote: setNote,
    undoLast: undoLast,
    undo: undoLast,
    finishShortlist: finishShortlist,
    storageKey: storageKey,
    saveState: saveState,
    saveReviewState: saveState,
    loadState: loadState,
    loadReviewState: loadState,
    clearState: clearState,
    importState: importState,
    importReviewState: importState,
    buildJsonExport: buildJsonExport,
    exportDecisions: buildJsonExport,
    exportJSON: buildJsonExport,
    serializeJsonExport: serializeJsonExport,
    buildMarkdownExport: buildMarkdownExport,
    exportMarkdown: buildMarkdownExport,
    clampPreviewTime: clampPreviewTime,
    compactContextText: compactContextText,
    contextValues: contextValues,
    pairChoiceLabel: pairChoiceLabel,
    storageOrDefault: storageOrDefault,
    mountReview: mountReview,
  };

  if (isBrowser && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function ready() { mountReview(document); });
    else mountReview(document);
  }
  return api;
}));
