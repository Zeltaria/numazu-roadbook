/* storage.js — progression locale (checklist, favoris, notes, visites).
 * Conserve TOUT dans localStorage. Prévoit export / import / réinitialisation
 * (roadbook §9 : ne jamais dépendre uniquement du stockage navigateur). */
(function (global) {
  "use strict";
  var KEY = "numazu_roadbook_v1";

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return { progress: {}, settings: {} };
      var obj = JSON.parse(raw);
      obj.progress = obj.progress || {};
      obj.settings = obj.settings || {};
      return obj;
    } catch (e) {
      return { progress: {}, settings: {} };
    }
  }

  var state = load();

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function entry(id) {
    if (!state.progress[id]) state.progress[id] = {};
    return state.progress[id];
  }

  /* Dates de passage : stockées en ISO UTC, saisies et affichées à l'heure
   * de Numazu (UTC+9 toute l'année) — sinon un tampon pris à 14 h là-bas
   * s'afficherait au 12 octobre 07:30 depuis la France. */
  var JST_OFFSET = 9 * 60;
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function toJstParts(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var j = new Date(d.getTime() + JST_OFFSET * 60000);
    return {
      date: j.getUTCFullYear() + "-" + pad2(j.getUTCMonth() + 1) + "-" + pad2(j.getUTCDate()),
      time: pad2(j.getUTCHours()) + ":" + pad2(j.getUTCMinutes())
    };
  }

  function fromJstParts(date, time) {
    var d = String(date || "").split("-"), t = String(time || "00:00").split(":");
    if (d.length !== 3) return "";
    var ms = Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0] || 0, +t[1] || 0) - JST_OFFSET * 60000;
    return isNaN(ms) ? "" : new Date(ms).toISOString();
  }

  var Store = {
    get: function (id) { return state.progress[id] || {}; },

    isDone: function (id) { return !!(state.progress[id] && state.progress[id].done); },
    isFav: function (id) { return !!(state.progress[id] && state.progress[id].favorite); },

    setDone: function (id, val) {
      var e = entry(id);
      if (val) {
        e.done = true;
        e.visited = true;
        if (!e.visitedAt) e.visitedAt = new Date().toISOString(); // ne pas écraser une date corrigée
        delete e.ended; delete e.endedAt; // obtenu : il n'est donc pas terminé
      } else {
        delete e.done;
        delete e.visited;
        delete e.visitedAt; // pas de date de passage sans passage
      }
      persist();
    },
    toggleDone: function (id) { this.setDone(id, !this.isDone(id)); },

    /* Tampon signalé « terminé » sur place (magasin fermé, tampon retiré…) :
     * il sort des tampons actifs et des parcours, comme ceux que la liste
     * officielle donne terminés. */
    isEnded: function (id) { return !!(state.progress[id] && state.progress[id].ended); },
    endedAt: function (id) { return (state.progress[id] && state.progress[id].endedAt) || ""; },
    setEnded: function (id, val) {
      var e = entry(id);
      if (val) { e.ended = true; e.endedAt = new Date().toISOString(); }
      else { delete e.ended; delete e.endedAt; }
      persist();
    },

    getVisitedAt: function (id) {
      return (state.progress[id] && state.progress[id].visitedAt) || "";
    },
    setVisitedAt: function (id, iso) {
      var e = entry(id);
      if (iso) e.visitedAt = iso; else delete e.visitedAt;
      persist();
    },
    /* {date:"2026-10-12", time:"14:30"} à l'heure de Numazu, ou null. */
    visitParts: function (id) {
      var iso = Store.getVisitedAt(id);
      return iso ? toJstParts(iso) : null;
    },
    setVisitParts: function (id, date, time) {
      Store.setVisitedAt(id, fromJstParts(date, time));
    },
    /* Date et heure de Numazu d'un instant ISO (maintenant par défaut). */
    jstParts: function (iso) { return toJstParts(iso || new Date().toISOString()); },

    /* Où je suis — le GPS est refusé dans l'artefact : la position est la plus
     * récente entre la dernière enregistrée (point GPS, ou « Je suis ici » sur
     * un lieu) et le dernier tampon coché. {lat, lon, at, id?} ou null. */
    setHere: function (pos) {
      Store.setSetting("here", { lat: pos.lat, lon: pos.lon, id: pos.id, at: new Date().toISOString() });
    },
    here: function (places) {
      var best = Store.getSetting("here", null);
      (places || []).forEach(function (p) {
        var at = p.latitude != null && Store.isDone(p.id) && Store.getVisitedAt(p.id);
        if (at && (!best || at > best.at)) best = { lat: p.latitude, lon: p.longitude, at: at, id: p.id };
      });
      return best;
    },

    setFav: function (id, val) {
      var e = entry(id);
      if (val) e.favorite = true; else delete e.favorite;
      persist();
    },
    toggleFav: function (id) { this.setFav(id, !this.isFav(id)); },

    setNote: function (id, text) {
      var e = entry(id);
      if (text && text.trim()) e.note = text.trim(); else delete e.note;
      persist();
    },
    getNote: function (id) { return (state.progress[id] && state.progress[id].note) || ""; },

    getSetting: function (k, def) {
      return state.settings[k] === undefined ? def : state.settings[k];
    },
    setSetting: function (k, v) { state.settings[k] = v; persist(); },

    stats: function (places) {
      var active = places.filter(function (p) { return !p.ended; });
      var done = active.filter(function (p) { return Store.isDone(p.id); }).length;
      return { active: active.length, done: done,
               pct: active.length ? Math.round(done / active.length * 100) : 0 };
    },

    exportJson: function () {
      return JSON.stringify({ app: "numazu-roadbook", version: 1,
        exportedAt: new Date().toISOString(), data: state }, null, 2);
    },
    importJson: function (text) {
      var obj = JSON.parse(text);
      var incoming = obj && obj.data ? obj.data : obj;
      if (!incoming || typeof incoming !== "object") throw new Error("Format invalide");
      state.progress = incoming.progress || {};
      state.settings = incoming.settings || {};
      persist();
    },
    reset: function () { state = { progress: {}, settings: {} }; persist(); }
  };

  global.RBStore = Store;
})(window);
