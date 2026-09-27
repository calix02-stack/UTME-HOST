// offline-db-boost.js — loads right after offline-db.js (no edits to that file needed)
// 1) Warms the in-memory caches so the first Topic Practice / question load is instant.
// 2) Makes the question-file syncs fail instantly when offline and never hang on a dead connection.
(function () {
    // --- 2) fast-fail / time-limited fetch for questions-*.json syncs ---
    var realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/questions(-[^/]*)?\.json/.test(url)) {
            if (navigator.onLine === false) return Promise.reject(new TypeError('offline'));
            if (typeof AbortController !== 'undefined') {
                var ctrl = new AbortController();
                var t = setTimeout(function () { ctrl.abort(); }, 8000);
                var opts = Object.assign({}, init || {}, { signal: ctrl.signal });
                return realFetch(input, opts).finally(function () { clearTimeout(t); });
            }
        }
        return realFetch(input, init);
    };

    // --- 1) warm caches (reads only; fills the module's internal caches) ---
    function warm() {
        var o = window.OfflineDB;
        if (!o) return;
        Promise.resolve()
            .then(function () { return o.getTopicsOffline('__warm__'); })
            .then(function () { return o.getTopicQuestionsOffline('__warm__'); })
            .then(function () { return o.getPassageBatchesOffline('__warm__', 'cbt'); })
            .then(function () { return o.getQuestionsOffline('cbt', '__warm__'); })
            .catch(function () {});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', warm);
    else warm();
})();
