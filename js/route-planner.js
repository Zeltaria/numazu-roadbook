/* route-planner.js — moteur de parcours (roadbook §11 et §12).
 * Logique pure, hors-ligne, sans dépendance. Heuristique (pas d'optimum
 * exact) de tournées avec horaires d'ouverture :
 *  1. insertion : chaque lieu va dans le jour et à la place où il allonge le
 *     moins le trajet, là où ses horaires tiennent ; trois façons de s'y
 *     prendre (lieux sans alternative d'abord, moins chers d'abord, jour 1
 *     rempli avant le jour 2…) ;
 *  2. retouche : déplacer / inverser des arrêts dans la journée, passer un
 *     arrêt d'un jour à l'autre ; le temps gagné sert aux lieux restants ;
 *  3. ruine et reconstruction : retirer un tronçon ou un groupe de lieux
 *     voisins, les réinsérer, garder si c'est mieux.
 * On garde la meilleure des trois. Pas de couloir de zones imposé : l'ordre
 * suit la géographie, d'où moins d'allers-retours. Chaque journée part de la
 * base et y revient. Tirages à graine fixe : même séjour, même parcours.
 *
 * plan(places, params, isDone) -> { params, days:[...], excluded:[...], summary }
 * params.start : point de départ {lat, lon} (gare par défaut) ; params.liveStart :
 * ce départ est « ma position », les liens Google Maps partent alors du téléphone.
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

  // Ce que vaut un parcours, en minutes de route : un tampon de plus vaut au
  // plus STAMP_MIN de route en plus ; une minute de journée en plus (attente
  // comprise) coûte END_W ; un tampon remis d'un jour coûte LATER_DAY (mieux
  // vaut profiter du temps tout de suite et garder de la marge pour la fin).
  var STAMP_MIN = 60, END_W = 0.25, LATER_DAY = 6;
  var LNS_ROUNDS = 10;    // tours de ruine et reconstruction par construction
  var SEED = 0x2F6E2B1;   // graine des tirages

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

  function plan(allPlaces, params, isDone) {
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
      info.index = i;
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

    // --- déjeuner : au resto du parcours quand il y en a un vers midi ---
    var LUNCH_AT = 12 * 60 + 30;                  // pause déclenchée à partir de 12 h 30
    var LUNCH_LATE = 14 * 60;                     // resto atteint au plus tard à 14 h
    var MEAL_CATS = { restaurant: 1, sushi: 1, cafe: 1, bakery: 1 };
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
    // Début de visite le plus tôt à partir de t, attente comprise (-1 : rien ne
    // tient ce jour-là). Horaires inconnus : pas de devinette le soir.
    function fit(p, t, dur) {
      var open = openAt(p, t, dur);
      if (open) return t;
      if (open === null) return t < normalEnd ? t : -1;
      var iv = p.openIntervals || [];
      for (var i = 0; i < iv.length; i++) if (iv[i][0] > t && openAt(p, iv[i][0], dur)) return iv[i][0];
      return -1;
    }
    // Dernière fermeture connue d'un lieu (null si aucun horaire).
    function lastClose(p) {
      var iv = p.openIntervals || [];
      if (iv.length) return iv[iv.length - 1][1];
      return p.closingMinutes == null ? null : p.closingMinutes;
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
      // placé un jour où il ouvre.
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

    // 2) la soirée : chaque journée s'étire jusqu'à la dernière fermeture
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

    // Temps de trajet précalculés entre candidats et depuis la base (indice
    // SIDX) : la construction et la retouche en consultent des millions.
    var N = cands.length + 1, SIDX = cands.length, MAT = new Float64Array(N * N);
    for (var mi = 0; mi < N; mi++) {
      for (var mj = 0; mj < N; mj++) {
        MAT[mi * N + mj] = travelMin(mi === SIDX ? start : P(cands[mi]), mj === SIDX ? start : P(cands[mj]));
      }
    }
    function tm(a, b) { return MAT[a * N + b]; }
    // Sans voiture, Heda/Nishiura seulement si l'on peut en revenir avant la fin
    // de journée normale (les bus du soir y sont rares ou inexistants).
    function tooFarByBus(k, leaveAt) {
      return params.transport === "transit" && HARD_WITHOUT_CAR[cands[k].zone] &&
        leaveAt + tm(k, SIDX) > normalEnd;
    }

    // 3) Horaires d'une journée (suite d'indices de candidats), au départ de la
    // base : attente devant un lieu pas encore ouvert ; déjeuner (journée
    // commencée avant 12 h 30) au premier resto atteint entre 12 h et 14 h
    // — tampon + repas —, sinon une pause avant le premier arrêt après 12 h 30.
    // Le retour à la base compte dans le trajet. null si un horaire ne tient pas.
    function simulate(seq, today) {
      var t = today.start, at = SIDX, travel = 0, times = [], durs = [], lunch = -1, mealStop = false;
      var lunchDay = today.start < LUNCH_AT;
      for (var i = 0; i < seq.length; i++) {
        var k = seq[i], p = cands[k], tr = tm(at, k), a = t + tr, s = a, dur = visit;
        travel += tr;
        if (lunchDay && lunch < 0 && a >= LUNCH_AT - 30) {
          var sm = isMeal(p) && a <= LUNCH_LATE ? fit(p, a, meal) : -1;
          if (sm >= 0) { lunch = i; mealStop = true; s = sm; dur = meal; }
          else if (a >= LUNCH_AT) { lunch = i; s = a + prof.lunch; }
        }
        s = fit(p, s, dur);
        if (s < 0 || s + dur + MARGIN > today.end || tooFarByBus(k, s + dur)) return null;
        times.push(s); durs.push(dur);
        t = s + dur; at = k;
      }
      return { times: times, durs: durs, travel: travel + tm(at, SIDX), end: t,
               lunch: lunch, meal: mealStop, day: today.index };
    }
    function cost(sim) { return sim.travel + END_W * sim.end + LATER_DAY * sim.day * sim.times.length; }

    // Dernier début de visite possible d'un lieu ce jour-là, à partir de t0
    // (horaires, fin de journée, dernier bus), sans compter le déjeuner.
    function latestStart(k, t0, dur, today) {
      var p = cands[k], iv = p.openIntervals || [], L;
      if (iv.length) {
        L = -1;
        for (var i = 0; i < iv.length; i++) if (iv[i][1] - MARGIN - dur >= t0) { L = iv[i][1] - MARGIN - dur; if (t0 >= iv[i][0]) break; }
        if (L < 0) return -1;
      } else if (p.closingMinutes != null) L = p.closingMinutes - MARGIN - dur;
      else L = normalEnd - 0.001;
      L = Math.min(L, today.end - MARGIN - dur);
      if (params.transport === "transit" && HARD_WITHOUT_CAR[p.zone]) L = Math.min(L, normalEnd - tm(k, SIDX) - dur);
      return L;
    }
    // Retard que chaque arrêt peut encaisser sans casser la suite de la journée
    // (attentes devant les lieux comprises) : sert à écarter d'avance les
    // insertions impossibles, avant de simuler les autres.
    function slackOf(seq, sim, today) {
      if (sim.slack) return sim.slack;
      var n = seq.length, ms = new Array(n);
      for (var i = n - 1; i >= 0; i--) {
        var own = latestStart(seq[i], sim.times[i], sim.durs[i], today) - sim.times[i];
        if (i === n - 1) { ms[i] = own; continue; }
        var idle = sim.times[i + 1] - (sim.times[i] + sim.durs[i] + tm(seq[i], seq[i + 1])) -
          (sim.lunch === i + 1 && !sim.meal ? prof.lunch : 0);
        ms[i] = Math.min(own, Math.max(0, idle) + ms[i + 1]);
      }
      sim.slack = ms;
      return ms;
    }

    var D = schedule.length, nC = cands.length;
    var routes, sims, cache, dayOf = [], okDays = [];
    cands.forEach(function (c) {
      dayOf.push(-1);
      okDays.push(schedule.map(function (s, d) { return closedOn(c, s.weekday) ? -1 : d; })
        .filter(function (d) { return d >= 0; }));
    });
    // Sans voiture, Heda / Nishiura ne prennent que le temps qui reste.
    var late = cands.map(function (c) { return params.transport === "transit" && !!HARD_WITHOUT_CAR[c.zone]; });
    function placedCount() { return dayOf.filter(function (d) { return d >= 0; }).length; }
    function value() {
      var c = 0;
      sims.forEach(function (x) { c += cost(x); });
      return placedCount() * STAMP_MIN - c;
    }

    // Meilleure insertion du candidat k dans le jour d : { k, d, seq, sim, cost }
    // ou null. Places essayées de la moins chère à la plus chère en trajet,
    // celles qui ne peuvent pas tenir écartées d'avance ; on s'arrête après
    // trois places dont les horaires tiennent.
    var TOL = 1; // minutes de tolérance du tri préalable
    function bestInsert(k, d) {
      var r = routes[d], today = schedule[d], sim0 = sims[d], base = cost(sim0), pos = [];
      var lastK = latestStart(k, today.start, visit, today);
      if (lastK < 0) return null;
      for (var j = 0; j <= r.length; j++) {
        var a = j ? r[j - 1] : SIDX, b = j < r.length ? r[j] : SIDX;
        pos.push([tm(a, k) + tm(k, b) - tm(a, b), j]);
      }
      pos.sort(function (x, y) { return x[0] - y[0]; });
      var ms = slackOf(r, sim0, today), best = null, found = 0;
      for (var i = 0; i < pos.length && found < 3; i++) {
        var at = pos[i][1], prev = at ? r[at - 1] : SIDX;
        var arrive = (at ? sim0.times[at - 1] + sim0.durs[at - 1] : today.start) + tm(prev, k);
        if (arrive > lastK + TOL) continue;
        if (at < r.length) {
          var sk = fit(cands[k], arrive, visit);
          if (sk < 0 && arrive < LUNCH_AT - 30) continue;
          var delay = (sk < 0 ? arrive : sk) + visit + tm(k, r[at]) - sim0.times[at];
          if (delay > ms[at] + TOL) continue;
        }
        var seq = r.slice(0, at);
        seq.push(k);
        seq = seq.concat(r.slice(at));
        var sim = simulate(seq, today);
        if (!sim) continue;
        found++;
        var c = cost(sim) - base;
        if (!best || c < best.cost) best = { k: k, d: d, seq: seq, sim: sim, cost: c };
      }
      return best;
    }
    function refreshDay(d) {
      for (var k = 0; k < nC; k++) {
        if (!cache[k]) cache[k] = [];
        if (dayOf[k] < 0 && okDays[k].indexOf(d) >= 0) cache[k][d] = bestInsert(k, d);
      }
    }
    function put(o) { routes[o.d] = o.seq; sims[o.d] = o.sim; dayOf[o.k] = o.d; refreshDay(o.d); }

    // Insertion de tous les lieux possibles. regretFirst : à chaque tour, le
    // lieu qui perdrait le plus à ne pas aller dans son meilleur jour (un seul
    // jour possible = priorité) ; sinon le moins cher.
    function insertAll(regretFirst) {
      for (var d0 = 0; d0 < D; d0++) refreshDay(d0);
      for (var phase = 0; phase < 2; phase++) for (;;) {
        var pick = null, pickRegret = -1;
        for (var k = 0; k < nC; k++) {
          if (dayOf[k] >= 0 || late[k] !== (phase === 1)) continue;
          var b1 = null, b2 = null;
          for (var q = 0; q < okDays[k].length; q++) {
            var o = cache[k][okDays[k][q]];
            if (!o) continue;
            if (!b1 || o.cost < b1.cost) { b2 = b1; b1 = o; } else if (!b2 || o.cost < b2.cost) b2 = o;
          }
          if (!b1) continue;
          var regret = !regretFirst ? 0 : b2 ? b2.cost - b1.cost : 1e6;
          if (!pick || regret > pickRegret + 1e-6 ||
              (regret > pickRegret - 1e-6 && b1.cost < pick.cost)) { pick = b1; pickRegret = regret; }
        }
        if (!pick) break;
        put(pick);
      }
    }
    // Remplissage jour après jour : le jour 1 d'abord, au moins cher, puis le 2…
    function insertByDay() {
      for (var d = 0; d < D; d++) {
        refreshDay(d);
        for (;;) {
          var pick = null;
          for (var k = 0; k < nC; k++) {
            if (dayOf[k] >= 0 || late[k]) continue;
            var o = cache[k][d];
            if (o && (!pick || o.cost < pick.cost)) pick = o;
          }
          if (!pick) break;
          put(pick);
        }
      }
    }

    // Retouche d'une journée : déplacer un bloc de 1 à 3 arrêts (à l'endroit ou
    // à l'envers) ailleurs, ou inverser un tronçon, dès que la journée coûte
    // moins sans casser un horaire.
    function improveDay(d) {
      var cur = routes[d], best = sims[d], changed = false;
      function at(arr, i) { return i < 0 || i >= arr.length ? SIDX : arr[i]; }
      function accept(cand) {
        var s = simulate(cand, schedule[d]);
        if (!s || cost(s) > cost(best) - 0.01) return false;
        cur = cand; best = s; changed = true; return true;
      }
      function onePass() {
        var n = cur.length, i, j, k;
        for (k = 1; k <= 3; k++) {
          for (i = 0; i + k <= n; i++) {
            var blk = cur.slice(i, i + k), rest = cur.slice(0, i).concat(cur.slice(i + k));
            var a = at(cur, i - 1), f = blk[0], l = blk[k - 1], nx = at(cur, i + k);
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
          for (j = i + 1; j < n; j++) {
            var p0 = at(cur, i - 1), b = at(cur, j + 1);
            var delta = tm(p0, cur[j]) - tm(p0, cur[i]) + tm(cur[i], b) - tm(cur[j], b);
            if (delta < -0.01 && accept(cur.slice(0, i).concat(cur.slice(i, j + 1).reverse(), cur.slice(j + 1)))) return true;
          }
        }
        return false;
      }
      for (var pass = 0; pass < 500 && onePass(); pass++) { /* première amélioration trouvée, on recommence */ }
      routes[d] = cur; sims[d] = best;
      return changed;
    }
    // Un arrêt passe dans un autre jour si l'ensemble coûte moins.
    function relocate() {
      for (var a = 0; a < D; a++) {
        for (var i = 0; i < routes[a].length; i++) {
          var k = routes[a][i];
          var rest = routes[a].slice(0, i).concat(routes[a].slice(i + 1));
          var sa = simulate(rest, schedule[a]);
          if (!sa) continue;
          var gain = cost(sims[a]) - cost(sa);
          for (var q = 0; q < okDays[k].length; q++) {
            var b = okDays[k][q];
            if (b === a) continue;
            var o = bestInsert(k, b);
            if (o && o.cost < gain - 0.5) {
              routes[a] = rest; sims[a] = sa; routes[b] = o.seq; sims[b] = o.sim; dayOf[k] = b;
              return true;
            }
          }
        }
      }
      return false;
    }

    // Une construction complète : insertion, puis retouches tant qu'elles
    // déplacent des arrêts ou font de la place pour d'autres lieux.
    function solve(strategy) {
      routes = []; sims = []; cache = [];
      schedule.forEach(function (s) { routes.push([]); sims.push(simulate([], s)); });
      for (var k = 0; k < nC; k++) dayOf[k] = -1;
      if (strategy === "byDay") insertByDay();
      insertAll(strategy !== "cheap");
      for (var round = 0; round < 4; round++) {
        var before = placedCount(), moved = false;
        for (var d1 = 0; d1 < D; d1++) if (improveDay(d1)) moved = true;
        for (var guard = 0; guard < 200 && relocate(); guard++) moved = true;
        for (var d2 = 0; d2 < D; d2++) improveDay(d2);
        insertAll(strategy !== "cheap"); // le temps gagné sert aux lieux restants
        if (!moved && placedCount() === before) break;
      }
    }

    // Ruine et reconstruction : on retire un tronçon d'une journée, ou un groupe
    // de lieux voisins (tous jours confondus), on les réinsère, et on garde si
    // le parcours y gagne. Tirages pseudo-aléatoires à graine fixe.
    var seed = SEED;
    function rnd() {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function ruin() {
      var removed = [], d, k;
      if (rnd() < 0.5) {
        var full = [];
        for (d = 0; d < D; d++) if (routes[d].length) full.push(d);
        if (!full.length) return false;
        d = full[Math.floor(rnd() * full.length)];
        var r = routes[d], L = Math.min(r.length, 3 + Math.floor(rnd() * 10));
        var i0 = Math.floor(rnd() * (r.length - L + 1));
        removed = r.slice(i0, i0 + L);
        routes[d] = r.slice(0, i0).concat(r.slice(i0 + L));
      } else {
        var on = [];
        for (k = 0; k < nC; k++) if (dayOf[k] >= 0) on.push(k);
        if (!on.length) return false;
        var c0 = on[Math.floor(rnd() * on.length)];
        on.sort(function (a, b) { return tm(c0, a) - tm(c0, b); });
        removed = on.slice(0, 5 + Math.floor(rnd() * 10));
        var out = {};
        removed.forEach(function (x) { out[x] = true; });
        for (d = 0; d < D; d++) routes[d] = routes[d].filter(function (x) { return !out[x]; });
      }
      removed.forEach(function (x) { dayOf[x] = -1; });
      for (d = 0; d < D; d++) { sims[d] = simulate(routes[d], schedule[d]); if (!sims[d]) return false; }
      return true;
    }
    function ruinAndRecreate(rounds) {
      var bestVal = value(), keep = { routes: routes.slice(), sims: sims.slice(), dayOf: dayOf.slice() };
      for (var it = 0; it < rounds; it++) {
        if (ruin()) {
          insertAll(rnd() < 0.5);
          for (var d = 0; d < D; d++) improveDay(d);
          insertAll(true);
        }
        var v = sims.every(Boolean) ? value() : -Infinity;
        if (v > bestVal + 0.01) { bestVal = v; keep = { routes: routes.slice(), sims: sims.slice(), dayOf: dayOf.slice() }; }
        else { routes = keep.routes.slice(); sims = keep.sims.slice(); dayOf = keep.dayOf.slice(); }
      }
    }

    // Trois constructions (lieux sans alternative d'abord, moins chers
    // d'abord, jour après jour), chacune retouchée puis passée à la ruine et
    // reconstruction ; on garde la meilleure.
    var bestSol = null;
    ["regret", "cheap", "byDay"].forEach(function (strategy) {
      solve(strategy);
      ruinAndRecreate(LNS_ROUNDS);
      var v = value();
      if (!bestSol || v > bestSol.value) bestSol = { routes: routes, sims: sims, dayOf: dayOf.slice(), value: v };
    });
    routes = bestSol.routes; sims = bestSol.sims; dayOf = bestSol.dayOf;

    var travelTotal = 0, result = [];
    schedule.forEach(function (today, d) {
      var sim = sims[d];
      travelTotal += sim.travel;
      var stops = routes[d].map(function (k, i) {
        var c = cands[k], s = sim.times[i], ml = sim.meal && i === sim.lunch;
        return makeStop(c, s, s + (ml ? meal : visit), c.closingMinutes, i === sim.lunch, ml);
      });
      result.push({
        day: d + 1, date: today.iso, dateLabel: today.label,
        startTime: fmt(today.start), closeTime: fmt(today.end),
        endTime: stops.length ? stops[stops.length - 1].depart : fmt(today.start),
        stops: stops, gmaps: gmapsDir(params.liveStart ? null : start, stops, prof.gmaps)
      });
    });

    // 4) candidats non placés -> exclusions motivées
    cands.forEach(function (c, k) {
      if (dayOf[k] >= 0) return;
      var reason;
      if (late[k])
        reason = "Très difficile sans voiture (" + c.zoneFr + ")";
      else if (okDays[k].some(function (d) { return simulate([k], schedule[d]); }))
        reason = "Au-delà de la capacité de " + days + " jour" + (days > 1 ? "s" : "");
      else if (lastClose(c) != null && okDays[k].every(function (d) {
        return schedule[d].start + tm(SIDX, k) + visit > lastClose(c) - MARGIN;
      }))
        reason = "Ferme trop tôt pour être atteint à temps (" + fmt(lastClose(c)) + ")";
      else
        reason = "Fermé au moment où le parcours passe (" + (c.hoursFr || "horaires en plusieurs plages") + ")";
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
  // Sans origine, Google Maps part de la position réelle du téléphone.
  function gmapsDir(start, stops, mode) {
    if (!stops.length) return "";
    var pts = stops.map(function (s) { return s.lat + "," + s.lon; });
    var dest = pts[pts.length - 1];
    var mids = pts.slice(0, -1).slice(0, 9);
    var url = "https://www.google.com/maps/dir/?api=1&travelmode=" + (mode || "driving") +
      (start ? "&origin=" + start.lat + "," + start.lon : "") + "&destination=" + dest;
    if (mids.length) url += "&waypoints=" + mids.join("|");
    return url;
  }

  return { plan: plan, STATION: STATION };
})();
