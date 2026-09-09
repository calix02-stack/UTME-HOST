// ============================================================
// OFFLINE-DB.JS — Complete Offline Question Database
// ============================================================
// This file provides all database functions without Supabase
// dependencies, storing data in IndexedDB for offline use.

// ============================================================
// INDEXEDDB SETUP
// ============================================================
const DB_NAME = 'MyUTME_OfflineDB';
const DB_VERSION = 1;

let db = null;
let dbReady = false;
let dbInitPromise = null;

function openDB() {
    if (dbInitPromise) return dbInitPromise;
    
    dbInitPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = function() {
            console.error('IndexedDB open error:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = function() {
            db = request.result;
            dbReady = true;
            resolve(db);
        };
        
        request.onupgradeneeded = function(e) {
            const db = e.target.result;
            
            // Questions store
            if (!db.objectStoreNames.contains('questions')) {
                const store = db.createObjectStore('questions', { keyPath: 'id' });
                store.createIndex('subject_id', 'subject_id', { unique: false });
                store.createIndex('type', 'type', { unique: false });
                store.createIndex('subject_type', ['subject_id', 'type'], { unique: false });
            }
            
            // Passages store
            if (!db.objectStoreNames.contains('passages')) {
                const store = db.createObjectStore('passages', { keyPath: 'id' });
                store.createIndex('batch_number', 'batch_number', { unique: false });
                store.createIndex('subject_id', 'subject_id', { unique: false });
            }
            
            // Topics store
            if (!db.objectStoreNames.contains('topics')) {
                const store = db.createObjectStore('topics', { keyPath: 'id' });
                store.createIndex('subject_id', 'subject_id', { unique: false });
            }
            
            // Topic questions store
            if (!db.objectStoreNames.contains('topic_questions')) {
                const store = db.createObjectStore('topic_questions', { keyPath: 'id' });
                store.createIndex('topic_id', 'topic_id', { unique: false });
            }
            
            // Settings store
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }
            
            // Metadata store
            if (!db.objectStoreNames.contains('metadata')) {
                db.createObjectStore('metadata', { keyPath: 'key' });
            }
        };
    });
    
    return dbInitPromise;
}

function dbTransaction(storeName, mode, callback) {
    return openDB().then((db) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            
            tx.oncomplete = function() { resolve(); };
            tx.onerror = function() { reject(tx.error); };
            
            callback(store, resolve, reject);
        });
    });
}

function dbGetAll(storeName) {
    return new Promise((resolve, reject) => {
        openDB().then((db) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.getAll();
            
            request.onsuccess = function() {
                resolve(request.result || []);
            };
            request.onerror = function() {
                reject(request.error);
            };
        }).catch(reject);
    });
}

function dbGet(storeName, id) {
    return new Promise((resolve, reject) => {
        openDB().then((db) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.get(id);
            
            request.onsuccess = function() {
                resolve(request.result || null);
            };
            request.onerror = function() {
                reject(request.error);
            };
        }).catch(reject);
    });
}

function dbPut(storeName, data) {
    return new Promise((resolve, reject) => {
        openDB().then((db) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.put(data);
            
            request.onsuccess = function() {
                resolve(request.result);
            };
            request.onerror = function() {
                reject(request.error);
            };
        }).catch(reject);
    });
}

function dbDelete(storeName, id) {
    return new Promise((resolve, reject) => {
        openDB().then((db) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.delete(id);
            
            request.onsuccess = function() {
                resolve();
            };
            request.onerror = function() {
                reject(request.error);
            };
        }).catch(reject);
    });
}

function dbIndexGetAll(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
        openDB().then((db) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const index = store.index(indexName);
            const request = index.getAll(value);
            
            request.onsuccess = function() {
                resolve(request.result || []);
            };
            request.onerror = function() {
                reject(request.error);
            };
        }).catch(reject);
    });
}

// ============================================================
// DATA STRUCTURES
// ============================================================
let cachedQuestions = [];
let cachedPassages = [];
let cachedTopics = [];
let cachedTopicQuestions = [];

// ============================================================
// SEED DATA - Default questions if none exist
// ============================================================
const DEFAULT_SEED_DATA = {
    questions: [],
    passages: [],
    topics: [],
    topic_questions: [],
};

// ============================================================
// PUBLIC API FUNCTIONS
// ============================================================

// ---- QUESTIONS ----

