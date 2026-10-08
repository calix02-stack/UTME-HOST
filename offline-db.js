
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
    var currentDb = null;

    // ------------------------------------------------------------
    // STALE CONNECTION RECOVERY
    // ------------------------------------------------------------
    // Root cause of "works right after a reload, then hangs with no
    // error after leaving the app and coming back": iOS Safari/WKWebView
    // (and some Android WebViews) can silently invalidate an open
    // IndexedDB connection while the tab is backgrounded — sometimes
    // without ever firing `onclose`. Every call made on that connection
    // afterward just hangs forever: no success, no error, nothing.
    // Reloading the page works because it creates a brand new connection.
    //
    // Fix: (1) if the connection DOES fire onclose/onversionchange, drop
    // our cached reference immediately so the next call reopens fresh.
    // (2) Don't rely on that firing at all — proactively recycle the
    // connection every time the tab becomes visible again, before any
    // question load even gets a chance to run into a dead connection.
    function invalidateConnection(reason) {
        try { console.info('offline-db: recycling IndexedDB connection: ' + reason); } catch (e) {}
        if (currentDb) { try { currentDb.close(); } catch (e) {} }
        dbPromise = null;
        currentDb = null;
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState !== 'visible' || !dbPromise || !currentDb) return;
            // Health-check first: a live connection answers a tiny read at
            // once, so leave it alone. Only a dead one (throws or hangs)
            // gets recycled — closing a healthy connection on every tab
            // switch was itself causing hangs and log spam.
            var checked = currentDb, answered = false;
            var t = setTimeout(function () {
                if (!answered && currentDb === checked) invalidateConnection('connection unresponsive after resume');
            }, 1500);
            try {
                var r = checked.transaction('meta', 'readonly').objectStore('meta').count();
                r.onsuccess = r.onerror = function () { answered = true; clearTimeout(t); };
            } catch (err) {
                clearTimeout(t);
                if (currentDb === checked) invalidateConnection('connection threw on resume: ' + (err && err.message));
            }
        });
    }

    // ------------------------------------------------------------
    // DIAGNOSTIC REPORTER
    // ------------------------------------------------------------
    // Question loads were timing out app-wide with no clue why — the
    // 12s timeout in index.html just says "timed out", not WHAT
    // actually happened underneath (IndexedDB blocked? never
    // responded at all? genuinely errored?). This pipes real
    // diagnostics into the same Admin Panel > Errors log the app
    // already has (via window.logAppError, defined in index.html and
    // already loaded by the time this file runs), so the next
    // occurrence shows the real cause instead of just "timed out".
    // Never throws — a broken diagnostic must never break the app.
    var lastDiag = {};
    function reportDiagnostic(context, extra) {
        try {
            var now = Date.now();
            if (lastDiag[context] && now - lastDiag[context] < 300000) return; // same message at most once / 5 min
            lastDiag[context] = now;
            var detail = extra ? ' | ' + JSON.stringify(extra) : '';
            if (typeof window.logAppError === 'function') {
                window.logAppError('offline-db diagnostic: ' + context, { message: context + detail });
            } else {
                console.warn('offline-db diagnostic:', context + detail);
            }
        } catch (e) { /* diagnostics must never throw */ }
    }

    function openDB() {
        if (dbPromise) return dbPromise;
        var startedAt = Date.now();
        var blockedFired = false;
        dbPromise = new Promise(function (resolve, reject) {
            if (typeof indexedDB === 'undefined') {
                reportDiagnostic('openDB: indexedDB is unavailable in this environment', {
                    userAgent: navigator.userAgent
                });
                reject(new Error('IndexedDB unavailable'));
                return;
            }

            var req;
            try {
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (syncErr) {
                reportDiagnostic('openDB: indexedDB.open threw synchronously', {
                    message: syncErr && syncErr.message, userAgent: navigator.userAgent
                });
                reject(syncErr);
                return;
            }

            // If the request hasn't fired ANY callback (success, error, or
            // even blocked) after 4s, something below the JS layer is
            // stuck — most commonly a WebView/browser with broken or
            // restricted IndexedDB support. This only logs; it does not
            // change what openDB() resolves to (that's handled by the
            // network-fallback race added in loadQuestionsOffline below).
            var watchdog = setTimeout(function () {
                reportDiagnostic('openDB: indexedDB.open has not settled after 4s', {
                    blockedFired: blockedFired,
                    userAgent: navigator.userAgent,
                    standalone: (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true
                });
            }, 4000);

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
            req.onsuccess = function (e) {
                clearTimeout(watchdog);
                var elapsed = Date.now() - startedAt;
                if (elapsed > 4000) {
                    reportDiagnostic('openDB: succeeded but only after ' + elapsed + 'ms', { blockedFired: blockedFired });
                }
                var db = e.target.result;
                currentDb = db;
                // Fires if the browser/OS reclaims this connection (backgrounding,
                // memory pressure, etc). When it does, don't leave dbPromise
                // pointing at a dead connection — the next call should open fresh.
                db.onclose = function () { invalidateConnection('connection closed unexpectedly'); };
                // Fires if another tab/context needs to upgrade the DB version.
                // We must close our side or that other tab hangs forever too.
                db.onversionchange = function () { invalidateConnection('versionchange from another tab'); };
                resolve(db);
            };
            req.onerror = function (e) {
                clearTimeout(watchdog);
                dbPromise = null;
                reportDiagnostic('openDB: onerror', {
                    message: (e.target.error && e.target.error.message) || 'unknown',
                    elapsedMs: Date.now() - startedAt
                });
                reject(e.target.error || new Error('IndexedDB open failed'));
            };
            req.onblocked = function () {
                blockedFired = true;
                reportDiagnostic('openDB: blocked by another open connection/tab');
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

    // Delete many records inside ONE transaction (instead of one transaction
    // per record, which flooded IndexedDB and made topic loads time out).
    function storeDeleteAll(storeName, keys) {
        if (!keys || !keys.length) return Promise.resolve();
        return tx(storeName, 'readwrite').then(function (store) {
            return Promise.all(keys.map(function (k) { return reqToPromise(store.delete(k)); }));
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

    // ------------------------------------------------------------
    // CONCURRENCY LIMITER
    // ------------------------------------------------------------
    // Used by reconcileAllSubjectFiles below. Browsers cap concurrent
    // HTTP connections to one origin at roughly 6. reconcileAllSubjectFiles
    // used to Promise.all() a full-file network fetch for every subject at
    // once (often 9-10) the instant the app opened. If the person tapped
    // into a mode right away, that mode's own subject-file fetch (see
    // loadQuestionsOffline's network fallback below) had to queue behind
    // this whole burst before it could even start — which is exactly why
    // the very first mode opened after a cold start/refresh felt slow,
    // while everything after that (once the burst finished) was instant.
    // Running only a few subjects at a time takes about the same total
    // time to finish, but leaves real headroom in the connection pool for
    // whatever the person taps first.
    function mapWithConcurrency(items, limit, worker) {
        var idx = 0;
        var results = new Array(items.length);
        function runNext() {
            if (idx >= items.length) return Promise.resolve();
            var i = idx++;
            return Promise.resolve(worker(items[i], i)).then(function (r) {
                results[i] = r;
                return runNext();
            });
        }
        var runners = [];
        var n = Math.max(1, Math.min(limit, items.length));
        for (var k = 0; k < n; k++) runners.push(runNext());
        return Promise.all(runners).then(function () { return results; });
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

    function filterQuestions(rows, type, year, limit) {
        var filtered = rows.filter(function (q) { return !type || q.type === type; });
        if (year !== undefined && year !== null) {
            filtered = filtered.filter(function (q) { return q.year === year; });
        }
        if (limit) {
            filtered = shuffle(filtered).slice(0, limit);
        }
        return filtered;
    }

    // Local DB has been observed hanging on some devices/browsers 100% of
    // the time (not just occasionally) — so waiting on it FIRST before even
    // trying the network, as an earlier version of this function did, was
    // itself a source of a multi-second (or infinite) spinner on those
    // devices. The safety net for that is a network fetch of the same
    // subject's question file as a fallback.
    //
    // Previously that network fetch was started unconditionally, in
    // parallel, on every single call — meaning every mode load also fired
    // a full-subject-file network request even on the (overwhelmingly
    // common) devices where local IndexedDB is perfectly healthy and fast.
    // That's wasted data/battery for the person, and — worse — a burst of
    // these from several question loads plus the startup reconcile could
    // all compete for the browser's small per-origin connection pool at
    // once, adding to the "first load after a cold start is slow" problem.
    //
    // Fix: start the local read; give it a short 350ms head start. If it
    // answers with real data before that, use it and never touch the
    // network at all. Only fall back to a network fetch if local hasn't
    // answered within 350ms (the hang/slow case this exists for), or if
    // local answers but has nothing for this subject yet, or if local
    // errors outright. The hang-safety guarantee is unchanged: once the
    // network fallback has actually been started, its outcome is what
    // this resolves/rejects with — it does not keep waiting on local,
    // since local may never come back at all on the affected devices.
    OfflineDB.loadQuestionsOffline = function (type, subjectId, year, limit) {
        var localPromise = storeGetAllByIndex('questions', 'by_type_subject', [type, subjectId]);
        var networkStarted = false;

        return new Promise(function (resolve, reject) {
            var settled = false;
            var localDone = false, networkDone = false;
            var localErr = null, networkErr = null;

            function finish(filtered) {
                settled = true;
                resolve(filtered);
            }

            function maybeFail() {
                if (settled) return;
                // Once the network fallback has actually been tried, its
                // result is authoritative — local may never finish on a
                // hung connection, and that hang is exactly what this
                // fallback exists to route around.
                if (networkStarted) {
                    if (!networkDone) return;
                    reject(localErr || networkErr || new Error('No questions available'));
                    return;
                }
                if (localDone) reject(localErr || new Error('No questions available'));
            }

            function onNetworkResult(file) {
                networkDone = true;
                if (settled) return;
                if (file.notFound || !file.questions || !file.questions.length) { maybeFail(); return; }
                var filtered = filterQuestions(file.questions, type, year, limit);
                if (filtered.length > 0) {
                    finish(filtered);
                    // Best-effort: cache what we fetched for next time, so a
                    // working local DB has this data available offline later.
                    storePutAll('questions', file.questions.map(function (q) {
                        var copy = Object.assign({}, q);
                        if (!copy.id) copy.id = uid();
                        copy.subject_id = subjectId;
                        return copy;
                    })).catch(function () {});
                } else {
                    maybeFail();
                }
            }
            function onNetworkError(err) {
                networkDone = true;
                networkErr = err;
                maybeFail();
            }
            function startNetwork() {
                if (networkStarted) return;
                networkStarted = true;
                fetchSubjectFile(subjectId).then(onNetworkResult, onNetworkError);
            }

            // The head start: only reached for — and thus only costs
            // network data on — a device where local hasn't answered
            // within 350ms.
            var localWaitTimer = setTimeout(function () {
                if (!settled && !localDone) startNetwork();
            }, 350);

            localPromise.then(function (rows) {
                clearTimeout(localWaitTimer);
                localDone = true;
                if (settled) return;
                var filtered = filterQuestions(rows, type, year, limit);
                if (filtered.length > 0) { finish(filtered); return; }
                // Nothing locally for this subject/type yet — go straight
                // to network rather than waiting out the rest of the window.
                startNetwork();
            }, function (err) {
                clearTimeout(localWaitTimer);
                localDone = true;
                localErr = err;
                if (settled) return;
                reportDiagnostic('loadQuestionsOffline: local DB error', { type: type, subjectId: subjectId, error: err && err.message });
                startNetwork();
            });

            // Purely informational — does not delay or change the result,
            // just tells us in the Errors log if this is taking a while,
            // so a slow case is visible without slowing anything down.
            setTimeout(function () {
                if (!settled) {
                    reportDiagnostic('loadQuestionsOffline: still waiting after 1200ms', {
                        type: type, subjectId: subjectId, localDone: localDone, networkStarted: networkStarted, networkDone: networkDone
                    });
                }
            }, 1200);
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
        // Fail instantly when offline (no point waiting on a dead
        // connection), and cap how long we wait otherwise so a flaky
        // network can never hang this indefinitely. This used to live in
        // a separate offline-db-boost.js file that patched window.fetch
        // globally; folded in here directly instead, scoped to just this
        // one call site.
        if (navigator.onLine === false) {
            return Promise.reject(new TypeError('Failed to fetch (offline)'));
        }
        // 'no-cache' = ask the server "changed?" (ETag) and reuse the saved copy on a
        // tiny 304 reply. Was 'no-store' + a ?v=timestamp, which re-downloaded every
        // subject file (up to 1.6 MB each) on EVERY open and starved other requests.
        var fetchOpts = { cache: 'no-cache' };
        var abortTimer;
        if (typeof AbortController !== 'undefined') {
            var ctrl = new AbortController();
            abortTimer = setTimeout(function () { ctrl.abort(); }, 20000);
            fetchOpts.signal = ctrl.signal;
        }
        return fetch('questions-' + subjectId + '.json', fetchOpts)
            .finally(function () { clearTimeout(abortTimer); })
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
                    return { notFound: false, exportedAt: (data && !Array.isArray(data) && data.exportedAt) || '', questions: arr, passages: passages, topics: topics, topic_questions: topicQuestions };
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

    // Removes every topic (and its questions) stored for a subject so a
    // fresh copy from the subject file can replace it. Without this,
    // topics added/renamed in the file never reached devices that had
    // an older copy.
    function clearSubjectTopics(subjectId) {
        return storeGetAllByIndex('topics', 'by_subject', subjectId).then(function (topics) {
            return Promise.all(topics.map(function (t) {
                return storeGetAllByIndex('topic_questions', 'by_topic', t.id);
            })).then(function (lists) {
                var qIds = [];
                lists.forEach(function (qs) { qs.forEach(function (q) { qIds.push(q.id); }); });
                return storeDeleteAll('topic_questions', qIds);
            }).then(function () {
                return storeDeleteAll('topics', topics.map(function (t) { return t.id; }));
            });
        });
    }

    // Additive: writes ALL topics (even ones with no questions yet) and
    // their questions from a subject file, never deleting anything.
    function putSubjectTopics(subjectId, file) {
        var topics = (file.topics || []).map(function (t) {
            var copy = Object.assign({}, t, { subject_id: subjectId });
            if (!copy.id) copy.id = uid();
            return copy;
        });
        var tqs = (file.topic_questions || []).map(function (tq) {
            var copy = Object.assign({}, tq);
            if (!copy.id) copy.id = uid();
            return copy;
        });
        return Promise.all([
            topics.length ? storePutAll('topics', topics) : Promise.resolve(),
            tqs.length ? storePutAll('topic_questions', tqs) : Promise.resolve()
        ]);
    }

    OfflineDB.reconcileAllSubjectFiles = function (subjectIds) {
        var results = {};
        var networkReached = false;

        // Fingerprint of a subject file. If it matches what is already saved on
        // this device AND the local copy is complete, we skip the (slow) rewrite
        // entirely. Before, EVERY app open / return-to-app deleted and re-wrote
        // every subject one record at a time, which blocked topic practice.
        function fingerprint(file) {
            return [file.exportedAt || '', file.questions.length, (file.topics || []).length, (file.topic_questions || []).length].join('|');
        }

        return mapWithConcurrency(subjectIds, 2, function (subjectId) {
            return fetchSubjectFile(subjectId).then(function (file) {
                networkReached = true;
                if (file.notFound) {
                    return storeGetAllByIndex('questions', 'by_subject', subjectId).then(function (existing) {
                        return storeDeleteAll('questions', existing.map(function (q) { return q.id; }));
                    }).then(function () {
                        results[subjectId] = { status: 'wiped' };
                    });
                }
                var fp = fingerprint(file);
                return Promise.all([
                    storeGet('meta', 'sync_' + subjectId),
                    storeGetAllByIndex('questions', 'by_subject', subjectId),
                    storeGetAllByIndex('topics', 'by_subject', subjectId)
                ]).then(function (cur) {
                    var saved = cur[0], localQs = cur[1], localTopics = cur[2];
                    if (saved && saved.fp === fp && localQs.length === file.questions.length && localTopics.length === (file.topics || []).length) {
                        results[subjectId] = { status: 'unchanged', count: localQs.length };
                        return;
                    }
                    return storeDeleteAll('questions', localQs.map(function (q) { return q.id; })).then(function () {
                        return clearSubjectTopics(subjectId);
                    }).then(function () {
                        var normalized = file.questions.map(function (q) {
                            var copy = Object.assign({}, q);
                            if (!copy.id) copy.id = uid();
                            copy.subject_id = subjectId;
                            return copy;
                        });
                        var passages = (file.passages || []).map(function (p) {
                            var copy = Object.assign({}, p, { subject_id: p.subject_id || subjectId });
                            copy.id = copy.subject_id + '_' + copy.mode + '_' + copy.batch_number;
                            return copy;
                        });
                        var topicIdMap = {};
                        var topics = (file.topics || []).map(function (t) {
                            var copy = Object.assign({}, t, { subject_id: subjectId });
                            if (!copy.id) copy.id = uid();
                            topicIdMap[t.id] = copy.id;
                            return copy;
                        });
                        var tqs = (file.topic_questions || []).map(function (tq) {
                            var copy = Object.assign({}, tq);
                            if (!copy.id) copy.id = uid();
                            if (copy.topic_id && topicIdMap[copy.topic_id]) copy.topic_id = topicIdMap[copy.topic_id];
                            return copy;
                        });
                        // Topics first so the topic list is never empty for long, then the rest.
                        return (topics.length ? storePutAll('topics', topics) : Promise.resolve())
                            .then(function () { return tqs.length ? storePutAll('topic_questions', tqs) : Promise.resolve(); })
                            .then(function () { return normalized.length ? storePutAll('questions', normalized) : Promise.resolve(); })
                            .then(function () { return passages.length ? storePutAll('passages', passages) : Promise.resolve(); })
                            .then(function () { return storePut('meta', { key: 'sync_' + subjectId, fp: fp }); })
                            .then(function () { results[subjectId] = { status: 'reconciled', count: normalized.length }; });
                    });
                });
            }).catch(function (e) {
                // A real network/HTTP failure (not a clean 404) for this
                // one subject — leave its local data untouched.
                results[subjectId] = { status: 'error', error: e && e.message };
            });
        }).then(function () {
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
                    .then(function () { return putSubjectTopics(subjectId, file); })
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
                return (normalized.length ? storePutAll('questions', normalized) : Promise.resolve())
                    .then(function () { return putSubjectTopics(subjectId, file); });
            }).catch(function () { /* ignore — additive best-effort */ });
        }));
    };

    // Expose the real implementation. index.html's readiness shim
    // (in the inline <script> above this one) is listening for this
    // assignment and will forward any queued calls automatically.
    window.OfflineDB = OfflineDB;
})();
