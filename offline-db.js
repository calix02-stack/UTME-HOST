// offline-db.js
// ============================================================
// REBUILT FROM SCRATCH — the original file was lost (not in the
// GitHub repo, no other copy found). This version was reconstructed
// by reading every call site of window.OfflineDB, window.dbGet,
// window.dbGetAll, exportOfflineData() and importOfflineData() across
// index.html, and matching the exact argument shapes, return shapes,
// and field names (subject_id, type, batch_number, passage_id,
// display_order, correct_answer, etc.) used there.
//
// This is a best-effort reconstruction, not a recovered original.
// It has NOT run against your real question data yet. Test it with:
//   - CBT mode (English + at least one other subject)
//   - Exam mode
//   - Mock Arena
//   - Novel (Literature) CBT
//   - Practice Hub / Topics
//   - Admin Panel: add/edit/delete question, save passage,
//     export subject file, sync subject files, force sync,
//     export/import full backup (questions-seed.json)
// before trusting it with real users' data.
// ============================================================

(function () {
    var DB_NAME = 'myutme_offline_db';
    var DB_VERSION = 1;
    var STORES = ['questions', 'topics', 'topic_questions', 'passages', 'used_mock', 'meta'];

    var dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                var db = e.target.result;

                if (!db.objectStoreNames.contains('questions')) {
                    var q = db.createObjectStore('questions', { keyPath: 'id' });
                    q.createIndex('by_type_subject', ['type', 'subject_id']);
                    q.createIndex('by_subject', 'subject_id');
                    q.createIndex('by_type_subject_year', ['type', 'subject_id', 'year']);
                }
                if (!db.objectStoreNames.contains('topics')) {
                    var t = db.createObjectStore('topics', { keyPath: 'id' });
                    t.createIndex('by_subject', 'subject_id');
                }
                if (!db.objectStoreNames.contains('topic_questions')) {
                    var tq = db.createObjectStore('topic_questions', { keyPath: 'id' });
                    tq.createIndex('by_topic', 'topic_id');
                }
                if (!db.objectStoreNames.contains('passages')) {
                    db.createObjectStore('passages', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('used_mock')) {
                    db.createObjectStore('used_mock', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            };
            req.onsuccess = function (e) { resolve(e.target.result); };
            req.onerror = function (e) {
                dbPromise = null;
                reject(e.target.error || new Error('IndexedDB open failed'));
            };
            req.onblocked = function () {
                console.warn('offline-db.js: IndexedDB open blocked by another tab.');
            };
        });
        return dbPromise;
    }

    function tx(storeName, mode) {
        return openDB().then(function (db) {
            return db.transaction(storeName, mode || 'readonly').objectStore(storeName);
        });
    }

    function reqToPromise(req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function storeGet(storeName, key) {
        return tx(storeName).then(function (store) { return reqToPromise(store.get(key)); });
    }
    function storeGetAll(storeName) {
        return tx(storeName).then(function (store) { return reqToPromise(store.getAll()); });
    }
    function storeGetAllByIndex(storeName, indexName, query) {
        return tx(storeName).then(function (store) {
            return reqToPromise(store.index(indexName).getAll(query));
        });
    }
    function storePut(storeName, value) {
        return tx(storeName, 'readwrite').then(function (store) { return reqToPromise(store.put(value)); });
    }
    function storeDelete(storeName, key) {
        return tx(storeName, 'readwrite').then(function (store) { return reqToPromise(store.delete(key)); });
    }
    function storeClear(storeName) {
        return tx(storeName, 'readwrite').then(function (store) { return reqToPromise(store.clear()); });
    }
    function storePutAll(storeName, values) {
        return tx(storeName, 'readwrite').then(function (store) {
            return Promise.all(values.map(function (v) { return reqToPromise(store.put(v)); }));
        });
    }

    function uid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }

    function shuffle(arr) {
        var a = arr.slice();
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
        }
        return a;
    }

    function downloadJson(filename, data) {
        try {
            var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        } catch (e) {
            console.error('offline-db.js: download failed', e);
        }
    }

    // ------------------------------------------------------------
    // Global raw helpers — index.html calls dbGet()/dbGetAll() directly
    // (not through window.OfflineDB) at a couple of call sites.
    // ------------------------------------------------------------
    window.dbGet = function (storeName, key) { return storeGet(storeName, key); };
    window.dbGetAll = function (storeName) { return storeGetAll(storeName); };

    // ------------------------------------------------------------
    // Full-backup export/import — index.html calls these as bare
    // globals (exportOfflineData / importOfflineData), not via
    // window.OfflineDB.
    // ------------------------------------------------------------
    window.exportOfflineData = function () {
        return Promise.all([
            storeGetAll('questions'),
            storeGetAll('topics'),
            storeGetAll('topic_questions'),
            storeGetAll('passages')
        ]).then(function (res) {
            var payload = {
                exported_at: new Date().toISOString(),
                questions: res[0],
                topics: res[1],
                topic_questions: res[2],
                passages: res[3]
            };
            downloadJson('questions-seed.json', payload);
            return payload;
        });
    };

    window.importOfflineData = function (data, mode) {
        mode = mode || 'merge';
        var questions = Array.isArray(data.questions) ? data.questions : [];
        var topics = Array.isArray(data.topics) ? data.topics : [];
        var topicQuestions = Array.isArray(data.topic_questions) ? data.topic_questions : [];
        var passages = Array.isArray(data.passages) ? data.passages : [];

        var clearStep = mode === 'replace'
            ? Promise.all([storeClear('questions'), storeClear('topics'), storeClear('topic_questions'), storeClear('passages')])
            : Promise.resolve();

        return clearStep.then(function () {
            questions.forEach(function (q) { if (!q.id) q.id = uid(); });
            topics.forEach(function (t) { if (!t.id) t.id = uid(); });
            topicQuestions.forEach(function (q) { if (!q.id) q.id = uid(); });
            passages.forEach(function (p) {
                if (!p.id) p.id = (p.subject_id || 'eng') + '_' + (p.mode || 'cbt') + '_' + p.batch_number;
            });
            return Promise.all([
                questions.length ? storePutAll('questions', questions) : Promise.resolve(),
                topics.length ? storePutAll('topics', topics) : Promise.resolve(),
                topicQuestions.length ? storePutAll('topic_questions', topicQuestions) : Promise.resolve(),
                passages.length ? storePutAll('passages', passages) : Promise.resolve()
            ]);
        }).then(function () {
            return {
                questions: questions.length,
                topics: topics.length,
                topic_questions: topicQuestions.length,
                passages: passages.length
            };
        });
    };

    // ------------------------------------------------------------
    // window.OfflineDB — everything the app calls through the
    // namespaced object.
    // ------------------------------------------------------------
    var OfflineDB = {};

    // ---- Questions (cbt / mock / exam / NOVEL (CBT) / subject) ----

    OfflineDB.loadQuestionsOffline = function (type, subjectId, year, limit) {
        return storeGetAllByIndex('questions', 'by_type_subject', [type, subjectId]).then(function (rows) {
            var filtered = rows;
            if (year !== undefined && year !== null) {
                filtered = filtered.filter(function (q) { return q.year === year; });
            }
            if (limit) {
                filtered = shuffle(filtered).slice(0, limit);
            }
            return filtered;
        });
    };

    OfflineDB.getQuestionsOffline = function (type, subjectId) {
        return storeGetAllByIndex('questions', 'by_type_subject', [type, subjectId]);
    };

    OfflineDB.getQuestionsByIdsOffline = function (ids) {
        ids = ids || [];
        return Promise.all(ids.map(function (id) { return storeGet('questions', id); }))
            .then(function (rows) { return rows.filter(Boolean); });
    };

    OfflineDB.addQuestionOffline = function (data) {
        var q = Object.assign({}, data);
        if (!q.id) q.id = uid();
        q.created_at = q.created_at || new Date().toISOString();
        return storePut('questions', q).then(function () { return q; });
    };

    OfflineDB.updateQuestionOffline = function (questionId, data) {
        return storeGet('questions', questionId).then(function (existing) {
            var merged = Object.assign({}, existing || { id: questionId }, data, { id: questionId });
            merged.updated_at = new Date().toISOString();
            return storePut('questions', merged).then(function () { return merged; });
        });
    };

    OfflineDB.deleteQuestionOffline = function (questionId) {
        return storeDelete('questions', questionId);
    };

    // ---- English passage batches ----

    OfflineDB.getPassageBatchesOffline = function (subjectId, mode) {
        return storeGetAllByIndex('questions', 'by_type_subject', [mode, subjectId]).then(function (rows) {
            var seen = {};
            var batches = [];
            rows.forEach(function (q) {
                if (q.batch_number !== undefined && q.batch_number !== null && !seen[q.batch_number]) {
                    seen[q.batch_number] = true;
                    batches.push(q.batch_number);
                }
            });
            batches.sort(function (a, b) { return a - b; });
            return batches;
        });
    };

    OfflineDB.getPassageOffline = function (batchNumber, mode) {
        // Passages are English-only in this app; subject_id isn't passed
        // at call sites, so it's fixed to 'eng' to match savePassageOffline.
        var id = 'eng_' + mode + '_' + batchNumber;
        return storeGet('passages', id).then(function (p) { return p || null; });
    };

    OfflineDB.savePassageOffline = function (data) {
        var subjectId = data.subject_id || 'eng';
        var p = Object.assign({}, data, {
            id: subjectId + '_' + data.mode + '_' + data.batch_number,
            subject_id: subjectId
        });
        return storePut('passages', p).then(function () { return p; });
    };

    // ---- Topics / Practice Hub ----

    OfflineDB.getTopicsOffline = function (subjectId) {
        return storeGetAllByIndex('topics', 'by_subject', subjectId);
    };

    OfflineDB.addTopicOffline = function (subjectId, name) {
        var t = { id: uid(), subject_id: subjectId, name: name, created_at: new Date().toISOString() };
        return storePut('topics', t).then(function () { return t; });
    };

    OfflineDB.deleteTopicOffline = function (topicId) {
        return storeGetAllByIndex('topic_questions', 'by_topic', topicId).then(function (qs) {
            return Promise.all(qs.map(function (q) { return storeDelete('topic_questions', q.id); }));
        }).then(function () { return storeDelete('topics', topicId); });
    };

    OfflineDB.getTopicQuestionsOffline = function (topicId, limit) {
        return storeGetAllByIndex('topic_questions', 'by_topic', topicId).then(function (rows) {
            if (limit) return shuffle(rows).slice(0, limit);
            return rows;
        });
    };

    OfflineDB.addTopicQuestionOffline = function (topicId, questionData) {
        var q = Object.assign({}, questionData, { id: uid(), topic_id: topicId, created_at: new Date().toISOString() });
        return storePut('topic_questions', q).then(function () { return q; });
    };

    OfflineDB.updateTopicQuestionOffline = function (questionId, data) {
        return storeGet('topic_questions', questionId).then(function (existing) {
            var merged = Object.assign({}, existing || { id: questionId }, data, { id: questionId });
            return storePut('topic_questions', merged).then(function () { return merged; });
        });
    };

    OfflineDB.deleteTopicQuestionOffline = function (questionId) {
        return storeDelete('topic_questions', questionId);
    };

    OfflineDB.replaceTopicQuestionsOffline = function (topicId, questionsArray) {
        return storeGetAllByIndex('topic_questions', 'by_topic', topicId).then(function (existing) {
            return Promise.all(existing.map(function (q) { return storeDelete('topic_questions', q.id); }));
        }).then(function () {
            var saved = questionsArray.map(function (q) {
                return Object.assign({}, q, { id: q.id || uid(), topic_id: topicId });
            });
            return storePutAll('topic_questions', saved).then(function () { return saved; });
        });
    };

    // ---- Mock Arena: used-question tracking (avoid repeats) ----

    function usedMockKey(userId, subjectId) { return userId + '::' + subjectId; }

    OfflineDB.getUsedMockQuestionIdsOffline = function (userId, subjectId) {
        return storeGet('used_mock', usedMockKey(userId, subjectId)).then(function (row) {
            return (row && row.used_ids) || [];
        });
    };

    OfflineDB.addUsedMockQuestionIdsOffline = function (userId, subjectId, ids) {
        var key = usedMockKey(userId, subjectId);
        return storeGet('used_mock', key).then(function (row) {
            var existing = (row && row.used_ids) || [];
            var merged = existing.concat(ids.filter(function (id) { return existing.indexOf(id) === -1; }));
            return storePut('used_mock', { id: key, user_id: userId, subject_id: subjectId, used_ids: merged });
        });
    };

    OfflineDB.resetUsedMockQuestionIdsOffline = function (userId, subjectId) {
        var key = usedMockKey(userId, subjectId);
        return storePut('used_mock', { id: key, user_id: userId, subject_id: subjectId, used_ids: [] });
    };

    // ---- Subject question-file sync (questions-<subjectId>.json) ----
    // Admin Panel exports one file per subject and uploads it next to
    // index.html; these functions pull it back down into IndexedDB.

    function fetchSubjectFile(subjectId) {
        return fetch('questions-' + subjectId + '.json?v=' + Date.now(), { cache: 'no-store' })
            .then(function (res) {
                if (res.status === 404) return { notFound: true };
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json().then(function (data) {
                    // Real export shape (confirmed from an actual exported file):
                    // { version, subject_id, exportedAt, questions: [...], passages: [...],
                    //   topics: [...], topic_questions: [...] }
                    // Still accept a bare array for backward compatibility.
                    var arr = Array.isArray(data) ? data : (data && data.questions) || [];
                    var passages = (data && !Array.isArray(data) && data.passages) || [];
                    var topics = (data && !Array.isArray(data) && data.topics) || [];
                    var topicQuestions = (data && !Array.isArray(data) && data.topic_questions) || [];
                    return { notFound: false, questions: arr, passages: passages, topics: topics, topic_questions: topicQuestions };
                });
            });
    }

    OfflineDB.exportSubjectData = function (subjectId) {
        return Promise.all([
            storeGetAllByIndex('questions', 'by_subject', subjectId),
            storeGetAll('passages'),
            storeGetAllByIndex('topics', 'by_subject', subjectId)
        ]).then(function (res) {
            var questions = res[0];
            var passages = res[1].filter(function (p) { return p.subject_id === subjectId; });
            var topics = res[2];
            var topicIds = topics.map(function (t) { return t.id; });
            return storeGetAll('topic_questions').then(function (allTQ) {
                var topicQuestions = allTQ.filter(function (tq) { return topicIds.indexOf(tq.topic_id) !== -1; });
                var payload = {
                    version: '1.0',
                    subject_id: subjectId,
                    exportedAt: new Date().toISOString(),
                    questions: questions,
                    passages: passages,
                    topics: topics,
                    topic_questions: topicQuestions
                };
                downloadJson('questions-' + subjectId + '.json', payload);
                return payload;
            });
        });
    };

    OfflineDB.reconcileAllSubjectFiles = function (subjectIds) {
        var results = {};
        var networkReached = false;

        return Promise.all(subjectIds.map(function (subjectId) {
            return fetchSubjectFile(subjectId).then(function (file) {
                networkReached = true;
                if (file.notFound) {
                    return storeGetAllByIndex('questions', 'by_subject', subjectId).then(function (existing) {
                        return Promise.all(existing.map(function (q) { return storeDelete('questions', q.id); }));
                    }).then(function () {
                        results[subjectId] = { status: 'wiped' };
                    });
                }
                return storeGetAllByIndex('questions', 'by_subject', subjectId).then(function (existing) {
                    return Promise.all(existing.map(function (q) { return storeDelete('questions', q.id); }));
                }).then(function () {
                    var normalized = file.questions.map(function (q) {
                        var copy = Object.assign({}, q);
                        if (!copy.id) copy.id = uid();
                        copy.subject_id = subjectId;
                        return copy;
                    });
                    var passagePuts = (file.passages || []).map(function (p) {
                        var copy = Object.assign({}, p, { subject_id: p.subject_id || subjectId });
                        copy.id = copy.subject_id + '_' + copy.mode + '_' + copy.batch_number;
                        return storePut('passages', copy);
                    });
                    var topicIdMap = {};
                    var topicPuts = (file.topics || []).map(function (t) {
                        var copy = Object.assign({}, t, { subject_id: subjectId });
                        if (!copy.id) copy.id = uid();
                        topicIdMap[t.id] = copy.id;
                        return storePut('topics', copy);
                    });
                    var topicQuestionPuts = (file.topic_questions || []).map(function (tq) {
                        var copy = Object.assign({}, tq);
                        if (!copy.id) copy.id = uid();
                        if (copy.topic_id && topicIdMap[copy.topic_id]) copy.topic_id = topicIdMap[copy.topic_id];
                        return storePut('topic_questions', copy);
                    });
                    return Promise.all(
                        [normalized.length ? storePutAll('questions', normalized) : Promise.resolve()]
                            .concat(passagePuts).concat(topicPuts).concat(topicQuestionPuts)
                    ).then(function () {
                        results[subjectId] = { status: 'reconciled', count: normalized.length };
                    });
                });
            }).catch(function (e) {
                // A real network/HTTP failure (not a clean 404) for this
                // one subject — leave its local data untouched.
                results[subjectId] = { status: 'error', error: e && e.message };
            });
        })).then(function () {
            results.__networkReached = networkReached;
            return results;
        });
    };

    OfflineDB.forceSyncSubjectFile = function (subjectId) {
        return fetchSubjectFile(subjectId).then(function (file) {
            if (file.notFound) return null;
            return storeGetAllByIndex('questions', 'by_subject', subjectId).then(function (existing) {
                return Promise.all(existing.map(function (q) { return storeDelete('questions', q.id); }));
            }).then(function () {
                var normalized = file.questions.map(function (q) {
                    var copy = Object.assign({}, q);
                    if (!copy.id) copy.id = uid();
                    copy.subject_id = subjectId;
                    return copy;
                });
                return (normalized.length ? storePutAll('questions', normalized) : Promise.resolve())
                    .then(function () { return { added: normalized.length }; });
            });
        }).catch(function () { return null; });
    };

    // Lighter-weight, additive-only sync used at runtime (e.g. when a
    // subject's local data is unexpectedly empty) — never deletes
    // anything, just fills in what's missing, and fails silently per
    // subject so it can never throw and break the calling flow.
    OfflineDB.syncAllSubjectFiles = function (subjectIds) {
        return Promise.all(subjectIds.map(function (subjectId) {
            return fetchSubjectFile(subjectId).then(function (file) {
                if (file.notFound) return;
                var normalized = file.questions.map(function (q) {
                    var copy = Object.assign({}, q);
                    if (!copy.id) copy.id = uid();
                    copy.subject_id = subjectId;
                    return copy;
                });
                return normalized.length ? storePutAll('questions', normalized) : Promise.resolve();
            }).catch(function () { /* ignore — additive best-effort */ });
        }));
    };

    // Expose the real implementation. index.html's readiness shim
    // (in the inline <script> above this one) is listening for this
    // assignment and will forward any queued calls automatically.
    window.OfflineDB = OfflineDB;
})();