async function addQuestionOffline(question) {
    if (!question.id) {
        question.id = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }
    question.created_at = question.created_at || new Date().toISOString();
    await dbPut('questions', question);
    // Update cache
    const idx = cachedQuestions.findIndex(q => q.id === question.id);
    if (idx >= 0) cachedQuestions[idx] = question;
    else cachedQuestions.push(question);
    return question;
}

async function updateQuestionOffline(id, updates) {
    const existing = await dbGet('questions', id);
    if (!existing) throw new Error('Question not found: ' + id);
    const updated = { ...existing, ...updates };
    await dbPut('questions', updated);
    // Update cache
    const idx = cachedQuestions.findIndex(q => q.id === id);
    if (idx >= 0) cachedQuestions[idx] = updated;
    else cachedQuestions.push(updated);
    return updated;
}

async function deleteQuestionOffline(id) {
    await dbDelete('questions', id);
    // Update cache
    cachedQuestions = cachedQuestions.filter(q => q.id !== id);
}

async function getQuestionsOffline(type, subjectId, year, limit) {
    // Try cache first
    let results = cachedQuestions.filter(q => {
        if (q.type !== type) return false;
        if (subjectId && q.subject_id !== subjectId) return false;
        if (year && q.year !== year) return false;
        return true;
    });
    
    if (results.length > 0) {
        if (limit) results = results.slice(0, limit);
        return results;
    }
    
    // Fall back to DB
    let allQuestions = await dbGetAll('questions');
    cachedQuestions = allQuestions;
    results = allQuestions.filter(q => {
        if (q.type !== type) return false;
        if (subjectId && q.subject_id !== subjectId) return false;
        if (year && q.year !== year) return false;
        return true;
    });
    if (limit) results = results.slice(0, limit);
    return results;
}

async function loadQuestionsOffline(type, subjectId, year, limit) {
    return await getQuestionsOffline(type, subjectId, year, limit);
}

// Fetch a specific set of questions by id (used e.g. to resume a mock/exam
// attempt whose question_ids were already picked and saved earlier).
async function getQuestionsByIdsOffline(ids) {
    if (!ids || ids.length === 0) return [];
    const idSet = new Set(ids);
    let pool = cachedQuestions.length > 0 ? cachedQuestions : await dbGetAll('questions');
    cachedQuestions = pool;
    const found = pool.filter(q => idSet.has(q.id));
    // Preserve the original order of `ids` where possible.
    const byId = {};
    found.forEach(q => { byId[q.id] = q; });
    return ids.map(id => byId[id]).filter(Boolean);
}

// ---- PASSAGES ----

async function getPassageOffline(batchNumber) {
    const results = cachedPassages.filter(p => p.batch_number === batchNumber);
    if (results.length > 0) return results[0] || null;
    
    const allPassages = await dbGetAll('passages');
    cachedPassages = allPassages;
    return allPassages.find(p => p.batch_number === batchNumber) || null;
}

async function addPassageOffline(passage) {
    if (!passage.id) {
        passage.id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }
    await dbPut('passages', passage);
    cachedPassages.push(passage);
    return passage;
}

