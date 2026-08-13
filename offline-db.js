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
        const allTopics = await dbGetAll('topics');
        const subjectTopics = allTopics.filter(function(t) { return t.subject_id === subjectId; });
        const allTQs = await dbGetAll('topic_questions');
        for (const t of subjectTopics) {
            for (const tq of allTQs.filter(function(tq) { return tq.topic_id === t.id; })) {
                await dbDelete('topic_questions', tq.id);
            }
            await dbDelete('topics', t.id);
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


// ---- CACHE HELPERS ----

function getCachedQuestions() {
    return cachedQuestions;
}

function setCachedQuestions(questions) {
    cachedQuestions = questions;
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
    loadQuestionsOffline,
    loadQuestionsOfflineCompat,
    loadAllQuestionsCountOffline,
    getQuestionsForAdminOffline,
    
    // Passages
    getPassageOffline,
    addPassageOffline,
    
    // Topics
    getTopicsOffline,
    addTopicOffline,
    deleteTopicOffline,
    
    // Topic Questions
    getTopicQuestionsOffline,
    addTopicQuestionOffline,
    updateTopicQuestionOffline,
    deleteTopicQuestionOffline,
    
    // Bulk
    exportOfflineData,
    importOfflineData,
    seedOfflineDataIfNeeded,
    syncSubjectFile,
    syncAllSubjectFiles,
    exportSubjectData,
    forceSyncSubjectFile,
    
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