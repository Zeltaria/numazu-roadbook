/* Tests du moteur de parcours (js/route-planner.js), sans dépendance, à lancer
 * depuis la racine du dépôt :   node --test
 * Chaque parcours généré passe par un contrôleur indépendant (horaires,
 * jours de fermeture, temps de trajet, doublons…), et la qualité est comparée
 * à l'ancien moteur, mesuré avant la refonte de l'itinéraire (octobre 2026). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

// data.js et route-planner.js tels que les charge la page (window.*).
function load() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  const engine = process.env.ROUTE_PLANNER || path.join(__dirname, "..", "js", "route-planner.js");
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "data.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(engine, "utf8"), ctx);
  return { places: ctx.window.NUMAZU_DATA.places, RP: ctx.window.RoutePlanner };
}
const { places: PLACES, RP } = load();

// Séjour du roadbook (valeurs par défaut du formulaire) et quelques points de départ.
const TRIP = { transport: "car", startTime: "08:00", visitMinutes: 5, arriveDate: "2026-10-15",
  arriveTime: "18:00", leaveDate: "2026-10-18", leaveTime: "09:00", includeDone: false };
const UCHIURA = { lat: 35.0215, lon: 138.8960 }, HEDA = { lat: 34.9700, lon: 138.7760 },
  SUD = { lat: 35.0700, lon: 138.8700 }, PORT = { lat: 35.0950, lon: 138.8560 };
const SCENARIOS = [
  ["séjour, départ gare", {}],
  ["séjour, départ Uchiura", { start: UCHIURA }],
  ["séjour, départ Heda", { start: HEDA }],
  ["séjour, départ sud", { start: SUD }],
  ["vendredi 10 h, gare", { arriveDate: "2026-10-16", arriveTime: "10:00" }],
  ["vendredi 10 h, Uchiura", { arriveDate: "2026-10-16", arriveTime: "10:00", start: UCHIURA }],
  ["vendredi 10 h, port", { arriveDate: "2026-10-16", arriveTime: "10:00", start: PORT }],
  ["samedi 14 h, port", { arriveDate: "2026-10-17", arriveTime: "14:00", start: PORT }],
  ["une journée sans dates", { arriveDate: null, arriveTime: null, leaveDate: null, leaveTime: null, days: 1 }],
  ["sans voiture", { transport: "transit" }]
];
const nobodyDone = () => false;
const plans = new Map();
function planFor(name, over, isDone) {
  const key = name + (isDone ? "+faits" : "");
  if (!plans.has(key)) plans.set(key, RP.plan(PLACES, Object.assign({}, TRIP, over), isDone || nobodyDone));
  return plans.get(key);
}

/* ---- contrôleur indépendant : le parcours est-il faisable sur place ? ---- */
const MARGIN = 10;
const PROF = { car: { speed: 28, detour: 1.35, end: 18 * 60 + 30, lunch: 45 },
               transit: { speed: 11, detour: 1.25, end: 18 * 60, lunch: 40 } };