// Upsert one passage for a (subject_id, batch_number) pair — CBT/Mock/Exam
// all share a single passage per batch number, so saving from the admin
// screen should REPLACE whatever's already stored for that batch, not add
// a duplicate. This is what the "Save Passage" button in index.html calls
// via window.savePassageOffline -> window.OfflineDB.savePassageOffline.
//
// Previously this function didn't exist at all on window.OfflineDB, so
// every "Save Passage" click threw "OfflineDB.savePassageOffline is not a
// function" and nothing was ever written to IndexedDB — which is also why
// passages always came up empty on export (there was never anything there
// to export).
async function savePassageOffline(data) {
    let all = cachedPassages.length > 0 ? cachedPassages : await dbGetAll('passages');
    cachedPassages = all;
    const existing = all.find(p => p.subject_id === data.subject_id && p.batch_number === data.batch_number);
    const record = {
        id: existing ? existing.id : ('p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
        subject_id: data.subject_id,
        batch_number: data.batch_number,
        title: data.title || '',
        passage_text: data.passage_text || '',
        created_at: existing ? existing.created_at : new Date().toISOString(),
    };
    await dbPut('passages', record);
    cachedPassages = await dbGetAll('passages');
    return record;
}

// Distinct batch numbers available for a subject (used to pick a random
// unseen comprehension batch for English mock exams, offline).
async function getPassageBatchesOffline(subjectId) {
    let all = cachedPassages.length > 0 ? cachedPassages : await dbGetAll('passages');
    cachedPassages = all;
    const nums = all
        .filter(p => !subjectId || p.subject_id === subjectId)
        .map(p => p.batch_number)
        .filter(n => n !== undefined && n !== null);
    return Array.from(new Set(nums)).sort((a, b) => a - b);
}

// ---- TOPICS ----

async function getTopicsOffline(subjectId) {
    if (cachedTopics.length > 0) {
        return cachedTopics.filter(t => t.subject_id === subjectId);
    }
    const allTopics = await dbGetAll('topics');
    cachedTopics = allTopics;
    return allTopics.filter(t => t.subject_id === subjectId);
}

async function addTopicOffline(subjectId, name) {
    const topic = {
        id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        subject_id: subjectId,
        name: name,
        created_at: new Date().toISOString(),
    };
    await dbPut('topics', topic);
    cachedTopics.push(topic);
    return topic;
}

async function deleteTopicOffline(topicId) {
    // Delete all topic questions first
    const tqs = await getTopicQuestionsOffline(topicId);
    for (const tq of tqs) {
        await dbDelete('topic_questions', tq.id);
    }
    cachedTopicQuestions = cachedTopicQuestions.filter(tq => tq.topic_id !== topicId);
    
    await dbDelete('topics', topicId);
    cachedTopics = cachedTopics.filter(t => t.id !== topicId);
}

// ---- TOPIC QUESTIONS ----

async function getTopicQuestionsOffline(topicId) {
    if (cachedTopicQuestions.length > 0) {
        return cachedTopicQuestions.filter(tq => tq.topic_id === topicId);
    }
    const allTQs = await dbGetAll('topic_questions');
    cachedTopicQuestions = allTQs;
    return allTQs.filter(tq => tq.topic_id === topicId);
}

async function addTopicQuestionOffline(topicId, questionData) {
    const tq = {
        id: 'tq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        topic_id: topicId,
        text: questionData.text || '',
        options: questionData.options || ['', '', '', ''],
        correct_answer: questionData.correct_answer || 0,
        explanation: questionData.explanation || '',
        created_at: new Date().toISOString(),
    };
    await dbPut('topic_questions', tq);
    cachedTopicQuestions.push(tq);
    return tq;
}

async function updateTopicQuestionOffline(id, updates) {
    const existing = await dbGet('topic_questions', id);
    if (!existing) throw new Error('Topic question not found: ' + id);
    const updated = { ...existing, ...updates };
    await dbPut('topic_questions', updated);
    const idx = cachedTopicQuestions.findIndex(tq => tq.id === id);
    if (idx >= 0) cachedTopicQuestions[idx] = updated;
    else cachedTopicQuestions.push(updated);
    return updated;
}

async function deleteTopicQuestionOffline(id) {
    await dbDelete('topic_questions', id);
    cachedTopicQuestions = cachedTopicQuestions.filter(tq => tq.id !== id);
}

// Replace ALL questions under one topic with a fresh list in one go — used
// by the subject-JSON bulk importer so re-uploading a subject file cleanly
// overwrites that topic's question bank instead of appending duplicates.
async function replaceTopicQuestionsOffline(topicId, questions) {
    const existing = await getTopicQuestionsOffline(topicId);
    for (const tq of existing) {
        await dbDelete('topic_questions', tq.id);
    }
    cachedTopicQuestions = cachedTopicQuestions.filter(tq => tq.topic_id !== topicId);

    const saved = [];
    for (const q of (questions || [])) {
        const tq = {
            id: 'tq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            topic_id: topicId,
            text: q.text || '',
            options: q.options || ['', '', '', ''],
            correct_answer: (typeof q.correct_answer === 'number') ? q.correct_answer : 0,
            explanation: q.explanation || '',
            created_at: new Date().toISOString(),
        };
        await dbPut('topic_questions', tq);
        cachedTopicQuestions.push(tq);
        saved.push(tq);
    }
    return saved;
}

// ---- BULK IMPORT/EXPORT ----

async function exportOfflineData() {
    const questions = await dbGetAll('questions');
    const passages = await dbGetAll('passages');
    const topics = await dbGetAll('topics');
    const topic_questions = await dbGetAll('topic_questions');
    
    const data = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        questions,
        passages,
        topics,
        topic_questions,
    };
    
    // Download as JSON
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'questions-seed.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    return data;
}

