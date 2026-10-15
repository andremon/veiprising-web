// Veiprising – nettside + personvennlig teller/avstemning i én Express-app.
// Serverer den statiske siden OG API-et (teller + folkekrav) under samme
// origin. Postgres er valgfritt: uten DATABASE_URL fungerer siden og
// nedlastingene fint – kun teller og avstemning skjules.
//
// Miljøvariabler (alle valgfrie):
//   PORT          – settes av Railway automatisk
//   BASE_PATH     – f.eks. "/bompenger" hvis siden ligger på a5.no/bompenger
//                   (tom = roten av domenet)
//   DATABASE_URL  – Postgres. Railway setter den når du legger til en database.
//   HASH_SALT     – hemmelig salt for anonym IP-hashing i folkekravet.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.set('trust proxy', true);

const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, ''); // '' eller '/bompenger'
const PUB = path.join(__dirname, 'public');
const SALT = process.env.HASH_SALT || 'veiprising-folkekrav-2026';

// ---- Postgres (valgfritt) ----
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}
const hasDb = () => pool !== null;

const ALTERNATIVER = [
  { id: 'alle',        tekst: 'Erstatt bompenger med flat sats – alle kjøretøy' },
  { id: 'frita_lette', tekst: 'Flat sats, men frita MC og moped' },
  { id: 'behold',      tekst: 'Behold dagens bompengesystem' },
  { id: 'vet_ikke',    tekst: 'Vet ikke / annet' },
];
const GYLDIGE = new Set(ALTERNATIVER.map(a => a.id));
const FYLKER = ['Østfold','Akershus','Buskerud','Oslo','Innlandet','Vestfold','Telemark','Agder','Rogaland','Vestland','Møre og Romsdal','Trøndelag','Nordland','Troms','Finnmark'];
const GYLDIG_SVAR = new Set(['ja', 'nei']);

const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const ipHash = req => crypto.createHash('sha256').update(SALT + ':' + (req.ip || '')).digest('hex');

