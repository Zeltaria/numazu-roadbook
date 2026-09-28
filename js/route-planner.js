/* route-planner.js — moteur de parcours (roadbook §11 et §12).
 * Logique pure, hors-ligne, sans dépendance. Heuristique (pas d'optimum
 * exact) : filtrer les lieux atteignables/ouverts, suivre un corridor par
 * zones, choisir à chaque étape le lieu le plus proche (un lieu qui ferme
 * bientôt vaut un détour), ne pas revenir dans une zone quittée, puis
 * retoucher chaque journée (déplacer / inverser des arrêts, retour à la base
 * compris) et remplir le temps gagné, en gardant une marge avant fermeture.
 *
 * plan(places, params, isDone) -> { params, days:[...], excluded:[...], summary }
 */
window.RoutePlanner = (function () {
  "use strict";

  // Point de départ par défaut : gare de Numazu (sortie sud).
  var STATION = { lat: 35.1027, lon: 138.8596 };

  // Profils de déplacement : vitesse effective (km/h), facteur de détour
  // (route vs vol d'oiseau), plage horaire de journée, pause déjeuner.
  var PROFILES = {
    car:     { speed: 28, detour: 1.35, dayStart: "08:00", dayEnd: "18:30", lunch: 45, gmaps: "driving" },
    transit: { speed: 11, detour: 1.25, dayStart: "08:30", dayEnd: "18:00", lunch: 40, gmaps: "transit" }
  };

  // Sans voiture, ces zones sont très difficiles (bus rares / très éloignées).
  var HARD_WITHOUT_CAR = { heda_west: true, nishiura: true };

  var DAYNAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  var MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin",
                "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  var MARGIN = 10;    // minutes de marge avant la fermeture
  var MAX_DAYS = 14;  // garde-fou si les deux dates sont très éloignées

  // Écho des paramètres du séjour, renvoyé aussi bien en succès qu'en erreur.
  function tripParams(params, days, dates) {
    var prof = PROFILES[params.transport] || PROFILES.car;
    var arrive = params.arriveDate || params.date || null;
    return {
      transport: params.transport || "car", days: days,
      visitMinutes: params.visitMinutes || 5,
      startTime: params.startTime || prof.dayStart,
      date: arrive, arriveDate: arrive, arriveTime: params.arriveTime || null,
      leaveDate: params.leaveDate || null, leaveTime: params.leaveTime || null,
      dates: dates || []
    };
  }

  // Date d'arrivée + n jours -> date ISO, jour de la semaine et libellé FR.
  // Calcul en UTC : une date seule ne doit pas glisser selon le fuseau.
  function isoDay(iso, n) {
    var a = iso.split("-");
    var d = new Date(Date.UTC(+a[0], +a[1] - 1, +a[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return { iso: d.toISOString().slice(0, 10), weekday: d.getUTCDay(),
             label: DAYNAMES[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] };
  }

  function toMin(hhmm) { var a = hhmm.split(":"); return +a[0] * 60 + +a[1]; }
  function fmt(min) {
    min = Math.round(min);
    var h = Math.floor(min / 60), m = min % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  function haversine(a, b) {
    var R = 6371, rad = function (x) { return x * Math.PI / 180; };
    var dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Baie de Suruga : entre la côte ouest d'Izu (Ōsezaki, Heda, Nishiura) et le
  // reste de Numazu, la route fait le tour par Uchiura — jamais de ligne
  // droite sur l'eau (Ōsezaki–gare : ~11 km à vol d'oiseau, ~25 km de route).
  var BAY_GATE = { lat: 35.027, lon: 138.893 };
  function westIzu(p) { return p.lat < 35.035 && p.lon < 138.87; }
  function roadKm(a, b) {
    return westIzu(a) === westIzu(b) ? haversine(a, b) : haversine(a, BAY_GATE) + haversine(BAY_GATE, b);
  }

  // Nombre de jours entre deux dates ISO (null si illisibles).
  function daysBetween(a, b) {
    var x = a.split("-"), y = b.split("-");
    if (x.length !== 3 || y.length !== 3) return null;
    var ms = Date.UTC(+y[0], +y[1] - 1, +y[2]) - Date.UTC(+x[0], +x[1] - 1, +x[2]);
    return isNaN(ms) ? null : Math.round(ms / 86400000);
  }

  // Plusieurs variantes, on garde celle qui place le plus de tampons, puis le
  // moins de trajet (jamais pire qu'une stratégie seule) :
  //  - en voiture sur plusieurs jours, le grand tour de l'ouest (Heda, Nishiura)
  //    le jour 1, 2, 3 ou 4 — sinon un lieu de ville ouvert seulement le jour 1
  //    est sacrifié ;
  //  - corridor strict, ou « souple » (petits détours pour un lieu qui va fermer,
  //    courte attente avant de quitter une zone) : chacune gagne selon le séjour.
  function plan(allPlaces, params, isDone) {
    var car = (params && params.transport) !== "transit";
    var anyWest = allPlaces.some(function (p) { return !p.ended && HARD_WITHOUT_CAR[p.zone]; });
    var best = null;
    [false, true].forEach(function (flex) {
      var first = planOnce(allPlaces, params, isDone, car ? 1 : null, flex);
      keep(first);
      if (!car || !anyWest || first.error || first.days.length < 2) return;
      first.days.forEach(function (d, i) {
        // une journée qui commence l'après-midi ou finit avant 14 h ne peut pas porter le grand tour
        if (i === 0 || i > 3 || d.startTime >= "12:00" || d.closeTime < "14:00") return;
        keep(planOnce(allPlaces, params, isDone, i + 1, flex));
      });
    });
    return best;
    function keep(r) {
      if (!best || r.summary.planned > best.summary.planned ||
          (r.summary.planned === best.summary.planned && r.summary.travelMin < best.summary.travelMin)) best = r;
    }
  }

  function planOnce(allPlaces, params, isDone, westDay, flex) {
    params = params || {};

    // Séjour incohérent : on le dit, plutôt que de rendre un parcours bancal.
    function failed(msg, arrDate) {
      return { error: msg, params: tripParams(params, 0), days: [], excluded: [],
               summary: { candidates: 0, planned: 0, excluded: 0, generic: !arrDate } };
    }

    var prof = PROFILES[params.transport] || PROFILES.car;
    var visit = params.visitMinutes || 5;
    var start = params.start || STATION;
    var dayStart = toMin(params.startTime || prof.dayStart);
    // Fin « normale » : passé cette heure on ne place plus que des lieux dont
    // les horaires sont connus (jamais de devinette en soirée).
    var normalEnd = toMin(prof.dayEnd);
    var dayEnd = normalEnd;

    // Fenêtre de séjour : j'arrive tel jour à telle heure, je pars tel jour à
    // telle heure. Sans dates, on retombe sur « N jours » (mode générique).
    var arriveDate = params.arriveDate || params.date || null;
    var leaveDate = params.leaveDate || null;
    var days;
    if (arriveDate && leaveDate) {
      var span = daysBetween(arriveDate, leaveDate);
      if (span == null) return failed("Dates de séjour illisibles.", arriveDate);
      if (span < 0) return failed("La date de départ est avant la date d'arrivée.", arriveDate);
      days = Math.min(MAX_DAYS, span + 1);
    } else {
      days = Math.max(1, Math.min(4, params.days || 2));
    }

    // Un jour du séjour = une vraie date (fermetures hebdomadaires appliquées
    // jour par jour) et sa propre fenêtre horaire.
    var schedule = [];
    for (var i = 0; i < days; i++) {
      var info = arriveDate ? isoDay(arriveDate, i) : { iso: null, weekday: null, label: null };
      info.start = (i === 0 && params.arriveTime) ? toMin(params.arriveTime) : dayStart;
      info.end = (i === days - 1 && params.leaveTime) ? toMin(params.leaveTime) : dayEnd;
      schedule.push(info);
    }
    // Seule une heure de départ explicite peut être « avant l'arrivée » : la
    // fin de journée du profil, elle, sera étirée par la soirée plus bas.
    if (days === 1 && params.leaveTime && schedule[0].end <= schedule[0].start)
      return failed("L'heure de départ est avant l'heure d'arrivée.", arriveDate);
    function closedOn(p, wd) {
      return wd != null && p.closedDays && p.closedDays.indexOf(wd) >= 0;
    }

    function travelMin(a, b) { return roadKm(a, b) * prof.detour / prof.speed * 60; }
    function P(p) { return { lat: p.latitude, lon: p.longitude }; }

    // --- déjeuner : on cale la pause sur un restaurant quand c'est possible ---
    var LUNCH_AT = 12 * 60 + 30;                  // pause déclenchée à partir de 12 h 30
    var MEAL_CATS = { restaurant: 1, sushi: 1, cafe: 1, bakery: 1 };
    var MEAL_DETOUR_KM = 4;                        // resto retenu seulement s'il est proche
    var meal = prof.lunch;                         // durée d'un arrêt-repas (= tampon + repas)
    // « meal » curé par lieu (café sans cuisine, pâtisserie…) prime sur la catégorie
    function isMeal(p) { return p.meal != null ? !!p.meal : !!MEAL_CATS[p.category]; }

    /* Ouvert de bout en bout pour une visite de `dur` minutes ?
     * true = oui, false = non, null = horaires inconnus. Les plages priment
     * sur l'heure de fermeture seule : un lieu ouvert 10-13 h puis 17-22 h
     * est fermé à 14 h, même si « il ferme à 22 h ». */
    function openAt(p, t, dur) {
      var iv = p.openIntervals || [];
      if (iv.length) {
        for (var i = 0; i < iv.length; i++) {
          if (t >= iv[i][0] && t + dur <= iv[i][1] - MARGIN) return true;
        }
        return false;
      }
      if (p.closingMinutes != null) return (t + dur) <= (p.closingMinutes - MARGIN);
      return null; // pas d'info d'horaire
    }
    // Prochaine ouverture après l'instant t (null si aucune plage connue à venir).
    function nextOpening(p, t) {
      var iv = p.openIntervals || [];
      for (var i = 0; i < iv.length; i++) if (iv[i][0] > t) return iv[i][0];
      return null;
    }
    // Dernière fermeture connue d'un lieu (null si aucun horaire).
    function lastClose(p) {
      var iv = p.openIntervals || [];
      if (iv.length) return iv[iv.length - 1][1];
      return p.closingMinutes == null ? null : p.closingMinutes;
    }
    function nearestMeal(pos0, now, wd, endMin) {
      var best = null, bestD = 1e9;
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (placed[c.id] || !isMeal(c) || c.latitude == null) continue;
        if (closedOn(c, wd)) continue; // pas de déjeuner dans un resto fermé ce jour
        var dkm = roadKm(pos0, P(c));
        if (dkm > MEAL_DETOUR_KM) continue;
        var af = now + travelMin(pos0, P(c));
        var open = openAt(c, af, meal);
        if (open === false || (open === null && af >= normalEnd)) continue;
        if (af + meal + MARGIN > endMin || tooFarByBus(c, af + meal)) continue;
        if (dkm < bestD) { bestD = dkm; best = c; }
      }
      return best;
    }
    function makeStop(c, arr, dep, closeMin, lunchBefore, isMealStop) {
      return {
        id: c.id, nameJa: c.nameJa, nameFr: c.nameFr, nameStatus: c.nameStatus,
        zoneFr: c.zoneFr, priority: c.priority, member: c.memberFr,
        lat: c.latitude, lon: c.longitude, closeMin: closeMin,
        arrive: fmt(arr), depart: fmt(dep),
        marginMin: closeMin != null ? Math.round(closeMin - dep) : null,
        lunchBefore: lunchBefore, isMeal: !!isMealStop,
        hoursFr: c.hoursFr, hoursStatus: c.hoursStatus,
        hard: params.transport === "transit" && HARD_WITHOUT_CAR[c.zone]
      };
    }

    // 1) sélection des candidats + exclusions motivées
    var excluded = [];
    var cands = [];
    allPlaces.forEach(function (p) {
      if (p.ended) return; // déjà hors checklist active, pas d'itinéraire
      if (p.eventOnly) { excluded.push({ p: p, reason: p.eventOnly }); return; } // ex. jours de match
      if (p.latitude == null) { excluded.push({ p: p, reason: "Coordonnées manquantes" }); return; }
      if (!params.includeDone && isDone && isDone(p.id)) return; // déjà obtenu
      // Exclu seulement s'il est fermé TOUS les jours prévus ; sinon il sera
      // reporté sur un jour où il ouvre (voir la simulation ci-dessous).
      var closedAll = schedule.every(function (s) { return closedOn(p, s.weekday); });
      if (closedAll) {
        var jours = schedule.map(function (s) { return s.label; }).join(", ");
        excluded.push({ p: p, reason: schedule.length > 1
          ? "Fermé tous les jours prévus (" + jours + ")"
          : "Fermé ce jour (" + jours + ")" });
        return;
      }
      cands.push(p);
    });

    // Lieux ouverts un seul jour du séjour (séjour de 2 jours ou plus) : ce
    // jour-là, s'ils vont fermer, ils justifient un détour hors du corridor.
    var onlyDay = {};
    if (flex && days > 1) cands.forEach(function (c) {
      if (schedule.filter(function (s) { return !closedOn(c, s.weekday); }).length === 1) onlyDay[c.id] = true;
    });

    // 2) corridor : ordre de zones (le choix dans une zone se fait au plus proche, cf. 3)
    var zoneRank = {};
    if (params.transport === "transit") {
      // sans voiture : Uchiura/centre d'abord, ouest (Heda/Nishiura) en dernier
      ["uchiura_mito_awashima", "south_shimokanuki", "port_senbon", "centre_station",
       "centre_extended", "north_outskirts", "nishiura", "heda_west"].forEach(function (z, i) { zoneRank[z] = i; });
    }
    function rank(p) {
      var r = params.transport === "transit"
        ? (zoneRank[p.zone] == null ? 50 : zoneRank[p.zone])
        : (p.zoneOrder || 50);
      // ce n'est pas le jour du grand tour : l'ouest passe en dernier
      return westDay && d !== westDay && HARD_WITHOUT_CAR[p.zone] ? r + 100 : r;
    }
    cands.sort(function (a, b) {
      return rank(a) - rank(b) ||
        (a.closingMinutes == null ? 1e9 : a.closingMinutes) - (b.closingMinutes == null ? 1e9 : b.closingMinutes) ||
        a.id - b.id;
    });

    // 2 bis) la soirée : chaque journée s'étire jusqu'à la dernière fermeture
    // connue parmi les candidats (24:00, 26:00… notation japonaise du KML).
    // L'heure de départ du dernier jour, elle, reste une borne dure.
    var nightEnd = normalEnd;
    cands.forEach(function (c) {
      var lc = lastClose(c);
      if (lc != null && lc > nightEnd) nightEnd = lc;
    });
    schedule.forEach(function (s, i) {
      var fixedByDeparture = (i === schedule.length - 1) && params.leaveTime;
      if (!fixedByDeparture) s.end = nightEnd;
    });

    // 3) simulation jour par jour. Le prochain arrêt est le plus « rentable » :
    // trajet + attente, avec un bonus pour un lieu qui ferme bientôt (il vaut
    // un détour). On finit la zone en cours avant d'avancer dans le corridor,
    // et on ne revient dans une zone quittée que s'il ne reste rien plus loin :
    // c'est ce qui supprime les allers-retours.
    var URGENT = 60, URGENT_W = 0.75; // jusqu'à 45 min de détour pour un lieu qui va fermer
    var WAIT_OK = 15;                 // attente acceptable devant un lieu qui ouvre bientôt
    var WAIT_ZONE = flex ? 30 : -1;   // ... et avant de quitter une zone qu'on ne reverra pas
    var NEAR_DETOUR = flex ? 15 : -1; // trajet max. d'un détour hors zone pour un lieu qui va fermer
    // Dernier début de visite possible dans la plage qui contient t.
    function latestStart(p, t, dur) {
      var iv = p.openIntervals || [];
      for (var i = 0; i < iv.length; i++) if (t >= iv[i][0] && t < iv[i][1]) return iv[i][1] - MARGIN - dur;
      return p.closingMinutes != null ? p.closingMinutes - MARGIN - dur : Infinity;
    }
    function cheapest(opts) {
      return opts.reduce(function (a, b) { return b.cost < a.cost ? b : a; });
    }

    // Temps de trajet précalculés entre candidats et depuis le départ (indice
    // SIDX) : la retouche des journées en consulte des centaines de milliers.
    var KI = {}, N = cands.length + 1, SIDX = cands.length, MAT = new Float64Array(N * N);
    cands.forEach(function (c, i) { KI[c.id] = i; });
    for (var mi = 0; mi < N; mi++) {
      for (var mj = 0; mj < N; mj++) {
        MAT[mi * N + mj] = travelMin(mi === SIDX ? start : P(cands[mi]), mj === SIDX ? start : P(cands[mj]));
      }
    }
    function tm(a, b) { return MAT[a * N + b]; }
    // Sans voiture, Heda/Nishiura seulement si l'on peut en revenir avant la fin
    // de journée normale (les bus du soir y sont rares ou inexistants).
    function tooFarByBus(p, leaveAt) {
      return params.transport === "transit" && HARD_WITHOUT_CAR[p.zone] &&
        leaveAt + tm(KI[p.id], SIDX) > normalEnd;
    }

    // Horaires d'une tournée (liste d'arrêts { p, k, lunch, meal, pause }), avec
    // les mêmes règles que la construction ; null si un horaire ne tient plus.
    function retime(seq, today) {
      var t = today.start, at = SIDX, travel = 0, times = [];
      for (var i = 0; i < seq.length; i++) {
        var it = seq[i], tr = tm(at, it.k), dur = it.meal ? meal : visit;
        travel += tr;
        var s = t + tr + (it.pause ? prof.lunch : 0);
        if (it.lunch) s = Math.max(s, LUNCH_AT - 30); // pas de repas avant midi
        var open = openAt(it.p, s, dur);
        if (open === false) {
          s = nextOpening(it.p, s);
          if (s == null || !openAt(it.p, s, dur)) return null;
        } else if (open === null && s >= normalEnd) return null;
        if (s + dur + MARGIN > today.end || tooFarByBus(it.p, s + dur)) return null;
        times.push(s);
        t = s + dur; at = it.k;
      }
      // le retour à la base compte : finir loin n'est pas une économie
      return { times: times, travel: travel + tm(at, SIDX), end: t };
    }

    // 3 bis) Retouche d'une journée : déplacer un bloc de 1 à 3 arrêts ailleurs,
    // ou inverser un tronçon, dès que le trajet raccourcit sans finir plus tard
    // ni casser un horaire (le repas ne bouge pas). Rattrape les lieux « oubliés »
    // par le choix au plus proche, qu'on reviendrait sinon chercher en fin de journée.
    function improve(seq, today) {
      var best = retime(seq, today), cur = seq, changed = false;
      if (!best) return null;
      // indice de la position i d'une tournée ; avant le 1er et après le dernier : la base
      function at(arr, i) { return i < 0 || i >= arr.length ? SIDX : arr[i].k; }
      function accept(cand) {
        var t = retime(cand, today);
        if (!t || t.travel > best.travel - 0.01 || t.end > best.end + 0.01) return false;
        cur = cand; best = t; changed = true; return true;
      }
      function onePass() {
        var n = cur.length, i, j, k;
        for (k = 1; k <= 3; k++) {
          for (i = 0; i + k <= n; i++) {
            var blk = cur.slice(i, i + k);
            if (blk.some(function (it) { return it.lunch; })) continue;
            var rest = cur.slice(0, i).concat(cur.slice(i + k));
            var a = at(cur, i - 1), f = blk[0].k, l = blk[k - 1].k;
            var nx = at(cur, i + k); // après le dernier arrêt : retour à la base
            var gain = tm(a, f) + tm(l, nx) - tm(a, nx);
            for (j = 0; j <= rest.length; j++) {
              if (j === i) continue; // remis à sa place
              var q0 = at(rest, j - 1), q1 = at(rest, j), base = tm(q0, q1);
              if (tm(q0, f) + tm(l, q1) - base < gain - 0.01 &&
                  accept(rest.slice(0, j).concat(blk, rest.slice(j)))) return true;
              if (k > 1 && tm(q0, l) + tm(f, q1) - base < gain - 0.01 &&
                  accept(rest.slice(0, j).concat(blk.slice().reverse(), rest.slice(j)))) return true;
            }
          }
        }
        for (i = 0; i < n - 1; i++) {
          if (cur[i].lunch) continue;
          for (j = i + 1; j < n && !cur[j].lunch; j++) {
            var p0 = at(cur, i - 1), b = at(cur, j + 1);
            var delta = tm(p0, cur[j].k) - tm(p0, cur[i].k) + tm(cur[i].k, b) - tm(cur[j].k, b);
            if (delta < -0.01 && accept(cur.slice(0, i).concat(cur.slice(i, j + 1).reverse(), cur.slice(j + 1)))) return true;
          }
        }
        return false;
      }
      for (var pass = 0; pass < 300 && onePass(); pass++) { /* première amélioration trouvée, on recommence */ }
      return changed ? { seq: cur, times: best } : null;
    }

    var placed = {};
    var skippedClosing = {};
    var closedOnPass = {};
    var travelTotal = 0; // minutes de trajet, retours à la base compris
    var plans = [];      // tournée de chaque jour, avant la passe entre les jours
    var result = [];
    for (var d = 1; d <= days; d++) {
      var today = schedule[d - 1];
      var time = today.start, pos = start, lunchTaken = false, pause = false, seq = [];
      var reached = -1; // rang du corridor atteint ce jour-là
      // Pause déjeuner seulement si la journée a commencé avant midi : arriver
      // à 14 h ou 18 h ne doit pas déclencher un déjeuner.
      var lunchDay = today.start < LUNCH_AT;

      // Visite de c (durée dur) depuis la position et l'heure courantes :
      // { c, arrive, start, cost }, ou null si impossible aujourd'hui.
      var option = function (c, dur) {
        var arrive = time + travelMin(pos, P(c)), s = arrive;
        var open = openAt(c, s, dur);
        if (open === false) { // fermé à l'arrivée : rouvre-t-il assez tôt ?
          var next = nextOpening(c, s);
          if (next == null || next + dur + MARGIN > today.end) {
            if (c.closingMinutes != null && s + dur > c.closingMinutes - MARGIN) skippedClosing[c.id] = c.closingMinutes;
            else closedOnPass[c.id] = true;
            return null;
          }
          s = next;
          if (!openAt(c, s, dur)) return null; // plage trop courte pour la visite
        }
        if (open === null && s >= normalEnd) return null; // pas de devinette le soir
        if (s + dur + MARGIN > today.end) return null;      // journée pleine pour ce point
        if (tooFarByBus(c, s + dur)) return null;
        var slack = latestStart(c, s, dur) - s;
        return { c: c, arrive: arrive, start: s, slack: slack,
                 cost: (s - time) - URGENT_W * Math.max(0, URGENT - slack) };
      };

      var take = function (c, s, lunch, isMealStop) {
        seq.push({ p: c, k: KI[c.id], s: s, lunch: lunch, meal: isMealStop, pause: lunch && !isMealStop });
        placed[c.id] = true; time = s + (isMealStop ? meal : visit); pos = P(c);
      };

      var fill = function () {
        var guard = 0;
        while (guard++ < 2000) {
          var opts = [];
          cands.forEach(function (c) {
            if (placed[c.id] || closedOn(c, today.weekday)) return;
            var o = option(c, visit);
            if (o) opts.push(o);
          });
          if (!opts.length) break;
          var pool = opts.filter(function (o) { return rank(o.c) >= reached; });
          if (!pool.length) pool = opts; // plus rien en aval : retour autorisé
          // la zone la plus en amont d'abord, sans attendre si d'autres lieux sont ouverts
          var ready = pool.filter(function (o) { return o.start - o.arrive <= WAIT_OK; });
          if (ready.length) {
            var r0 = Math.min.apply(null, ready.map(function (o) { return rank(o.c); }));
            // on ne quitte pas pour de bon la zone en cours si un lieu y ouvre sous peu : on l'attend
            var soon = r0 > reached && reached >= 0 ? pool.filter(function (o) {
              return rank(o.c) === reached && o.start - time <= WAIT_ZONE;
            }) : [];
            pool = soon.length ? soon : ready.filter(function (o) { return rank(o.c) === r0; });
          }
          // Hors corridor, seul un lieu sur le point de fermer peut s'inviter : s'il
          // est tout proche (le bonus couvre le trajet), ou si c'est son seul jour
          // d'ouverture du séjour (sinon il est perdu).
          opts.forEach(function (o) {
            var worth = onlyDay[o.c.id] || (o.cost < 0 && o.arrive - time <= NEAR_DETOUR);
            if (worth && o.slack < URGENT && o.start - o.arrive <= WAIT_OK && pool.indexOf(o) < 0) pool.push(o);
          });
          var pick = cheapest(pool), c = pick.c;

          // déjeuner à partir de 12 h 30 : sur place si c'est un resto, sinon
          // dans un resto proche, sinon une simple pause avant l'arrêt suivant
          if (lunchDay && !lunchTaken && pick.arrive >= LUNCH_AT) {
            var here = isMeal(c) ? option(c, meal) : null;
            lunchTaken = true;
            if (here) { take(c, here.start, true, true); reached = Math.max(reached, rank(c)); continue; }
            var food = nearestMeal(pos, time, today.weekday, today.end);
            if (food) take(food, time + travelMin(pos, P(food)), true, true); // détour repas
            else { time += prof.lunch; pause = true; }
            continue;
          }
          take(c, pick.start, pause, false);
          pause = false;
          reached = Math.max(reached, rank(c));
        }
      };

      fill();
      // retouche, puis on remplit le temps gagné (jusqu'à 3 tours)
      var sched = retime(seq, today);
      for (var round = 0; round < 3 && sched; round++) {
        var better = improve(seq, today);
        if (!better) break;
        seq = better.seq; sched = better.times;
        var last = seq[seq.length - 1], before = seq.length;
        time = sched.end; pos = P(last.p); reached = rank(last.p); pause = false;
        fill();
        sched = retime(seq, today);
        if (seq.length === before) break;
      }
      plans.push({ seq: seq, sched: sched, today: today });
    }

    // 3 ter) Entre les jours : un arrêt passe au jour où le parcours passe à
    // côté (un konbini lointain pris le jeudi soir alors que vendredi y va de
    // toute façon), si le trajet total raccourcit et que tout tient encore.
    moveBetweenDays();

    plans.forEach(function (pl, i) {
      var better = pl.sched && improve(pl.seq, pl.today);
      if (better) { pl.seq = better.seq; pl.sched = better.times; }
      var today = pl.today, sched = pl.sched;
      travelTotal += sched ? sched.travel : 0;
      var stops = pl.seq.map(function (it, k) {
        var s = sched ? sched.times[k] : it.s;
        return makeStop(it.p, s, s + (it.meal ? meal : visit), it.p.closingMinutes, it.lunch, it.meal);
      });
      result.push({
        day: i + 1, date: today.iso, dateLabel: today.label,
        startTime: fmt(today.start), closeTime: fmt(today.end),
        endTime: stops.length ? stops[stops.length - 1].depart : fmt(today.start),
        stops: stops, gmaps: gmapsDir(start, stops, prof.gmaps)
      });
    });

    function moveBetweenDays() {
      function at(arr, i) { return i < 0 || i >= arr.length ? SIDX : arr[i].k; }
      function onePass() {
        for (var a = 0; a < plans.length; a++) {
          var A = plans[a];
          if (!A.sched) continue;
          for (var i = 0; i < A.seq.length; i++) {
            var it = A.seq[i];
            if (it.lunch) continue; // le repas ne bouge pas
            var p0 = at(A.seq, i - 1), p1 = at(A.seq, i + 1);
            var gain = tm(p0, it.k) + tm(it.k, p1) - tm(p0, p1);
            for (var b = 0; b < plans.length; b++) {
              var B = plans[b];
              if (b === a || !B.sched || closedOn(it.p, B.today.weekday)) continue;
              for (var j = 0; j <= B.seq.length; j++) {
                var q0 = at(B.seq, j - 1), q1 = at(B.seq, j);
                if (tm(q0, it.k) + tm(it.k, q1) - tm(q0, q1) > gain - 1) continue; // ≥ 1 min gagnée
                var seqA = A.seq.slice(0, i).concat(A.seq.slice(i + 1));
                var seqB = B.seq.slice(0, j).concat([it], B.seq.slice(j));
                var ta = retime(seqA, A.today), tb = ta && retime(seqB, B.today);
                if (!ta || !tb) continue;
                A.seq = seqA; A.sched = ta; B.seq = seqB; B.sched = tb;
                return true;
              }
            }
          }
        }
        return false;
      }
      for (var pass = 0; pass < 300 && onePass(); pass++) { /* un déplacement à la fois */ }
    }

    // 4) candidats non placés -> exclusions motivées
    cands.forEach(function (c) {
      if (placed[c.id]) return;
      var reason;
      if (params.transport === "transit" && HARD_WITHOUT_CAR[c.zone])
        reason = "Très difficile sans voiture (" + c.zoneFr + ")";
      else if (skippedClosing[c.id] != null)
        reason = "Ferme trop tôt pour être atteint à temps (" + fmt(skippedClosing[c.id]) + ")";
      else if (closedOnPass[c.id])
        reason = "Fermé au moment où le parcours passe (" + (c.hoursFr || "horaires en plusieurs plages") + ")";
      else
        reason = "Au-delà de la capacité de " + days + " jour" + (days > 1 ? "s" : "");
      excluded.push({ p: c, reason: reason });
    });

    var planned = 0;
    result.forEach(function (dd) { planned += dd.stops.length; });
    return {
      params: tripParams(params, days, schedule.map(function (s) { return s.iso; })),
      days: result,
      excluded: excluded.map(function (e) { return { id: e.p.id, nameJa: e.p.nameJa, nameFr: e.p.nameFr, zoneFr: e.p.zoneFr, reason: e.reason }; }),
      summary: { candidates: cands.length, planned: planned, excluded: excluded.length,
                 generic: !arriveDate, travelMin: Math.round(travelTotal) }
    };
  }

  // URL Google Maps directions multi-étapes (max 9 points intermédiaires).
  function gmapsDir(start, stops, mode) {
    if (!stops.length) return "";
    var pts = stops.map(function (s) { return s.lat + "," + s.lon; });
    var dest = pts[pts.length - 1];
    var mids = pts.slice(0, -1).slice(0, 9);
    var url = "https://www.google.com/maps/dir/?api=1&travelmode=" + (mode || "driving") +
      "&origin=" + start.lat + "," + start.lon + "&destination=" + dest;
    if (mids.length) url += "&waypoints=" + mids.join("|");
    return url;
  }

  return { plan: plan, STATION: STATION };
})();