async function importOfflineData(data, strategy = 'replace') {
    const results = {
        questions: 0,
        passages: 0,
        topics: 0,
        topic_questions: 0,
    };
    
    if (strategy === 'replace') {
        // Clear existing data
        const allQuestions = await dbGetAll('questions');
        for (const q of allQuestions) {
            await dbDelete('questions', q.id);
        }
        const allPassages = await dbGetAll('passages');
        for (const p of allPassages) {
            await dbDelete('passages', p.id);
        }
        const allTopics = await dbGetAll('topics');
        for (const t of allTopics) {
            await dbDelete('topics', t.id);
        }
        const allTQs = await dbGetAll('topic_questions');
        for (const tq of allTQs) {
            await dbDelete('topic_questions', tq.id);
        }
        cachedQuestions = [];
        cachedPassages = [];
        cachedTopics = [];
        cachedTopicQuestions = [];
    }
    
    // Import questions
    if (data.questions) {
        for (const q of data.questions) {
            if (strategy === 'replace') {
                await dbPut('questions', q);
            } else {
                const existing = await dbGet('questions', q.id);
                if (!existing) {
                    await dbPut('questions', q);
                    results.questions++;
                }
            }
        }
        cachedQuestions = await dbGetAll('questions');
        results.questions = cachedQuestions.length;
    }
    
    // Import passages
    if (data.passages) {
        for (const p of data.passages) {
            if (strategy === 'replace') {
                await dbPut('passages', p);
            } else {
                const existing = await dbGet('passages', p.id);
                if (!existing) {
                    await dbPut('passages', p);
                    results.passages++;
                }
            }
        }
        cachedPassages = await dbGetAll('passages');
        results.passages = cachedPassages.length;
    }
    
    // Import topics
    if (data.topics) {
        for (const t of data.topics) {
            if (strategy === 'replace') {
                await dbPut('topics', t);
            } else {
                const existing = await dbGet('topics', t.id);
                if (!existing) {
                    await dbPut('topics', t);
                    results.topics++;
                }
            }
        }
        cachedTopics = await dbGetAll('topics');
        results.topics = cachedTopics.length;
    }
    
    // Import topic questions
    if (data.topic_questions) {
        for (const tq of data.topic_questions) {
            if (strategy === 'replace') {
                await dbPut('topic_questions', tq);
            } else {
                const existing = await dbGet('topic_questions', tq.id);
                if (!existing) {
                    await dbPut('topic_questions', tq);
                    results.topic_questions++;
                }
            }
        }
        cachedTopicQuestions = await dbGetAll('topic_questions');
        results.topic_questions = cachedTopicQuestions.length;
    }
    
    return results;
}

// ---- SEED ----

async function seedOfflineDataIfNeeded() {
    // Check if we already have data
    const questions = await dbGetAll('questions');
    if (questions.length > 0) {
        cachedQuestions = questions;
        cachedPassages = await dbGetAll('passages');
        cachedTopics = await dbGetAll('topics');
        cachedTopicQuestions = await dbGetAll('topic_questions');
        return;
    }
    
    // Try to load from seed file
    try {
        const response = await fetch('questions-seed.json');
        if (response.ok) {
            const data = await response.json();
            if (data.questions && data.questions.length > 0) {
                await importOfflineData(data, 'replace');
                console.log('Seed data loaded from questions-seed.json');
                return;
            }
        }
    } catch (e) {
        // No seed file, that's fine
    }
    
    // No seed file, create minimal default data
    console.log('No seed data found, creating minimal defaults...');
}

// ---- SYNC HELPERS ----

async function isDBReady() {
    await openDB();
    return dbReady;
}

// ============================================================
//  PER-SUBJECT FILE SYNC
// ============================================================

// Merge one subject's data into IndexedDB (upsert by id — never deletes anything)
async function upsertSubjectData(data) {
    const counts = { questions: 0, passages: 0, topics: 0, topic_questions: 0 };
    if (data.questions) {
        for (const q of data.questions) { await dbPut('questions', q); counts.questions++; }
        cachedQuestions = await dbGetAll('questions');
    }
    if (data.passages) {
        for (const p of data.passages) { await dbPut('passages', p); counts.passages++; }
        cachedPassages = await dbGetAll('passages');
    }
    if (data.topics) {
        for (const t of data.topics) { await dbPut('topics', t); counts.topics++; }
        cachedTopics = await dbGetAll('topics');
    }
    if (data.topic_questions) {
        for (const tq of data.topic_questions) { await dbPut('topic_questions', tq); counts.topic_questions++; }
        cachedTopicQuestions = await dbGetAll('topic_questions');
    }
    return counts;
}

