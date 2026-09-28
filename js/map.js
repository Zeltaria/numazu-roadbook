/* map.js — carte Leaflet en superposition (roadbook §8.4).
 * Marqueurs colorés par statut, popups bilingues, géolocalisation.
 * L'app reste utilisable sans la carte. Fond : tuiles OSM embarquées autour des
 * lieux (tiles/), sinon serveur OSM en ligne ; là où rien ne charge (artefact,
 * hors-ligne), les points restent positionnés sur fond neutre.
 *
 * Dépend de Leaflet (window.L) et de window.RBStore. Communique avec l'app via
 * des CustomEvent : "rb:progress" (une case a changé) et "rb:open-detail" (id).
 */
window.RBMap = (function () {
  "use strict";
  var map = null, tiles = null, markers = {}, current = [];
  var Store = window.RBStore;

  function color(p, done) {
    if (done) return "#2f9e5f";                                   // vert : fait
    if (p.ended) return "#8a939c";                                // gris : terminé/fermé
    if (p.priority === "Très tôt" || p.priority === "Tôt") return "#e08a2a"; // orange : ferme tôt
    return "#d84b4b";                                             // rouge : à faire
  }
  function icon(c, sel) {
    return L.divIcon({
      className: "rb-pin", iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10],
      html: '<span style="display:block;width:16px;height:16px;border-radius:50%;background:' + c +
        ";border:2px solid " + (sel ? "#2d6ea3" : "#fff") +
        ';box-shadow:0 0 0 1px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.45)"></span>'
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
    });
  }
  function oneLine(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  function popupHtml(p) {
    var done = Store.isDone(p.id);
    var fr = p.nameStatus === "uncertain" ? "" : (p.nameFr || "");
    return '<div class="rb-pop">' +
      '<div class="rb-pop-ja">' + esc(oneLine(p.nameJa)) + "</div>" +
      (fr ? '<div class="rb-pop-fr">' + esc(fr) + "</div>" : "") +
      '<div class="rb-pop-sub">' + esc(p.categoryFr) + " · " + esc(p.zoneFr) +
        (p.member ? " · ★ " + esc(p.memberFr || p.member) : "") + "</div>" +
      '<div class="rb-pop-sub">' + esc(p.hoursFr) + "</div>" +
      (p.moved ? '<div class="rb-pop-sub" style="color:#8a5cc0">↔ Lieu déménagé' +
        (p.coordsApprox ? " (nouvelle position approximative)" : "") + "</div>" : "") +
      '<div class="rb-pop-act">' +
        '<button class="rb-pop-btn" data-map-done="' + p.id + '">' + (done ? "✓ Fait" : "Marquer fait") + "</button>" +
        '<button class="rb-pop-btn" data-map-detail="' + p.id + '">Détails</button>' +
        '<button class="rb-pop-btn" data-map-here="' + p.id + '">📍 Je suis ici</button>' +
        (p.moved && p.oldLatitude != null ? '<button class="rb-pop-btn" data-map-old="' + p.id + '">↔ Ancien emplacement</button>' : "") +
        (p.links && p.links.googleMaps ? '<a class="rb-pop-btn" target="_blank" rel="noopener" href="' + p.links.googleMaps + '">Maps ↗</a>' : "") +
      "</div></div>";
  }

  /* Tuiles publiées avec l'app en paquets JSON de 4 × 4 (scripts/fetch_tiles.py) :
   * seule source possible dans l'artefact, dont le CSP bloque tout serveur externe.
   * Style allemand d'OSM : noms en japonais + lettres latines. Tuile absente d'un
   * paquet → même serveur en ligne. */
  var PACK_SHIFT = 2, packs = {};
  function pack(c) {
    var k = c.z + "-" + (c.x >> PACK_SHIFT) + "-" + (c.y >> PACK_SHIFT);
    return packs[k] || (packs[k] = fetch("tiles/" + k + ".json")
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; }));
  }
  function packLayer() {
    var Layer = L.GridLayer.extend({
      createTile: function (c, done) {
        var img = document.createElement("img");
        img.alt = "";
        img.onload = function () { done(null, img); };
        img.onerror = function () { done(new Error("tuile " + c.z + "/" + c.x + "/" + c.y), img); };
        pack(c).then(function (p) {
          var b = p[c.x + "/" + c.y];
          img.src = b ? "data:image/png;base64," + b
            : "https://tile.openstreetmap.de/" + c.z + "/" + c.x + "/" + c.y + ".png";
        });
        return img;
      }
    });
    // rien d'embarqué au-delà du zoom 16 : Leaflet l'agrandit
    return new Layer({ maxZoom: 19, maxNativeZoom: 16, attribution: "© OpenStreetMap · tuiles openstreetmap.de" });
  }

  function ensureMap() {
    if (map) return;
    map = L.map("rbmap", { zoomControl: true, attributionControl: true }).setView([35.06, 138.86], 11);
    tiles = packLayer();
    // message visible tant que la vue courante a un trou (zone non embarquée)
    var note = document.getElementById("rbmapNote");
    tiles.on("loading", function () { if (note) note.style.display = "none"; });
    tiles.on("tileerror", function () { if (note) note.style.display = "block"; });
    tiles.addTo(map);

    // délégation : boutons dans les popups
    map.getContainer().addEventListener("click", function (e) {
      var b = e.target.closest("[data-map-done]");
      if (b) {
        var id = +b.dataset.mapDone;
        Store.toggleDone(id);
        var p = markers[id] && markers[id]._p;
        if (p && markers[id]) markers[id].setIcon(icon(color(p, Store.isDone(id)), false));
        b.textContent = Store.isDone(id) ? "✓ Fait" : "Marquer fait";
        document.dispatchEvent(new CustomEvent("rb:progress"));
        return;
      }
      var d = e.target.closest("[data-map-detail]");
      if (d) {
        document.dispatchEvent(new CustomEvent("rb:open-detail", { detail: +d.dataset.mapDetail }));
        return;
      }
      var hr = e.target.closest("[data-map-here]");
      if (hr) {
        document.dispatchEvent(new CustomEvent("rb:here", { detail: +hr.dataset.mapHere }));
        return;
      }
      var o = e.target.closest("[data-map-old]");
      if (o) {
        var mk = markers[+o.dataset.mapOld];
        if (mk && mk._p) showAlt(mk._p);
      }
    });
  }

  function render(places, fit) {
    current = places || [];
    Object.keys(markers).forEach(function (id) { map.removeLayer(markers[id]); });
    markers = {};
    if (altMarker) { map.removeLayer(altMarker); altMarker = null; }
    var pts = [];
    current.forEach(function (p) {
      if (p.latitude == null) return;
      var m = L.marker([p.latitude, p.longitude], { icon: icon(color(p, Store.isDone(p.id)), false) });
      m._p = p;
      m.bindPopup(popupHtml(p), { closeButton: true });
      m.on("popupopen", function () { m.setPopupContent(popupHtml(p)); });
      m.addTo(map);
      markers[p.id] = m;
      pts.push([p.latitude, p.longitude]);
    });
    var c = document.getElementById("mapCount");
    if (c) c.textContent = pts.length + " point" + (pts.length > 1 ? "s" : "");
    if (fit && pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  }

  // Ma position, fournie par app.js (GPS, « Je suis ici » ou dernier tampon coché)
  var youMarker = null;
  function showYou(lat, lon, label, center) {
    if (!map) return;
    if (youMarker) map.removeLayer(youMarker);
    youMarker = L.circleMarker([lat, lon], { radius: 8, color: "#2d6ea3", fillColor: "#2d6ea3", fillOpacity: .9, weight: 3 })
      .addTo(map).bindPopup('<div class="rb-pop"><div class="rb-pop-sub">📍 Ma position : ' + esc(label) + "</div></div>");
    if (center) map.setView([lat, lon], 15);
  }

  // ---- repli sur l'ancien emplacement (lieux déménagés) ----
  var altMarker = null;
  function showAlt(p) {
    if (altMarker) map.removeLayer(altMarker);
    altMarker = L.marker([p.oldLatitude, p.oldLongitude], { icon: icon("#8a5cc0", true) })
      .addTo(map)
      .bindPopup('<div class="rb-pop"><div class="rb-pop-ja">↔ Ancien emplacement</div>' +
        '<div class="rb-pop-sub">' + esc(oneLine(p.nameJa)) + "</div>" +
        (p.oldAddressJa ? '<div class="rb-pop-sub">' + esc(oneLine(p.oldAddressJa)) + "</div>" : "") +
        '<div class="rb-pop-sub" style="color:#8a5cc0">Reviens sur le marqueur principal pour le nouvel emplacement.</div></div>')
      .openPopup();
    map.setView([p.oldLatitude, p.oldLongitude], 16);
  }

  // ---- plaques d'égout Aqours (calque optionnel) ----
  var mhMarkers = [], mhShown = false;
  function mhIcon() {
    return L.divIcon({
      className: "rb-mh", iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12],
      html: '<span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px;' +
        "border-radius:50%;background:#c74a8b;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)," +
        '0 1px 4px rgba(0,0,0,.5);color:#fff;font-size:13px;font-weight:700">♪</span>'
    });
  }
  function mhPopup(v, note) {
    var mem = v.members.map(function (m) { return esc(m.fr) + " (" + esc(m.ja) + ")"; }).join("<br>");
    return '<div class="rb-pop"><div class="rb-pop-ja">🎵 Plaques Aqours — ' + esc(v.year) + "</div>" +
      '<div class="rb-pop-fr">' + esc(v.nameFr) + "</div>" +
      '<div class="rb-pop-sub">' + esc(v.nameJa) + " · " + esc(v.hoursFr) + "</div>" +
      '<div class="rb-pop-sub" style="margin-top:5px">' + mem + "</div>" +
      '<div class="rb-pop-sub" style="margin-top:6px;color:#b23">⚠︎ ' + esc(note || "Emplacements susceptibles de changer.") + "</div>" +
      '<div class="rb-pop-act"><a class="rb-pop-btn" target="_blank" rel="noopener" href="' +
      "https://www.google.com/maps/search/?api=1&query=" + v.latitude + "," + v.longitude + '">Maps ↗</a></div></div>';
  }
  function toggleManholes() {
    var data = (window.NUMAZU_DATA && window.NUMAZU_DATA.manholes) || {};
    var venues = data.venues || [];
    if (!venues.length) return false;
    if (mhShown) {
      mhMarkers.forEach(function (m) { map.removeLayer(m); });
      mhMarkers = []; mhShown = false; return false;
    }
    venues.forEach(function (v) {
      var m = L.marker([v.latitude, v.longitude], { icon: mhIcon(), zIndexOffset: 1000 });
      m.bindPopup(mhPopup(v, data.rotationNote));
      m.addTo(map); mhMarkers.push(m);
    });
    mhShown = true;
    return true;
  }

  return {
    open: function (places) {
      var ov = document.getElementById("mapOverlay");
      ov.hidden = false;
      ensureMap();
      setTimeout(function () { map.invalidateSize(); render(places, true); }, 60);
    },
    // ouvre la carte centrée sur un point précis, popup ouvert
    focus: function (places, targetId) {
      document.getElementById("mapOverlay").hidden = false;
      ensureMap();
      setTimeout(function () {
        map.invalidateSize();
        render(places, false);
        var m = markers[targetId];
        if (m) { map.setView(m.getLatLng(), 16); m.openPopup(); }
        else { map.setView([35.10, 138.86], 12); }
      }, 60);
    },
    toggleManholes: toggleManholes,
    close: function () { document.getElementById("mapOverlay").hidden = true; },
    refresh: function () {
      if (map && !document.getElementById("mapOverlay").hidden) render(current, false);
    },
    showYou: showYou,
    fit: function () {
      var pts = current.filter(function (p) { return p.latitude != null; })
        .map(function (p) { return [p.latitude, p.longitude]; });
      if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    }
  };
})();
