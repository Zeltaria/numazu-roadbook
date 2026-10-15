/* app.js — logique de l'application Roadbook Numazu.
 * Données injectées par data.js (window.NUMAZU_DATA) pour marcher en file://. */
(function () {
  "use strict";

  var DATA = window.NUMAZU_DATA || { meta: {}, places: [] };
  var PLACES = DATA.places || [];
  var Store = window.RBStore;

  var PRIORITY_ORDER = { "Très tôt": 0, "Tôt": 1, "À confirmer": 2, "Normal": 3, "Exclure": 9 };

  var state = { filter: "all", zone: "", sort: "route", q: "", lat: null, lon: null };

  var $ = function (s) { return document.querySelector(s); };
  var list = $("#list"), search = $("#search"), zoneSel = $("#zone"), sortSel = $("#sort");

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
    });
  }
  function oneLine(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 1400);
  }

  /* --- distance (haversine, km) --- */
  function km(aLat, aLon, bLat, bLon) {
    var R = 6371, rad = function (x) { return x * Math.PI / 180; };
    var dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function dist(p) {
    if (state.lat == null || p.latitude == null) return Infinity;
    return km(state.lat, state.lon, p.latitude, p.longitude);
  }

  /* --- où je suis : GPS quand le navigateur le permet (jamais dans l'artefact),
   * sinon Store.here = « 📍 Je suis ici » ou dernier tampon coché, au plus récent --- */
  var NO_POS = "Position inconnue : coche un tampon ou touche « 📍 Je suis ici » dans un lieu";
  function placeLabel(p) {
    return "#" + p.id + " " + (p.nameStatus !== "uncertain" && p.nameFr ? p.nameFr : oneLine(p.nameJa));
  }
  function here() {
    var h = Store.here(PLACES);
    if (!h) return null;
    var p = h.id != null ? PLACES.find(function (x) { return x.id === h.id; }) : null;
    var t = Store.jstParts(h.at);
    h.label = (p ? placeLabel(p) : "point GPS") +
      " (" + t.date.slice(8, 10) + "/" + t.date.slice(5, 7) + " " + t.time + ")";
    return h;
  }
  // Relevé GPS précis : done({lat, lon, acc}), enregistré comme ma position,
  // ou done(null) si le GPS est absent, refusé ou trop long (10 s).
  function gpsFix(done) {
    if (!navigator.geolocation) { done(null); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
      Store.setHere(fix);
      done(fix);
    }, function () { done(null); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }
  function locateMe(done) {
    if (navigator.geolocation) toast("Localisation…");
    gpsFix(function () { var h = here(); if (h) done(h); else toast(NO_POS); });
  }

  function needsCheck(p) {
    if (p.verificationStatus === "verified") return false;
    return p.hoursStatus !== "ok" || p.closedStatus === "partial" || p.priority === "À confirmer";
  }

  /* --- statut en direct selon l'heure de Numazu (JST = UTC+9) --- */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function jstNow() {
    var d = new Date();
    var total = d.getUTCHours() * 60 + d.getUTCMinutes() + 9 * 60;
    return { min: total % 1440, dow: (d.getUTCDay() + Math.floor(total / 1440)) % 7 };
  }
  function hm(m) { m = ((m % 1440) + 1440) % 1440; return Math.floor(m / 60) + " h" + (m % 60 ? " " + pad2(m % 60) : ""); }

  function liveStatus(p) {
    if (p.ended) return { state: "ended" };
    var jn = jstNow();
    if (p.closedDays && p.closedDays.indexOf(jn.dow) >= 0)
      return { state: "closed", label: "Fermé aujourd'hui", cls: "st-closed" };
    var iv = p.openIntervals || [];
    if (!iv.length) return { state: "unknown" };
    for (var i = 0; i < iv.length; i++) {
      var s = iv[i][0], e = iv[i][1];
      var eff = (e > 1440 && jn.min < 300) ? jn.min + 1440 : jn.min; // plage après minuit
      if (eff >= s && eff < e) {
        var left = e - eff;
        if (left <= 45) return { state: "soon", label: "Ferme bientôt (" + hm(e) + ")", cls: "st-soon" };
        return { state: "open", label: "Ouvert", cls: "st-open" };
      }
    }
    if (p.openingMinutes != null && jn.min < p.openingMinutes)
      return { state: "before", label: "Ouvre à " + hm(p.openingMinutes), cls: "st-before" };
    return { state: "closed", label: "Fermé", cls: "st-closed" };
  }

  // met à jour les badges de statut sans re-render complet (toutes les minutes)
  function refreshLive() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-live]"), function (el) {
      var p = PLACES.find(function (x) { return x.id === +el.dataset.live; });
      if (!p) return;
      var ls = liveStatus(p);
      if (ls.label) { el.textContent = ls.label; el.className = "badge live " + ls.cls; el.style.display = ""; }
      else { el.style.display = "none"; }
    });
    var nb = document.getElementById("nowJst");
    if (nb) { var jn = jstNow(); nb.textContent = "🕐 Heure de Numazu : " + pad2(Math.floor(jn.min / 60)) + " h " + pad2(jn.min % 60); }
  }

  /* --- filtres --- */
  function matchFilter(p) {
    switch (state.filter) {
      case "todo": return !p.ended && !Store.isDone(p.id);
      case "done": return Store.isDone(p.id);
      case "fav": return Store.isFav(p.id);
      case "early": return !p.ended && (p.priority === "Très tôt" || p.priority === "Tôt");
      case "open": { var s = liveStatus(p).state; return s === "open" || s === "soon"; }
      case "active": return !p.ended;
      case "ended": return p.ended;
      default: return true;
    }
  }

  function filtered() {
    var q = state.q.toLowerCase();
    var arr = PLACES.filter(function (p) {
      if (!matchFilter(p)) return false;
      if (state.zone && p.zone !== state.zone) return false;
      if (q) {
        var idm = q.match(/^#?(\d+)$/);
        if (idm) {
          if (String(p.id) !== idm[1]) return false; // recherche par identifiant (ex. « 63 » ou « #63 »)
        } else {
          var hay = [p.nameJa, p.nameFr, p.nameRomaji, p.member, p.memberFr, p.zoneFr,
            p.addressJa, p.categoryFr, p.hoursRaw].join(" ").toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
      }
      return true;
    });
    sortArr(arr);
    return arr;
  }

  function sortArr(arr) {
    var s = state.sort;
    arr.sort(function (a, b) {
      switch (s) {
        case "distance": return dist(a) - dist(b);
        case "nameFr": return (a.nameFr || "").localeCompare(b.nameFr || "", "fr");
        case "nameJa": return (a.nameJa || "").localeCompare(b.nameJa || "", "ja");
        case "hours":
          return (a.closingMinutes == null ? 1e9 : a.closingMinutes) -
                 (b.closingMinutes == null ? 1e9 : b.closingMinutes);
        case "priority":
          return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
                 a.zoneOrder - b.zoneOrder || a.id - b.id;
        case "zone": return a.zoneOrder - b.zoneOrder || a.id - b.id;
        default: /* route conseillé */
          return a.zoneOrder - b.zoneOrder ||
                 PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.id - b.id;
      }
    });
  }

  /* --- badges --- */
  function priorityBadge(p) {
    if (p.ended) return '<span class="badge ended"><span class="dot"></span>Terminé / fermé</span>';
    var cls = p.priority === "Très tôt" ? "veryearly" : p.priority === "Tôt" ? "early" :
      p.priority === "À confirmer" ? "confirm" : "ok";
    return '<span class="badge ' + cls + '"><span class="dot"></span>' + escapeHtml(p.priority) + "</span>";
  }

  /* --- carte liste --- */
  // {date:"2026-10-12", time:"14:30"} -> "12/10 · 14:30"
  function visitLabel(vp) {
    var d = vp.date.split("-");
    return d[2] + "/" + d[1] + " · " + vp.time;
  }

  function cardHtml(p) {
    var done = Store.isDone(p.id), fav = Store.isFav(p.id);
    var visit = done ? Store.visitParts(p.id) : null;
    var ls = liveStatus(p);
    var km = (state.lat != null && p.latitude != null && isFinite(dist(p)))
      ? " · " + dist(p).toFixed(1) + " km" : "";
    var frCls = p.nameStatus === "uncertain" ? "title-fr uncertain" : "title-fr";
    var frText = p.nameStatus === "uncertain"
      ? (p.nameRomaji ? p.nameRomaji + " (translit. à vérifier)" : "translittération à vérifier")
      : p.nameFr;
    return '' +
      '<div class="card-top">' +
        '<input class="check" type="checkbox" ' + (done ? "checked" : "") +
          ' aria-label="Marquer comme fait" data-id="' + p.id + '">' +
        '<div style="flex:1;min-width:0" data-open="' + p.id + '">' +
          '<div class="title-ja">' + escapeHtml(oneLine(p.nameJa)) + "</div>" +
          '<div class="' + frCls + '">' + escapeHtml(frText) + "</div>" +
          '<div class="meta">#' + p.id + " · " + escapeHtml(p.categoryFr) + " · " + escapeHtml(p.zoneFr) + km + "</div>" +
        "</div>" +
        (p.latitude != null ? '<button class="card-map" data-map="' + p.id + '" title="Voir sur la carte" aria-label="Voir sur la carte">🗺️</button>' : "") +
      "</div>" +
      '<div class="badges" data-open="' + p.id + '">' +
        (ls.label
          ? '<span class="badge live ' + ls.cls + '" data-live="' + p.id + '">' + escapeHtml(ls.label) + "</span>"
          : '<span class="badge live" data-live="' + p.id + '" style="display:none"></span>') +
        (visit ? '<span class="badge visited">✓ Visité le ' + escapeHtml(visitLabel(visit)) + "</span>" : "") +
        (p.memberFr ? '<span class="badge member">★ ' + escapeHtml(p.memberFr) + "</span>" : "") +
        priorityBadge(p) +
        (fav ? '<span class="badge fav">Favori</span>' : "") +
        (p.verificationStatus === "verified"
          ? '<span class="badge ok">✓ Vérifié</span>'
          : (needsCheck(p) && !p.ended ? '<span class="badge confirm">À vérifier</span>' : "")) +
      "</div>" +
      '<div class="summary" data-open="' + p.id + '"><b>Horaires :</b> ' + escapeHtml(p.hoursFr) +
        " · <b>Fermeture :</b> " + escapeHtml(oneLine(p.closedFr)) + "</div>";
  }

  function render() {
    var pos = here();
    state.lat = pos ? pos.lat : null;
    state.lon = pos ? pos.lon : null;
    var arr = filtered();
    updateProgress();
    refreshPlanChecks();
    var total = PLACES.length;
    $("#countLine").textContent = arr.length + " lieu" + (arr.length > 1 ? "x" : "") +
      " affiché" + (arr.length > 1 ? "s" : "") + " sur " + total +
      (pos ? " · distances depuis " + pos.label : "");
    if (!arr.length) {
      list.innerHTML = '<div class="empty">Aucun lieu ne correspond aux filtres.</div>';
      refreshLive();
      return;
    }
    var frag = document.createDocumentFragment();
    arr.forEach(function (p) {
      var el = document.createElement("article");
      el.className = "card" + (Store.isDone(p.id) ? " is-done" : "") + (p.ended ? " is-ended" : "");
      el.innerHTML = cardHtml(p);
      frag.appendChild(el);
    });
    list.innerHTML = "";
    list.appendChild(frag);
    refreshLive();
  }

  function updateProgress() {
    var st = Store.stats(PLACES);
    $("#progress").style.width = st.pct + "%";
    $("#progressLabel").textContent = st.done + " / " + st.active + " tampons actifs · " + st.pct + " %";
  }

  /* --- fiche détail --- */
  function field(label, jaHtml, valHtml) {
    var out = '<div class="field"><div class="field-label">' + escapeHtml(label) + "</div>";
    if (jaHtml) out += '<div class="ja">' + jaHtml + "</div>";
    if (valHtml) out += '<div class="val">' + valHtml + "</div>";
    return out + "</div>";
  }

  // Date de passage : proposée seulement une fois le tampon marqué comme fait,
  // horodatée automatiquement à la coche et corrigeable à la main.
  function visitField(p) {
    if (!Store.isDone(p.id)) return "";
    var vp = Store.visitParts(p.id) || { date: "", time: "" };
    return '<div class="field"><div class="field-label">Date de passage (heure de Numazu)</div>' +
      '<div class="visit-fields">' +
        '<input type="date" data-visit-date="' + p.id + '" value="' + vp.date + '" aria-label="Date de passage">' +
        '<input type="time" data-visit-time="' + p.id + '" value="' + vp.time + '" aria-label="Heure de passage">' +
      "</div></div>";
  }

  function openDetail(p) {
    var dlg = $("#detail");
    var romaji = p.nameRomaji && p.nameStatus !== "ok"
      ? '<div class="val muted">Translittération : ' + escapeHtml(p.nameRomaji) + " (à vérifier)</div>"
      : (p.nameRomaji ? '<div class="val muted">Translittération : ' + escapeHtml(p.nameRomaji) + "</div>" : "");
    var frName = p.nameStatus === "uncertain"
      ? '<span class="uncertain" style="font-style:italic">' + escapeHtml(p.nameRomaji || p.nameFr) + " — à vérifier</span>"
      : escapeHtml(p.nameFr);

    var verified = p.verificationStatus === "verified";
    var hoursLabel = verified ? ("Horaires — vérifiés le " + (p.lastVerified || "")) : "Horaires (source KML)";
    var hoursJa = escapeHtml((p.hoursRawVerified || p.hoursRaw) || "non indiqués");
    var verifBanner = verified
      ? '<div class="verif ok">✓ Horaires vérifiés le ' + escapeHtml(p.lastVerified || "") +
        (p.verifSource ? " · source : " + escapeHtml(p.verifSource) : "") + "." +
        (p.verifNote ? " " + escapeHtml(p.verifNote) : "") + "</div>"
      : '<div class="verif">⚠︎ ' + escapeHtml(DATA.meta.hoursDisclaimerFr || "Horaires à vérifier.") +
        (p.ended ? " Ce lieu est marqué fermé / terminé dans la source." : "") + "</div>";

    var html =
      '<div class="sheet-grab"></div><button class="close-x" data-close="1" aria-label="Fermer">×</button>' +
      '<div style="position:relative">' +
        "<h2>" + escapeHtml(oneLine(p.nameJa)) + "</h2>" +
        '<div class="fr">' + frName + "</div>" +
        romaji +
        '<div class="meta" style="margin-top:6px">' + escapeHtml(p.categoryFr) + " · " + escapeHtml(p.zoneFr) +
          (p.memberFr ? " · ★ " + escapeHtml(p.memberFr) : "") + "</div>" +
        '<div class="badges" style="margin-top:8px">' + priorityBadge(p) + "</div>" +
      "</div>" +
      field(p.moved ? "Adresse (nouvelle)" : "Adresse (japonais)",
            escapeHtml((p.moved && p.newAddressJa ? p.newAddressJa : p.addressJa) || "—"),
            (p.moved && p.oldAddressJa
              ? '<span class="muted">Ancienne : ' + escapeHtml(p.oldAddressJa) + "</span>"
              : (p.addressFr ? '<span class="muted">' + escapeHtml(p.addressFr) + "</span>" : ""))) +
      field(hoursLabel, hoursJa, "<b>" + escapeHtml(p.hoursFr) + "</b>") +
      field("Fermeture (source KML)", escapeHtml(p.closedRaw || "non indiquée"),
            escapeHtml(p.closedFr)) +
      (p.member ? field("Personnage (tampon)", escapeHtml(p.member),
            escapeHtml(p.memberFr || "")) : "") +
      verifBanner +
      (p.statusNote ? '<div class="verif" style="color:var(--violet);background:var(--violet-soft)">ℹ︎ ' +
        escapeHtml(p.statusNote) + (p.statusSource ? " — " + escapeHtml(p.statusSource) : "") + "</div>" : "") +
      visitField(p) +
      '<div class="field"><div class="field-label">Note personnelle</div>' +
        '<textarea class="note" data-note="' + p.id + '" placeholder="Ajouter une note…">' +
          escapeHtml(Store.getNote(p.id)) + "</textarea></div>" +
      '<div class="sheet-actions">' +
        '<button class="btn accent" data-done="' + p.id + '">' +
          (Store.isDone(p.id) ? "✓ Tampon obtenu" : "Marquer comme fait") + "</button>" +
        '<button class="btn" data-fav="' + p.id + '">' +
          (Store.isFav(p.id) ? "★ Favori" : "☆ Favori") + "</button>" +
        (p.latitude != null ? '<button class="btn" data-showmap="' + p.id + '">🗺️ Voir sur la carte</button>' +
          '<button class="btn" data-here="' + p.id + '">📍 Je suis ici</button>' : "") +
        (p.links.googleMaps ? '<a class="btn" target="_blank" rel="noopener" href="' +
          p.links.googleMaps + '">Ouvrir dans Google Maps</a>' : "") +
        '<button class="btn" data-copy-coord="' + p.latitude + "," + p.longitude + '">Copier les coordonnées</button>' +
        '<button class="btn wide" data-copy-text="addr:' + p.id + '">Copier l\'adresse japonaise</button>' +
      "</div>";

    $("#detailBody").innerHTML = html;
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }

  /* --- délégation d'événements --- */
  function showOnMap(p) {
    if (!window.RBMap) { toast("Carte indisponible"); return; }
    // la carte n'est pas un dialogue : un parcours ouvert (fiche ouverte depuis
    // l'itinéraire) resterait par-dessus
    if ($("#planner").open) $("#planner").close();
    var arr = filtered();
    if (!arr.some(function (x) { return x.id === p.id; })) arr = arr.concat([p]);
    window.RBMap.focus(arr, p.id);
    var h = here(); if (h) window.RBMap.showYou(h.lat, h.lon, h.label, false);
  }

  // « 📍 Je suis ici » (détail d'un lieu ou bulle de la carte) : ce lieu devient
  // ma position, et la liste se trie autour.
  function imHere(id) {
    var p = PLACES.find(function (x) { return x.id === id; });
    if (!p || p.latitude == null) return;
    Store.setHere({ lat: p.latitude, lon: p.longitude, id: p.id });
    state.sort = "distance"; sortSel.value = "distance"; render();
    if (window.RBMap) window.RBMap.showYou(p.latitude, p.longitude, here().label, false);
    toast("Position : " + placeLabel(p) + " — liste triée par distance");
  }

  list.addEventListener("change", function (e) {
    var cb = e.target.closest(".check");
    if (cb) { Store.toggleDone(+cb.dataset.id); render(); }
  });
  list.addEventListener("click", function (e) {
    var mp = e.target.closest("[data-map]");
    if (mp) {
      var pm = PLACES.find(function (x) { return x.id === +mp.dataset.map; });
      if (pm) showOnMap(pm);
      return;
    }
    var op = e.target.closest("[data-open]");
    if (op && !e.target.closest(".check")) {
      var p = PLACES.find(function (x) { return x.id === +op.dataset.open; });
      if (p) openDetail(p);
    }
  });

  var detail = $("#detail");
  detail.addEventListener("click", function (e) {
    if (e.target.dataset.close || e.target === detail) { detail.close(); return; }
    var d;
    if ((d = e.target.closest("[data-done]"))) {
      Store.toggleDone(+d.dataset.done);
      var p = PLACES.find(function (x) { return x.id === +d.dataset.done; });
      openDetail(p); render(); if (window.RBMap) window.RBMap.refresh();
    } else if ((d = e.target.closest("[data-fav]"))) {
      Store.toggleFav(+d.dataset.fav);
      openDetail(PLACES.find(function (x) { return x.id === +d.dataset.fav; })); render();
    } else if ((d = e.target.closest("[data-showmap]"))) {
      var pm = PLACES.find(function (x) { return x.id === +d.dataset.showmap; });
      detail.close();
      if (pm) showOnMap(pm);
    } else if ((d = e.target.closest("[data-here]"))) {
      detail.close();
      imHere(+d.dataset.here);
    } else if ((d = e.target.closest("[data-copy-coord]"))) {
      copy(d.dataset.copyCoord, "Coordonnées copiées");
    } else if ((d = e.target.closest("[data-copy-text]"))) {
      var id = +d.dataset.copyText.split(":")[1];
      var pl = PLACES.find(function (x) { return x.id === id; });
      copy(pl.addressJa, "Adresse copiée");
    }
  });
  detail.addEventListener("input", function (e) {
    if (e.target.dataset.note) { Store.setNote(+e.target.dataset.note, e.target.value); return; }
    var vid = e.target.dataset.visitDate || e.target.dataset.visitTime;
    if (!vid) return;
    var id = +vid;
    var dEl = detail.querySelector('[data-visit-date="' + id + '"]');
    var tEl = detail.querySelector('[data-visit-time="' + id + '"]');
    // Date vidée = passage sans date ; heure vidée = minuit à Numazu.
    if (dEl && dEl.value) Store.setVisitParts(id, dEl.value, (tEl && tEl.value) || "00:00");
    else Store.setVisitedAt(id, "");
    render();
  });

  function copy(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); },
        function () { toast("Copie impossible"); });
    } else { toast("Copie non disponible"); }
  }

  /* --- contrôles --- */
  search.addEventListener("input", function () { state.q = search.value.trim(); render(); });
  zoneSel.addEventListener("change", function () { state.zone = zoneSel.value; render(); });
  sortSel.addEventListener("change", function () { state.sort = sortSel.value; render(); });

  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (c) {
    c.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (x) { x.classList.remove("active"); });
      c.classList.add("active"); state.filter = c.dataset.filter; render();
    });
  });

  $("#locate").addEventListener("click", function () {
    locateMe(function (h) {
      state.sort = "distance"; sortSel.value = "distance"; render();
      toast("Trié autour de " + h.label);
    });
  });

  /* résumé */
  $("#statsBtn").addEventListener("click", function () {
    var active = PLACES.filter(function (p) { return !p.ended; });
    var done = active.filter(function (p) { return Store.isDone(p.id); }).length;
    var byZone = {};
    active.forEach(function (p) {
      byZone[p.zoneFr] = byZone[p.zoneFr] || { all: 0, done: 0, order: p.zoneOrder };
      byZone[p.zoneFr].all++; if (Store.isDone(p.id)) byZone[p.zoneFr].done++;
    });
    var rows = Object.keys(byZone).sort(function (a, b) { return byZone[a].order - byZone[b].order; })
      .map(function (z) { return "<p><b>" + escapeHtml(z) + "</b> : " + byZone[z].done + " / " + byZone[z].all + "</p>"; }).join("");
    var fav = PLACES.filter(function (p) { return Store.isFav(p.id); }).length;
    $("#statsBody").innerHTML =
      "<p style='font-size:15px'><b>" + done + " / " + active.length + "</b> tampons actifs récupérés · " +
        Math.round(active.length ? done / active.length * 100 : 0) + " %</p>" +
      "<p class='meta'>Favoris : " + fav + " · Total dans la base : " + PLACES.length +
        " (dont " + DATA.meta.ended + " fermés/terminés)</p>" + rows;
    $("#stats").showModal();
  });

  /* données : export / import / reset / thème */
  $("#dataBtn").addEventListener("click", function () { $("#dataDlg").showModal(); });
  // Résultat d'un export : dans l'artefact, le lecteur demande confirmation et
  // refuse .gpx et .kml ; ailleurs, le téléchargement part directement.
  function saved(promise, okMsg) {
    promise.then(function () { toast(okMsg); }, function (e) {
      var code = e && e.code;
      toast(code === "declined" ? "Export annulé"
        : code === "rejected_extension" ? "Format refusé dans l'artefact : JSON et CSV seulement"
        : "Export impossible ici");
    });
  }
  $("#exportBtn").addEventListener("click", function () {
    if (!window.RBExport) { toast("Export indisponible"); return; }
    saved(window.RBExport.save("roadbook-numazu-sauvegarde.json", Store.exportJson(), "application/json"),
      "Sauvegarde exportée");
  });
  $("#importFile").addEventListener("change", function (e) {
    var f = e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try { Store.importJson(r.result); render(); toast("Progression importée"); $("#dataDlg").close(); }
      catch (err) { toast("Fichier invalide"); }
    };
    r.readAsText(f);
  });
  $("#resetBtn").addEventListener("click", function () {
    if (confirm("Effacer toute la progression locale ? (les favoris et notes seront perdus)")) {
      Store.reset(); render(); $("#dataDlg").close(); toast("Progression réinitialisée");
    }
  });

  function exportPlaces(fmt) {
    if (!window.RBExport) { toast("Export indisponible"); return; }
    var arr = filtered();
    if (!arr.length) { toast("Aucun lieu à exporter"); return; }
    saved(window.RBExport.downloadPlaces(arr, fmt), arr.length + " lieu(x) exporté(s) — " + fmt.toUpperCase());
  }
  $("#expGpx").addEventListener("click", function () { exportPlaces("gpx"); });
  $("#expKml").addEventListener("click", function () { exportPlaces("kml"); });
  $("#expCsv").addEventListener("click", function () { exportPlaces("csv"); });

  /* thème clair/sombre */
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }
  applyTheme(Store.getSetting("theme", "auto"));
  $("#themeBtn").addEventListener("click", function () {
    var cur = Store.getSetting("theme", "auto");
    var next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
    Store.setSetting("theme", next); applyTheme(next);
    toast("Thème : " + (next === "auto" ? "automatique" : next === "light" ? "clair" : "sombre"));
  });

  /* ---- planificateur de parcours ---- */
  var planTransport = "car";
  var lastPlan = null;
  function fmtHM(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  $("#planBtn").addEventListener("click", function () { $("#planner").showModal(); });
  function setTransport(t) {
    planTransport = t;
    Array.prototype.forEach.call($("#planTransport").querySelectorAll(".seg-btn"), function (x) {
      x.classList.toggle("active", x.dataset.t === t);
    });
  }
  $("#planTransport").addEventListener("click", function (e) {
    var b = e.target.closest(".seg-btn"); if (!b) return;
    setTransport(b.dataset.t);
    saveTrip();
  });

  // Le séjour saisi est mémorisé (et inclus dans la sauvegarde JSON) : rien à
  // retaper à chaque ouverture. Sans rien d'enregistré, le formulaire garde ses
  // valeurs par défaut (le séjour prévu, dans index.html).
  var TRIP_FIELDS = ["planDate", "planArriveTime", "planLeaveDate", "planLeaveTime",
                     "planStart", "planDays", "planVisit", "planUseLoc", "planIncludeDone"];
  function saveTrip() {
    var t = { transport: planTransport };
    TRIP_FIELDS.forEach(function (id) {
      var el = $("#" + id); t[id] = el.type === "checkbox" ? el.checked : el.value;
    });
    Store.setSetting("trip", t);
    showTrip();
  }
  function restoreTrip() {
    var t = Store.getSetting("trip", null);
    if (!t) return;
    TRIP_FIELDS.forEach(function (id) {
      if (!(id in t)) return;
      var el = $("#" + id);
      if (el.type === "checkbox") el.checked = !!t[id]; else el.value = t[id];
    });
    if (t.transport) setTransport(t.transport);
  }
  // Bandeau d'en-tête : rappelle le séjour mémorisé.
  function showTrip() {
    var a = $("#planDate").value, b = $("#planLeaveDate").value;
    var dm = function (iso) { return iso.slice(8, 10) + "/" + iso.slice(5, 7); };
    var at = function (id) { return $("#" + id).value ? " à " + $("#" + id).value : ""; };
    $("#notice").textContent = "⚠︎ Horaires issus du KML — à vérifier sur une source officielle avant le voyage. " +
      (a && b ? "Séjour : du " + dm(a) + at("planArriveTime") + " au " + dm(b) + at("planLeaveTime") +
                (planTransport === "car" ? ", en voiture" : ", sans voiture") +
                " — la liste ne masque aucun lieu ; le planificateur applique les fermetures de ces jours."
              : "Dates du séjour non renseignées : aucun lieu n'est masqué automatiquement.");
  }
  $("#planner .plan-form").addEventListener("change", saveTrip);
  // Pendant le séjour : l'arrivée devient « maintenant » (heure de Numazu), pour
  // replanifier la suite ; les tampons déjà cochés sont exclus du calcul.
  $("#planNow").addEventListener("click", function () {
    var n = Store.jstParts();
    $("#planDate").value = n.date;
    $("#planArriveTime").value = n.time;
    updatePlanSpan();
    saveTrip();
    toast("Arrivée réglée sur maintenant : " + n.date.slice(8, 10) + "/" + n.date.slice(5, 7) + " à " + n.time);
  });
  // Point de départ du parcours. « Partir de ma position » : le GPS, relevé au
  // moment du calcul. Sans GPS (refusé, artefact…), la dernière position connue
  // (« 📍 Je suis ici » ou dernier tampon coché), en le disant. À plus de
  // FAR_KM de Numazu (dans le train, encore en France…), départ de la gare.
  // done(start, label, live) : start = {lat, lon}, ou null pour la gare ;
  // live = les liens Google Maps partent de la position réelle du téléphone.
  var FAR_KM = 50;
  function planStart(done) {
    if (!$("#planUseLoc").checked) { done(null, "gare de Numazu", false); return; }
    $("#planResults").innerHTML = '<p class="plan-note">📍 Localisation…</p>';
    gpsFix(function (fix) {
      if (fix) render(); // distances de la liste depuis ce nouveau point
      var pos = fix || here();
      if (!pos) { toast(NO_POS); done(null, "gare de Numazu", false); return; }
      var st = window.RoutePlanner.STATION, d = km(pos.lat, pos.lon, st.lat, st.lon);
      if (d > FAR_KM) { done(null, "gare de Numazu (ta position est à " + Math.round(d) + " km)", false); return; }
      done({ lat: pos.lat, lon: pos.lon }, fix
        ? "ta position GPS (±" + Math.round(fix.acc) + " m)"
        : "GPS indisponible, dernière position connue : " + pos.label, true);
    });
  }

  $("#planGo").addEventListener("click", function () {
    if (!window.RoutePlanner) { toast("Moteur d'itinéraire indisponible"); return; }
    var params = {
      transport: planTransport,
      startTime: $("#planStart").value || "08:00",
      days: +$("#planDays").value || 2,
      visitMinutes: Math.max(1, +$("#planVisit").value || 5),
      arriveDate: $("#planDate").value || null,
      arriveTime: $("#planArriveTime").value || null,
      leaveDate: $("#planLeaveDate").value || null,
      leaveTime: $("#planLeaveTime").value || null,
      includeDone: $("#planIncludeDone").checked
    };
    var btn = this;
    btn.disabled = true;
    planStart(function (start, startLabel, live) {
      if (start) params.start = start;
      params.liveStart = live;
      // Le moteur compare plusieurs variantes (~1 s sur téléphone) : on affiche
      // d'abord un message, puis on calcule une fois l'écran redessiné.
      $("#planResults").innerHTML = '<p class="plan-note">⏳ Calcul du parcours…</p>';
      setTimeout(function () {
        var r = window.RoutePlanner.plan(PLACES, params, function (id) { return Store.isDone(id); });
        btn.disabled = false;
        if (r.error) {
          lastPlan = null;
          $("#planResults").innerHTML = '<div class="notice" style="margin:12px 0 0">⚠︎ ' +
            escapeHtml(r.error) + "</div>";
          toast(r.error);
          return;
        }
        lastPlan = r;
        $("#planResults").innerHTML = renderPlan(r, startLabel);
        refreshPlanChecks();
      }, 30);
    });
  });

  // Durée du séjour déduite des deux dates ; « nombre de jours » n'est
  // qu'un repli quand elles ne sont pas renseignées.
  function updatePlanSpan() {
    var a = $("#planDate").value, b = $("#planLeaveDate").value;
    var sel = $("#planDays"), span = $("#planSpan");
    if (a && b) {
      var n = Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000) + 1;
      sel.disabled = true;
      span.textContent = n > 0
        ? "Séjour : " + n + " jour" + (n > 1 ? "s" : "") + " (déduit des dates)"
        : "Le départ est avant l'arrivée";
    } else {
      sel.disabled = false;
      span.textContent = (a || b) ? "Séjour : renseigne les deux dates"
                                  : "Séjour : dates non renseignées";
    }
  }
  ["#planDate", "#planLeaveDate"].forEach(function (sel) {
    $(sel).addEventListener("change", updatePlanSpan);
  });
  restoreTrip();
  updatePlanSpan();
  showTrip();
  $("#planResults").addEventListener("click", function (e) {
    if (e.target.closest("#planExport") && lastPlan && window.RBExport) {
      saved(window.RBExport.downloadRoute(lastPlan), "Parcours GPX exporté");
      return;
    }
    var op = e.target.closest("[data-plan-open]");
    if (op) {
      var p = PLACES.find(function (x) { return x.id === +op.dataset.planOpen; });
      if (p) openDetail(p);
    }
  });
  // Cocher un arrêt = tampon obtenu, comme dans la liste. Le parcours garde son
  // ordre : pour recalculer la suite, « Générer le parcours » à nouveau.
  $("#planResults").addEventListener("change", function (e) {
    var cb = e.target.closest("[data-plan-done]");
    if (cb) { Store.setDone(+cb.dataset.planDone, cb.checked); render(); }
  });
  // Cases de l'itinéraire alignées sur la progression (cochée ici, dans la liste,
  // la fiche ou la carte) et compteur « N ✓ » de chaque journée.
  function refreshPlanChecks() {
    Array.prototype.forEach.call(document.querySelectorAll("#planResults .plan-day"), function (day) {
      var n = 0;
      Array.prototype.forEach.call(day.querySelectorAll("[data-plan-done]"), function (cb) {
        var done = Store.isDone(+cb.dataset.planDone);
        cb.checked = done;
        cb.closest(".stop").classList.toggle("is-done", done);
        if (done) n++;
      });
      var c = day.querySelector("[data-day-done]");
      if (c) c.textContent = n ? " · " + n + " ✓" : "";
    });
  }

  function renderPlan(r, startLabel) {
    function periode() {
      var pa = r.params, at = pa.arriveTime ? " à " + pa.arriveTime : "";
      var lt = pa.leaveTime ? " à " + pa.leaveTime : "";
      var first = r.days[0].dateLabel, last = r.days[r.days.length - 1].dateLabel;
      if (r.days.length === 1) return "le " + first + at + (lt ? ", départ" + lt : "");
      return "arrivée " + first + at + " → départ " + last + lt;
    }
    var html = '<div class="plan-note"><b>' + r.summary.planned + "</b> lieux planifiés sur " +
      r.summary.candidates + " retenus · " + (r.summary.generic ? "mode générique (aucune date)" :
      escapeHtml(periode()) + " · fermetures hebdomadaires appliquées jour par jour") +
      ". Point de départ : " + escapeHtml(startLabel) + ".</div>";
    // "26:00" = 2 h du matin (notation japonaise reprise du KML).
    function hm(t) { var a = String(t).split(":"); return (+a[0]) * 60 + (+a[1]); }
    function duree(d) {
      var n = hm(d.endTime) - hm(d.startTime);
      var m = n % 60;
      return n <= 0 ? "" : Math.floor(n / 60) + " h" + (m ? " " + (m < 10 ? "0" + m : m) : "");
    }
    var apresMinuit = r.days.some(function (d) { return d.endTime >= "24:00"; });

    r.days.forEach(function (d) {
      var longue = hm(d.endTime) - hm(d.startTime) > 12 * 60;
      html += '<div class="plan-day"><div class="plan-day-head"><div>Jour ' + d.day +
        (d.dateLabel ? " — " + escapeHtml(d.dateLabel) : "") +
        ' <span class="sub">' + d.stops.length + " arrêt" + (d.stops.length > 1 ? "s" : "") +
        "<span data-day-done></span> · " + d.startTime + "→" + d.endTime +
        (longue ? " · ⚠︎ journée de " + duree(d) : "") + "</span></div>" +
        (d.gmaps ? '<a target="_blank" rel="noopener" href="' + d.gmaps + '">Itinéraire ↗</a>' : "") + "</div>";
      if (!d.stops.length) html += '<div class="stop"><div class="body"><div class="sub">Aucun lieu ce jour.</div></div></div>';
      d.stops.forEach(function (s) {
        if (s.isMeal) html += '<div class="lunch">🍜 Déjeuner ici (tampon + repas)</div>';
        else if (s.lunchBefore) html += '<div class="lunch">🍜 Pause déjeuner</div>';
        var closeTxt = s.closeMin != null ? "ferme " + fmtHM(s.closeMin) : "";
        var tight = s.marginMin != null && s.marginMin <= 25;
        var fr = s.nameStatus === "uncertain" ? "" : (s.nameFr || "");
        html += '<div class="stop">' +
          '<input class="check" type="checkbox" data-plan-done="' + s.id + '" aria-label="Tampon obtenu : #' + s.id + '">' +
          '<div class="t">' + s.arrive + '</div><div class="body" data-plan-open="' + s.id + '">' +
          '<div class="n">#' + s.id + " " + escapeHtml(oneLine(s.nameJa)) +
          (fr ? ' <span class="fr">' + escapeHtml(fr) + "</span>" : "") + "</div>" +
          '<div class="sub">' + escapeHtml(s.zoneFr) + (s.member ? " · ★ " + escapeHtml(s.member) : "") +
          (s.hard ? " · ⚠︎ difficile sans voiture" : "") + "</div></div>" +
          (closeTxt ? '<div class="m' + (tight ? " tight" : "") + '">' + closeTxt + "</div>" : "") + "</div>";
      });
      html += "</div>";
    });
    if (r.excluded.length) {
      var byReason = {};
      r.excluded.forEach(function (e) { (byReason[e.reason] = byReason[e.reason] || []).push(e); });
      html += '<details class="plan-excl"><summary>Non retenus (' + r.excluded.length + ")</summary>";
      Object.keys(byReason).forEach(function (reason) {
        html += '<div class="er"><b>' + escapeHtml(reason) + "</b> (" + byReason[reason].length + ") : " +
          byReason[reason].map(function (e) { return "#" + e.id + " " + escapeHtml(oneLine(e.nameJa)); }).join(", ") + "</div>";
      });
      html += "</details>";
    }
    html += '<button class="btn wide" id="planExport" style="margin-top:10px">⬇︎ Exporter le parcours (GPX)</button>';
    html += '<div class="plan-note">Estimations indicatives (temps de trajet à vol d\'oiseau ajusté). ' +
      "Vérifie les horaires avant de partir ; en centre-ville, prévois du temps pour le stationnement." +
      (r.summary.generic ? "" : " Seules les fermetures hebdomadaires sont connues par jour : " +
        "les horaires d'ouverture des données ne distinguent pas les jours de la semaine.") +
      " Les soirées ne contiennent que des lieux dont l'horaire est connu — jamais de supposition." +
      (apresMinuit ? " Les heures au-delà de 24:00 suivent la notation japonaise du KML " +
        "(24:00 = minuit, 26:00 = 2 h du matin)." : "") + "</div>";
    return html;
  }

  /* ---- carte ---- */
  if (window.RBMap) {
    $("#mapBtn").addEventListener("click", function () {
      window.RBMap.open(filtered());
      var h = here(); if (h) window.RBMap.showYou(h.lat, h.lon, h.label, false);
    });
    $("#mapClose").addEventListener("click", function () { window.RBMap.close(); });
    $("#mapLocate").addEventListener("click", function () {
      locateMe(function (h) { window.RBMap.showYou(h.lat, h.lon, h.label, true); toast("Ma position : " + h.label); });
    });
    document.addEventListener("rb:here", function (e) { imHere(e.detail); });
    $("#mapFit").addEventListener("click", function () { window.RBMap.fit(); });
    $("#mapManholes").addEventListener("click", function () {
      var on = window.RBMap.toggleManholes();
      this.classList.toggle("mh-on", on);
      toast(on ? "Plaques Aqours affichées (emplacements à reconfirmer)" : "Plaques masquées");
    });
    document.addEventListener("rb:progress", function () { render(); });
    document.addEventListener("rb:open-detail", function (e) {
      var p = PLACES.find(function (x) { return x.id === e.detail; });
      if (p) openDetail(p);
    });
  } else {
    var _mb = $("#mapBtn");
    if (_mb) _mb.addEventListener("click", function () { toast("Carte indisponible (Leaflet non chargé)"); });
  }

  /* fermeture des dialogues au clic sur le fond */
  ["stats", "dataDlg", "planner"].forEach(function (id) {
    var d = document.getElementById(id);
    d.addEventListener("click", function (e) { if (e.target === d) d.close(); });
  });

  render();
  setInterval(refreshLive, 60000); // maj des statuts ouvert/fermé chaque minute
})();