const HARD = { heda_west: 1, nishiura: 1 }, MEAL = { restaurant: 1, sushi: 1, cafe: 1, bakery: 1 };
function km(a, b) {
  const R = 6371, r = (x) => x * Math.PI / 180;
  const s = Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const GATE = { lat: 35.027, lon: 138.893 }, westIzu = (p) => p.lat < 35.035 && p.lon < 138.87;
const roadKm = (a, b) => westIzu(a) === westIzu(b) ? km(a, b) : km(a, GATE) + km(GATE, b);
const toMin = (s) => { const a = s.split(":"); return +a[0] * 60 + +a[1]; };
const byId = new Map(PLACES.map((p) => [p.id, p]));

function problems(r, params, isDone) {
  const errs = [], prof = PROF[params.transport] || PROF.car, visit = params.visitMinutes || 5;
  const start = params.start || RP.STATION, seen = new Set();
  const travel = (a, b) => roadKm(a, b) * prof.detour / prof.speed * 60;
  for (const d of r.days) {
    const wd = d.date ? new Date(d.date + "T00:00:00Z").getUTCDay() : null;
    let t = toMin(d.startTime), at = start, meals = 0;
    for (const s of d.stops) {
      const p = byId.get(s.id), tag = "jour " + d.day + " #" + s.id + " à " + s.arrive;
      const pos = { lat: p.latitude, lon: p.longitude }, st = toMin(s.arrive);
      const dur = s.isMeal ? prof.lunch : visit;
      if (seen.has(s.id)) errs.push(tag + " : deux fois dans le parcours");
      seen.add(s.id);
      if (p.ended || p.eventOnly) errs.push(tag + " : lieu terminé ou réservé aux jours de match");
      if (!params.includeDone && isDone(p.id)) errs.push(tag + " : tampon déjà obtenu");
      if (wd != null && (p.closedDays || []).includes(wd)) errs.push(tag + " : fermé ce jour-là");
      if (s.isMeal) {
        meals++;
        if (!(p.meal != null ? p.meal : MEAL[p.category])) errs.push(tag + " : repas dans un lieu sans cuisine");
      }
      const earliest = t + travel(at, pos) + (s.lunchBefore && !s.isMeal ? prof.lunch : 0);
      if (st < earliest - 1.01) errs.push(tag + " : impossible d'y être avant " + Math.ceil(earliest) + " min");
      const iv = p.openIntervals || [];
      if (iv.length) {
        if (!iv.some((v) => st >= v[0] && st + dur <= v[1] - MARGIN + 1)) errs.push(tag + " : en dehors des horaires");
      } else if (p.closingMinutes != null) {
        if (st + dur > p.closingMinutes - MARGIN + 1) errs.push(tag + " : après la fermeture");
      } else if (st >= prof.end + 1) errs.push(tag + " : horaires inconnus, en soirée");
      if (st + dur + MARGIN > toMin(d.closeTime) + 1) errs.push(tag + " : après la fin de la journée");
      if (params.transport === "transit" && HARD[p.zone] && st + dur + travel(pos, start) > prof.end + 1)
        errs.push(tag + " : plus de bus pour revenir");
      t = st + dur; at = pos;
    }
    if (meals > 1) errs.push("jour " + d.day + " : plusieurs repas");
  }
  return errs;
}

/* ---- faisabilité ---- */

for (const [name, over] of SCENARIOS) {
  test("parcours faisable : " + name, () => {
    const params = Object.assign({}, TRIP, over);
    assert.deepEqual(problems(planFor(name, over), params, nobodyDone), []);
  });
}

test("parcours faisable avec des tampons déjà obtenus (jamais replanifiés)", () => {
  const done = new Set([1, 2, 3, 13, 27, 58, 72, 100]), isDone = (id) => done.has(id);
  const over = { arriveDate: "2026-10-16", arriveTime: "08:30", start: UCHIURA };
  const r = planFor("vendredi 8 h 30, Uchiura", over, isDone);
  assert.deepEqual(problems(r, Object.assign({}, TRIP, over), isDone), []);
  assert.ok(r.summary.planned > 0);
});

/* ---- allers-retours et qualité ---- */

// Avec l'ancien moteur, le vendredi soir partait 14 km jusqu'à Heda pour un
// seul tampon, puis revenait vers Uchiura : 19,6 km de détour.
test("pas d'aller-retour de plus de 15 km pour un seul tampon (séjour depuis Uchiura)", () => {
  const r = planFor("séjour, départ Uchiura", { start: UCHIURA });
  for (const d of r.days) {
    const pts = [UCHIURA].concat(d.stops.map((s) => ({ lat: s.lat, lon: s.lon, id: s.id })), [UCHIURA]);
    for (let i = 1; i + 1 < pts.length; i++) {
      const detour = km(pts[i - 1], pts[i]) + km(pts[i], pts[i + 1]) - km(pts[i - 1], pts[i + 1]);
      assert.ok(detour <= 15, "jour " + d.day + " : #" + pts[i].id + " coûte " + detour.toFixed(1) + " km de détour");
    }
  }
});

// Ancien moteur sur ces 10 séjours, avec la base mise à jour le 18/10/2026 (horaires
// du dimanche) : 1 147 tampons planifiés, 4 066 min de route (à remesurer si la
// base change). La recherche est heuristique : un petit changement de la base peut
// la faire tomber sur une autre solution (départ de Heda : de 433 à 673 min de
// route quand Lot.n a bougé de 250 m) ; d'où une marge de 3 % sur la route et de
// 0,5 % sur les tampons (nouveau moteur sur cette base : 1 145 tampons, 3 710 min).
test("autant de tampons que l'ancien moteur (à 0,5 % près), avec moins de route", () => {
  let planned = 0, travel = 0;
  for (const [name, over] of SCENARIOS) {
    const r = planFor(name, over);
    planned += r.summary.planned; travel += r.summary.travelMin;
  }
  assert.ok(planned >= 1141, planned + " tampons planifiés (ancien moteur : 1 147, moins 0,5 %)");
  assert.ok(travel <= 3944, travel + " min de route (ancien moteur : 4 066, moins 3 %)");
});

// En replanifiant le matin (« ⏱ Maintenant »), la journée du jour reste la plus
// remplie : le lendemain n'est qu'une prévision.
test("replanifier le vendredi matin : la journée du jour est bien remplie", () => {
  const r = planFor("vendredi 8 h 30, gare", { arriveDate: "2026-10-16", arriveTime: "08:30" });
  assert.ok(r.days[0].stops.length >= 75, r.days[0].stops.length + " tampons le jour même");
  assert.ok(r.days[0].stops.length > r.days[1].stops.length);
});

test("même séjour, même parcours", () => {
  const over = { arriveDate: "2026-10-16", arriveTime: "10:00", start: PORT };
  const a = RP.plan(PLACES, Object.assign({}, TRIP, over), nobodyDone);
  const b = RP.plan(PLACES, Object.assign({}, TRIP, over), nobodyDone);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

/* ---- contrat avec app.js et export.js ---- */

test("forme du résultat utilisée par l'affichage et l'export", () => {
  const r = planFor("séjour, départ gare", {});
  assert.deepEqual(Array.from(r.params.dates), ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.equal(r.days.length, 4);
  const d = r.days.find((x) => x.stops.length);
  for (const k of ["day", "date", "dateLabel", "startTime", "endTime", "closeTime", "stops", "gmaps"]) assert.ok(k in d, k);
  for (const k of ["id", "nameJa", "nameFr", "nameStatus", "zoneFr", "member", "lat", "lon", "arrive", "depart",
                   "closeMin", "marginMin", "lunchBefore", "isMeal", "hard"]) assert.ok(k in d.stops[0], k);
  assert.match(d.stops[0].arrive, /^\d\d:\d\d$/);
  const s = r.summary;
  assert.equal(s.planned, r.days.reduce((n, x) => n + x.stops.length, 0));
  assert.equal(s.excluded, r.excluded.length);
  assert.equal(s.candidates, s.planned + r.excluded.filter((e) => !/jours de match|Fermé tous les jours/.test(e.reason)).length);
  r.excluded.forEach((e) => { assert.ok(e.id && e.reason); });
  assert.equal(typeof s.travelMin, "number");
});

test("au plus un déjeuner par jour, seulement si la journée commence avant 12 h 30", () => {
  const r = planFor("vendredi 10 h, gare", { arriveDate: "2026-10-16", arriveTime: "10:00" });
  for (const d of r.days) {
    const lunches = d.stops.filter((s) => s.lunchBefore).length;
    assert.ok(lunches <= 1, "jour " + d.day + " : " + lunches + " déjeuners");
    if (toMin(d.startTime) >= 12 * 60 + 30) assert.equal(lunches, 0);
  }
  assert.ok(r.days[0].stops.some((s) => s.lunchBefore), "pas de déjeuner le vendredi");
});

test("liens Google Maps : départ de la gare, ou du téléphone quand je pars de ma position", () => {
  const station = planFor("séjour, départ gare", {});
  station.days.filter((d) => d.stops.length).forEach((d) =>
    assert.match(d.gmaps, /[?&]origin=35\.1027,138\.8596&/));
  const me = RP.plan(PLACES, Object.assign({}, TRIP, { start: UCHIURA, liveStart: true }), nobodyDone);
  me.days.filter((d) => d.stops.length).forEach((d) => {
    assert.doesNotMatch(d.gmaps, /[?&]origin=/);
    assert.match(d.gmaps, /[?&]destination=/);
  });
});

test("sans voiture : Heda et Nishiura signalés comme très difficiles s'ils ne tiennent pas", () => {
  const r = planFor("sans voiture", { transport: "transit" });
  const hard = r.excluded.filter((e) => /Très difficile sans voiture/.test(e.reason));
  r.days.forEach((d) => d.stops.forEach((s) => {
    if (HARD[byId.get(s.id).zone]) assert.equal(s.hard, true);
  }));
  hard.forEach((e) => assert.ok(HARD[byId.get(e.id).zone]));
});

test("séjours incohérents : un message plutôt qu'un parcours", () => {
  const bad = RP.plan(PLACES, Object.assign({}, TRIP, { arriveDate: "2026-1x-16" }), nobodyDone);
  assert.equal(bad.error, "Dates de séjour illisibles.");
  const back = RP.plan(PLACES, Object.assign({}, TRIP, { arriveDate: "2026-10-18", leaveDate: "2026-10-16" }), nobodyDone);
  assert.equal(back.error, "La date de départ est avant la date d'arrivée.");
  const sameDay = RP.plan(PLACES, Object.assign({}, TRIP,
    { arriveDate: "2026-10-16", arriveTime: "17:00", leaveDate: "2026-10-16", leaveTime: "09:00" }), nobodyDone);
  assert.equal(sameDay.error, "L'heure de départ est avant l'heure d'arrivée.");
});