async function init() {
  if (!hasDb()) { console.log('Ingen DATABASE_URL – teller/avstemning er av, siden kjører videre.'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teller (id INT PRIMARY KEY DEFAULT 1, treff BIGINT NOT NULL DEFAULT 0, unike BIGINT NOT NULL DEFAULT 0);
    INSERT INTO teller (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS stemmer (alternativ TEXT PRIMARY KEY, antall BIGINT NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS stemt (token_hash TEXT PRIMARY KEY, tid TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS folkekrav (fylke TEXT NOT NULL, svar TEXT NOT NULL, antall BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (fylke, svar));
    CREATE TABLE IF NOT EXISTS folkekrav_stemt (kjenning TEXT PRIMARY KEY, tid TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  for (const a of ALTERNATIVER) {
    await pool.query('INSERT INTO stemmer (alternativ, antall) VALUES ($1,0) ON CONFLICT (alternativ) DO NOTHING', [a.id]);
  }
  console.log('Database klar.');
}

// ===================== API =====================
const api = express.Router();

api.get('/status', (_req, res) => res.json({ db: hasDb() }));

api.get('/alternativer', (_req, res) => res.json({ alternativer: hasDb() ? ALTERNATIVER : [] }));
api.get('/fylker', (_req, res) => res.json({ fylker: FYLKER }));

api.post('/treff', async (req, res) => {
  if (!hasDb()) return res.json({ disabled: true });
  try {
    const ny = req.body && req.body.nyNettleser === true;
    const r = await pool.query('UPDATE teller SET treff = treff + 1, unike = unike + $1 WHERE id = 1 RETURNING treff, unike', [ny ? 1 : 0]);
    res.json({ treff: Number(r.rows[0].treff), unike: Number(r.rows[0].unike) });
  } catch (e) { res.status(500).json({ feil: 'kunne ikke registrere treff' }); }
});

api.post('/stem', async (req, res) => {
  if (!hasDb()) return res.json({ disabled: true });
  try {
    const { alternativ, token } = req.body || {};
    if (!GYLDIGE.has(alternativ)) return res.status(400).json({ feil: 'ugyldig alternativ' });
    if (!token) return res.status(400).json({ feil: 'mangler token' });
    const th = hash(token);
    const finnes = await pool.query('SELECT 1 FROM stemt WHERE token_hash = $1', [th]);
    let alleredeStemt = false;
    if (finnes.rowCount === 0) {
      await pool.query('INSERT INTO stemt (token_hash) VALUES ($1)', [th]);
      await pool.query('UPDATE stemmer SET antall = antall + 1 WHERE alternativ = $1', [alternativ]);
    } else { alleredeStemt = true; }
    res.json({ alleredeStemt, resultater: await hentResultater() });
  } catch (e) { res.status(500).json({ feil: 'kunne ikke registrere stemme' }); }
});

api.get('/resultater', async (_req, res) => {
  if (!hasDb()) return res.json({ disabled: true });
  try { res.json({ resultater: await hentResultater() }); }
  catch (e) { res.status(500).json({ feil: 'kunne ikke hente resultater' }); }
});

async function hentResultater() {
  const r = await pool.query('SELECT alternativ, antall FROM stemmer');
  const map = {}; for (const rad of r.rows) map[rad.alternativ] = Number(rad.antall);
  const totalt = Object.values(map).reduce((a, b) => a + b, 0);
  return ALTERNATIVER.map(a => ({
    id: a.id, tekst: a.tekst, antall: map[a.id] || 0,
    prosent: totalt ? Math.round(((map[a.id] || 0) / totalt) * 100) : 0,
  })).concat([{ id: '_totalt', antall: totalt }]);
}

api.post('/folkekrav/stem', async (req, res) => {
  if (!hasDb()) return res.json({ disabled: true });
  try {
    const { svar, fylke, token } = req.body || {};
    if (!GYLDIG_SVAR.has(svar)) return res.status(400).json({ feil: 'ugyldig svar' });
    if (!FYLKER.includes(fylke)) return res.status(400).json({ feil: 'ugyldig fylke' });
    const ipK = 'ip:' + ipHash(req);
    const tokK = token ? 'tk:' + hash(token) : null;
    const sjekk = await pool.query('SELECT 1 FROM folkekrav_stemt WHERE kjenning = $1 OR kjenning = $2 LIMIT 1', [ipK, tokK]);
    let alleredeStemt = false;
    if (sjekk.rowCount === 0) {
      await pool.query('INSERT INTO folkekrav_stemt (kjenning) VALUES ($1) ON CONFLICT DO NOTHING', [ipK]);
      if (tokK) await pool.query('INSERT INTO folkekrav_stemt (kjenning) VALUES ($1) ON CONFLICT DO NOTHING', [tokK]);
      await pool.query(`INSERT INTO folkekrav (fylke, svar, antall) VALUES ($1,$2,1)
        ON CONFLICT (fylke, svar) DO UPDATE SET antall = folkekrav.antall + 1`, [fylke, svar]);
    } else { alleredeStemt = true; }
    res.json({ alleredeStemt, resultater: await hentFolkekrav() });
  } catch (e) { res.status(500).json({ feil: 'kunne ikke registrere stemme' }); }
});

api.get('/folkekrav/resultater', async (_req, res) => {
  if (!hasDb()) return res.json({ disabled: true });
  try { res.json({ resultater: await hentFolkekrav() }); }
  catch (e) { res.status(500).json({ feil: 'kunne ikke hente resultater' }); }
});

async function hentFolkekrav() {
  const r = await pool.query('SELECT fylke, svar, antall FROM folkekrav');
  let ja = 0, nei = 0; const perFylke = {};
  for (const f of FYLKER) perFylke[f] = { ja: 0, nei: 0 };
  for (const rad of r.rows) {
    const n = Number(rad.antall);
    if (rad.svar === 'ja') ja += n; else if (rad.svar === 'nei') nei += n;
    if (perFylke[rad.fylke]) perFylke[rad.fylke][rad.svar] = n;
  }
  const totalt = ja + nei;
  return {
    ja, nei, totalt,
    jaPst: totalt ? Math.round((ja / totalt) * 100) : 0,
    neiPst: totalt ? Math.round((nei / totalt) * 100) : 0,
    perFylke: FYLKER.map(f => ({ fylke: f, ja: perFylke[f].ja, nei: perFylke[f].nei, totalt: perFylke[f].ja + perFylke[f].nei })),
  };
}

// ===================== Statisk side =====================
const HTML = new Set(['index.html', 'kalkulator.html', 'avstemning.html', 'personvern.html', 'avgifter.html', 'temperaturmaling.html', 'forslaget.html', 'innvendinger.html', 'lastned.html']);
function sendHtml(res, file) {
  fs.readFile(path.join(PUB, file), 'utf8', (err, data) => {
    if (err) return res.status(404).send('Ikke funnet');
    res.type('html').send(data.replace(/__BASE__/g, BASE));
  });
}

const site = express.Router();
site.get('/', (_req, res) => sendHtml(res, 'index.html'));
for (const f of HTML) site.get('/' + f, (_req, res) => sendHtml(res, f));
site.use('/api', api);
// nedlastinger og øvrige statiske filer (ingen __BASE__-erstatning nødvendig)
site.use(express.static(PUB, { index: false }));

// Monter alt under BASE (eller roten). app.use matcher både "/bompenger"
// og "/bompenger/", så ingen ekstra redirect trengs (den skapte en løkke).
app.use(BASE || '/', site);

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`Veiprising kjører på port ${PORT} (base "${BASE || '/'}")`)))
  .catch(err => { console.error('Oppstart feilet:', err); process.exit(1); });
