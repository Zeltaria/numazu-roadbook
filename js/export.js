/* export.js — export des lieux et du parcours (roadbook §20).
 * Formats : CSV (tableur), GPX (GPS / rando), KML (Google Earth / My Maps).
 * Tout est généré côté client, hors-ligne. Conserve le japonais (UTF-8). */
window.RBExport = (function () {
  "use strict";

  function oneLine(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function xml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c];
    });
  }
  /* Dans l'artefact, le lecteur bloque <a download> : on passe par la capacité
   * « downloads » (il demande confirmation ; .json et .csv acceptés, pas .gpx ni
   * .kml → rejet « rejected_extension »). Ailleurs : lien classique. Promesse. */
  var dlReady = window.claude && window.claude.use
    ? window.claude.use("downloads") : Promise.resolve(null);
  function download(filename, text, mime) {
    return dlReady.then(function (dl) {
      if (dl) return dl.save({ filename: filename, data: text });
      var blob = new Blob([text], { type: mime + ";charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    });
  }

  function withCoords(places) {
    return (places || []).filter(function (p) { return p.latitude != null; });
  }
  function desc(p) {
    return [p.nameFr, p.categoryFr, p.zoneFr, p.hoursFr, oneLine(p.closedFr),
            p.verificationStatus === "verified" ? "(horaires vérifiés)" : ""]
      .filter(Boolean).join(" · ");
  }

  function toCSV(places) {
    var head = ["id", "nom_ja", "nom_fr", "categorie", "zone", "latitude", "longitude",
      "horaires_fr", "fermeture_fr", "personnage", "priorite", "statut_donnees", "google_maps"];
    var rows = (places || []).map(function (p) {
      return [p.id, oneLine(p.nameJa), p.nameFr, p.categoryFr, p.zoneFr, p.latitude, p.longitude,
        p.hoursFr, oneLine(p.closedFr), p.memberFr || p.member || "", p.priority,
        p.verificationStatus, (p.links && p.links.googleMaps) || ""];
    });
    var body = [head].concat(rows).map(function (r) {
      return r.map(function (v) {
        v = String(v == null ? "" : v);
        return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(",");
    }).join("\r\n");
    return "﻿" + body; // BOM : ouverture correcte du japonais dans Excel
  }

  function toGPX(places, title) {
    var w = withCoords(places).map(function (p) {
      return '  <wpt lat="' + p.latitude + '" lon="' + p.longitude + '">\n' +
        "    <name>" + xml(oneLine(p.nameJa)) + "</name>\n" +
        "    <desc>" + xml(desc(p)) + "</desc>\n  </wpt>";
    }).join("\n");
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Roadbook Numazu" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      "  <metadata><name>" + xml(title || "Roadbook Numazu") + "</name></metadata>\n" +
      w + "\n</gpx>\n";
  }

  function toKML(places, title) {
    var pm = withCoords(places).map(function (p) {
      return "    <Placemark>\n      <name>" + xml(oneLine(p.nameJa)) + "</name>\n" +
        "      <description>" + xml(desc(p)) + "</description>\n" +
        "      <Point><coordinates>" + p.longitude + "," + p.latitude + ",0</coordinates></Point>\n    </Placemark>";
    }).join("\n");
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>' +
      xml(title || "Roadbook Numazu") + "</name>\n" + pm + "\n  </Document>\n</kml>\n";
  }

  function routeToGPX(plan) {
    var rtes = (plan.days || []).map(function (d) {
      var pts = d.stops.map(function (s) {
        return '    <rtept lat="' + s.lat + '" lon="' + s.lon + '">' +
          "<name>" + xml((s.arrive ? s.arrive + " " : "") + oneLine(s.nameJa)) + "</name></rtept>";
      }).join("\n");
      return "  <rte>\n    <name>Jour " + d.day + (d.date ? " - " + d.date : "") +
        " (" + d.stops.length + " arrets)</name>\n" + pts + "\n  </rte>";
    }).join("\n");
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Roadbook Numazu" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      "  <metadata><name>Parcours Roadbook Numazu</name></metadata>\n" + rtes + "\n</gpx>\n";
  }

  return {
    downloadPlaces: function (places, fmt) {
      var base = "roadbook-numazu";
      if (fmt === "csv") return download(base + ".csv", toCSV(places), "text/csv");
      if (fmt === "gpx") return download(base + ".gpx", toGPX(places), "application/gpx+xml");
      return download(base + ".kml", toKML(places), "application/vnd.google-earth.kml+xml");
    },
    downloadRoute: function (plan) {
      return download("parcours-numazu.gpx", routeToGPX(plan), "application/gpx+xml");
    },
    save: download
  };
})();