// Fetch and merge one subject's file (questions-<subjectId>.json) if it exists on the server
async function syncSubjectFile(subjectId) {
    try {
        const response = await fetch('questions-' + subjectId + '.json', { cache: 'no-store' });
        if (!response.ok) return null; // no file uploaded for this subject yet — not an error
        const data = await response.json();
        return await upsertSubjectData(data);
    } catch (e) {
        return null; // offline or network error — keep existing local data, don't crash
    }
}

// Sync every subject's file
async function syncAllSubjectFiles(subjectIds) {
    const results = {};
    for (const id of subjectIds) {
        results[id] = await syncSubjectFile(id);
    }
    return results;
}

// Force-replace: wipes local data for this subject FIRST, then loads fresh from the file.
// Use this after deleting questions, to guarantee stale local copies can't survive.
//
// NOTE: this intentionally only ever touches `questions` and `passages` —
// topics/topic_questions are admin-managed directly in IndexedDB (via the
// Topic Practice admin screen) and are never part of the
// questions-<subjectId>.json bulk file, so they must never be wiped here.
async function forceSyncSubjectFile(subjectId) {
    try {
        const response = await fetch('questions-' + subjectId + '.json', { cache: 'no-store' });
        if (!response.ok) return null;
        const data = await response.json();

        const allQuestions = await dbGetAll('questions');
        for (const q of allQuestions.filter(function(q) { return q.subject_id === subjectId; })) {
            await dbDelete('questions', q.id);
        }
        const allPassages = await dbGetAll('passages');
        for (const p of allPassages.filter(function(p) { return p.subject_id === subjectId; })) {
            await dbDelete('passages', p.id);
        }

        return await upsertSubjectData(data);
    } catch (e) {
        return null;
    }
}
// Build a downloadable file with everything for ONE subject
async function exportSubjectData(subjectId) {
    const allQuestions = await dbGetAll('questions');
    const allPassages = await dbGetAll('passages');
    const allTopics = await dbGetAll('topics');
    const allTopicQuestions = await dbGetAll('topic_questions');

    const questions = allQuestions.filter(function(q) { return q.subject_id === subjectId; });
    const passages = allPassages.filter(function(p) { return p.subject_id === subjectId; });
    const topics = allTopics.filter(function(t) { return t.subject_id === subjectId; });
    const topicIds = topics.map(function(t) { return t.id; });
    const topic_questions = allTopicQuestions.filter(function(tq) { return topicIds.indexOf(tq.topic_id) !== -1; });

    const data = {
        version: '1.0',
        subject_id: subjectId,
        exportedAt: new Date().toISOString(),
        questions, passages, topics, topic_questions,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'questions-' + subjectId + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return data;
}

// ============================================================
//  PER-SUBJECT RECONCILE (sync + delete)
// ============================================================
// Unlike syncSubjectFile/syncAllSubjectFiles above (which only ever ADD or
// UPDATE, never delete), these functions make the offline DB exactly match
// what's in the subject's file on the server:
//   - question/passage still in the file  -> kept, updated if changed
//   - question/passage NOT in the file    -> deleted from offline DB
//   - the whole file 404s (confirmed gone from the server)     -> every
//                                                                  local
//                                                                  question/
//                                                                  passage
//                                                                  for that
//                                                                  subject
//                                                                  is wiped
// A network error (offline, timeout, DNS failure, etc.) is NEVER treated as
// "the file was deleted" — in that case nothing local is touched, so the
// app keeps working normally with whatever it already has offline.
//
// IMPORTANT: topics/topic_questions (Topic Practice) are deliberately
// EXCLUDED from this reconcile process. They are entered directly by the
// admin into IndexedDB (there is no questions-<subjectId>.json equivalent
// for them being continuously re-uploaded), so treating "not present in
// this bulk file" as "delete it" was wiping out every topic and topic
// question on the very next reconcile pass — which is why Topic Practice
// was showing 0 questions for both admin and users. Topics/topic_questions
// are only ever added or updated here, never deleted by file-diffing.

// Wipe every local record belonging to one subject (used when the server
// confirms the subject's file no longer exists at all).
//
// Only questions/passages are wiped — see note above on why
// topics/topic_questions are never touched by this reconcile process.
async function wipeSubjectData(subjectId) {
    const allQuestions = await dbGetAll('questions');
    for (const q of allQuestions.filter(function(q) { return q.subject_id === subjectId; })) {
        await dbDelete('questions', q.id);
    }
    const allPassages = await dbGetAll('passages');
    for (const p of allPassages.filter(function(p) { return p.subject_id === subjectId; })) {
        await dbDelete('passages', p.id);
    }
    cachedQuestions = await dbGetAll('questions');
    cachedPassages = await dbGetAll('passages');
}

function recordsDiffer(a, b) {
    // Cheap-but-reliable equality check for plain JSON-ish records.
    return JSON.stringify(a) !== JSON.stringify(b);
}

// Make local storage for one subject exactly match `data` (the parsed
// contents of questions-<subjectId>.json): add new records, update changed
// ones, delete anything local that isn't in `data` anymore.
//
// Only applies delete-on-absence to questions/passages. Topics/
// topic_questions found in `data` are added/updated (for backward
// compatibility with subject files that do include them), but are never
// deleted just because they're missing from this particular file — see the
// note above the "PER-SUBJECT RECONCILE" header for why.
async function diffAndApplySubjectData(subjectId, data) {
    const counts = { added: 0, updated: 0, deleted: 0 };

    // ---- Questions ----
    const remoteQuestions = data.questions || [];
    const remoteQIds = new Set(remoteQuestions.map(function(q) { return q.id; }));
    const localQuestions = (await dbGetAll('questions')).filter(function(q) { return q.subject_id === subjectId; });
    for (const local of localQuestions) {
        if (!remoteQIds.has(local.id)) {
            await dbDelete('questions', local.id);
            counts.deleted++;
        }
    }
    for (const rq of remoteQuestions) {
        const existing = await dbGet('questions', rq.id);
        if (!existing) { await dbPut('questions', rq); counts.added++; }
        else if (recordsDiffer(existing, rq)) { await dbPut('questions', rq); counts.updated++; }
    }
    cachedQuestions = await dbGetAll('questions');

    // ---- Passages ----
    const remotePassages = data.passages || [];
    const remotePIds = new Set(remotePassages.map(function(p) { return p.id; }));
    const localPassages = (await dbGetAll('passages')).filter(function(p) { return p.subject_id === subjectId; });
    for (const local of localPassages) {
        if (!remotePIds.has(local.id)) {
            await dbDelete('passages', local.id);
            counts.deleted++;
        }
    }
    for (const rp of remotePassages) {
        const existing = await dbGet('passages', rp.id);
        if (!existing) { await dbPut('passages', rp); counts.added++; }
        else if (recordsDiffer(existing, rp)) { await dbPut('passages', rp); counts.updated++; }
    }
    cachedPassages = await dbGetAll('passages');

    // ---- Topics + Topic Questions ----
    // Add/update only from the file, if it happens to include them.
    // Never delete local topics/topic_questions based on this diff — they
    // are the admin's live Topic Practice data, not bulk-file data.
    const remoteTopics = data.topics || [];
    const remoteTopicQuestions = data.topic_questions || [];

    for (const rt of remoteTopics) {
        const existing = await dbGet('topics', rt.id);
        if (!existing) { await dbPut('topics', rt); counts.added++; }
        else if (recordsDiffer(existing, rt)) { await dbPut('topics', rt); counts.updated++; }
    }
    for (const rtq of remoteTopicQuestions) {
        const existing = await dbGet('topic_questions', rtq.id);
        if (!existing) { await dbPut('topic_questions', rtq); counts.added++; }
        else if (recordsDiffer(existing, rtq)) { await dbPut('topic_questions', rtq); counts.updated++; }
    }
    if (remoteTopics.length) cachedTopics = await dbGetAll('topics');
    if (remoteTopicQuestions.length) cachedTopicQuestions = await dbGetAll('topic_questions');

    return counts;
}

// Reconcile ONE subject against its file on the server.
// Returns one of:
//   { status: 'reconciled', counts }  — file existed, local question/passage
//                                        data now matches it exactly
//                                        (topics/topic_questions untouched)
//   { status: 'wiped' }               — file confirmed missing (404, or an
//                                        HTML/non-JSON fallback page some
//                                        hosts return instead of a real 404)
//                                        — subject's questions/passages
//                                        removed locally (topics/
//                                        topic_questions kept)
//   { status: 'offline' }             — couldn't reach the network at all — nothing touched
//   { status: 'error', code }         — some other problem — nothing touched, safer to retry later
async function reconcileSubjectFile(subjectId) {
    // Cache-busting query param: without this, some hosts (GitHub Pages via
    // Fastly, Netlify, Cloudflare, etc.) can keep serving a stale, already
    // *deleted* file from their CDN edge for several minutes after the
    // delete, regardless of the `cache: 'no-store'` fetch option below
    // (that option only bypasses the browser's own cache, not the CDN's).
    // A unique URL every time forces a real trip past the CDN to the origin.
    const bustedUrl = 'questions-' + subjectId + '.json?_=' + Date.now();

    let response;
    try {
        response = await fetch(bustedUrl, { cache: 'no-store' });
    } catch (e) {
        // No network reachable at all — never treat this as "the file was
        // deleted". Leave local data exactly as it is.
        return { status: 'offline' };
    }

    if (response.status === 404) {
        // The server has genuinely confirmed there's no file for this
        // subject — remove local questions/passages (topics/topic_questions
        // are untouched, see wipeSubjectData).
        await wipeSubjectData(subjectId);
        return { status: 'wiped' };
    }

    if (!response.ok) {
        // Some other HTTP error — ambiguous, could be a flaky server. Don't
        // destroy local data based on this; just try again next time.
        return { status: 'error', code: response.status };
    }

    // Some static hosts don't return a real 404 for a missing file — they
    // rewrite any unknown path to index.html and answer with 200 (common
    // "SPA fallback" behavior). If that's what came back, it's not real
    // question data, so treat it exactly like a confirmed-missing file.
    let rawText;
    try {
        rawText = await response.text();
    } catch (e) {
        return { status: 'error', code: 'unreadable' };
    }
    const trimmed = rawText.trim();
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const looksLikeHTML = trimmed.startsWith('<') || contentType.indexOf('html') !== -1;
    const looksLikeJSON = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (looksLikeHTML || !looksLikeJSON) {
        await wipeSubjectData(subjectId);
        return { status: 'wiped', reason: 'non-json-response' };
    }

    let data;
    try {
        data = JSON.parse(trimmed);
    } catch (e) {
        // Looked JSON-ish but didn't parse — can't be real question data
        // either, so treat the same way rather than leaving stale local
        // records behind forever.
        await wipeSubjectData(subjectId);
        return { status: 'wiped', reason: 'invalid-json' };
    }

    const counts = await diffAndApplySubjectData(subjectId, data);
    return { status: 'reconciled', counts };
}

// Reconcile every subject's file. This is what should run automatically
// every time the app opens: it keeps the offline DB in sync with GitHub —
// same questions are left alone, changed ones are updated, questions/
// passages removed on GitHub are deleted locally, and if there's no
// network at all, nothing is touched (existing offline data keeps working).
// Topic Practice data (topics/topic_questions) is never deleted by this.
async function reconcileAllSubjectFiles(subjectIds) {
    const results = {};
    let anyNetworkReached = false;
    for (const id of subjectIds) {
        const r = await reconcileSubjectFile(id);
        results[id] = r;
        if (r.status !== 'offline') anyNetworkReached = true;
    }
    results.__networkReached = anyNetworkReached;
    return results;
}

// ---- CACHE HELPERS ----

function getCachedQuestions() {
    return cachedQuestions;
}

function setCachedQuestions(questions) {
    cachedQuestions = questions;
}

// ---- MOCK EXAM — "USED QUESTION" TRACKING (offline, replaces Supabase
// mock_user_question_tracking) ----
// Keeps track, per user + subject, of which mock-type question ids have
// already been served to that user so Mock Arena doesn't repeat questions
// until the pool is exhausted, then it resets. Stored in the `settings`
// IndexedDB store (small, simple key/value data — no need for a dedicated
// object store or a DB_VERSION bump).

function mockTrackingKey(userId, subjectId) {
    return 'mock_used_' + userId + '_' + subjectId;
}

async function getUsedMockQuestionIdsOffline(userId, subjectId) {
    try {
        const row = await dbGet('settings', mockTrackingKey(userId, subjectId));
        return (row && Array.isArray(row.value)) ? row.value : [];
    } catch (e) {
        return [];
    }
}

async function addUsedMockQuestionIdsOffline(userId, subjectId, ids) {
    if (!ids || ids.length === 0) return;
    const existing = await getUsedMockQuestionIdsOffline(userId, subjectId);
    const merged = Array.from(new Set(existing.concat(ids)));
    await dbPut('settings', { key: mockTrackingKey(userId, subjectId), value: merged });
    return merged;
}

async function resetUsedMockQuestionIdsOffline(userId, subjectId) {
    await dbPut('settings', { key: mockTrackingKey(userId, subjectId), value: [] });
}

// ---- LEGACY COMPATIBILITY ----
// These functions match the Supabase function signatures for the patches

async function loadQuestionsOfflineCompat(type, subjectId, year, limit, batchNumber) {
    if (type === 'cbt') {
        return getQuestionsOffline(type, subjectId, year, limit);
    }
    if (type === 'NOVEL (CBT)') {
        const results = await getQuestionsOffline('NOVEL (CBT)', subjectId, year);
        return results;
    }
    return getQuestionsOffline(type, subjectId, year, limit);
}

async function loadAllQuestionsCountOffline() {
    const allQuestions = await dbGetAll('questions');
    const counts = {};
    allQuestions.forEach(function(q) {
        const key = q.type + ':' + q.subject_id;
        counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
}

async function getQuestionsForAdminOffline(type, subjectId, year) {
    return getQuestionsOffline(type, subjectId, year);
}

// ---- EXPOSE FUNCTIONS ----
window.OfflineDB = {
    // Questions
    addQuestionOffline,
    updateQuestionOffline,
    deleteQuestionOffline,
    getQuestionsOffline,
    getQuestionsByIdsOffline,
    loadQuestionsOffline,
    loadQuestionsOfflineCompat,
    loadAllQuestionsCountOffline,
    getQuestionsForAdminOffline,
    
    // Passages
    getPassageOffline,
    addPassageOffline,
    savePassageOffline,
    getPassageBatchesOffline,
    
    // Topics
    getTopicsOffline,
    addTopicOffline,
    deleteTopicOffline,
    
    // Topic Questions
    getTopicQuestionsOffline,
    addTopicQuestionOffline,
    updateTopicQuestionOffline,
    deleteTopicQuestionOffline,
    replaceTopicQuestionsOffline,
    
    // Bulk
    exportOfflineData,
    importOfflineData,
    seedOfflineDataIfNeeded,
    syncSubjectFile,
    syncAllSubjectFiles,
    exportSubjectData,
    forceSyncSubjectFile,

    // Reconcile (sync + delete) — use these for the "keep offline DB
    // exactly matching GitHub" behavior. Never deletes topics/topic_questions.
    reconcileSubjectFile,
    reconcileAllSubjectFiles,
    wipeSubjectData,

    // Mock Arena used-question tracking (offline replacement for the
    // Supabase mock_user_question_tracking table)
    getUsedMockQuestionIdsOffline,
    addUsedMockQuestionIdsOffline,
    resetUsedMockQuestionIdsOffline,
    
    // Cache
    getCachedQuestions,
    setCachedQuestions,
    isDBReady,
};

// Also expose individual functions globally for the patches
window.addQuestionOffline = addQuestionOffline;
window.updateQuestionOffline = updateQuestionOffline;
window.deleteQuestionOffline = deleteQuestionOffline;
window.addTopicOffline = addTopicOffline;
window.deleteTopicOffline = deleteTopicOffline;
window.addTopicQuestionOffline = addTopicQuestionOffline;
window.updateTopicQuestionOffline = updateTopicQuestionOffline;
window.deleteTopicQuestionOffline = deleteTopicQuestionOffline;
window.replaceTopicQuestionsOffline = replaceTopicQuestionsOffline;
window.exportOfflineData = exportOfflineData;
window.importOfflineData = importOfflineData;
window.seedOfflineDataIfNeeded = seedOfflineDataIfNeeded;
window.dbGetAll = dbGetAll;
window.dbGet = dbGet;
window.dbPut = dbPut;
window.dbDelete = dbDelete;
window.dbTransaction = dbTransaction;
window.dbIndexGetAll = dbIndexGetAll;
window.openDB = openDB;

console.log('Offline-DB.js loaded successfully!');