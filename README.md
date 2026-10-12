# Veiprising — nettside (a5.no/bompenger)

Hele bompenge-saken som én nettside: les forslaget på nett, prøv den
interaktive kalkulatoren, delta i folkekravet, og last ned dokumentene.
Én Express-app som serverer både den statiske siden og API-et (besøksteller
+ folkekrav-avstemning) under samme domene.

Brevet til partiet er **ikke** med i de offentlige nedlastingene — det
sender du selv.

## Hva som ligger her
```
server.js            Express: statisk side + API, valgfri Postgres
public/
  index.html         Forsiden — hele saken, lesbar på nett
  kalkulator.html    Den interaktive kalkulatoren
  avstemning.html    Folkekrav-siden (ja/nei + fylke)
  filer/             Nedlastbare dokumenter (PPTX + PDF-er + ZIP)
.env.example         Miljøvariabler (alle valgfrie)
```

## Kjør lokalt
```bash
npm install
npm start                # → http://localhost:3000
```
Uten database fungerer siden og nedlastingene; teller og avstemning er da
skjult. Vil du teste dem lokalt, sett `DATABASE_URL` til en Postgres.

## Miljøvariabler (alle valgfrie)
| Variabel | Hva |
|----------|-----|
| `BASE_PATH` | Underområde, f.eks. `/bompenger` hvis siden ligger på `a5.no/bompenger`. Tom = roten. |
| `DATABASE_URL` | Postgres. Railway setter den automatisk når du legger til en database. Uten den er teller/avstemning av. |
| `HASH_SALT` | Hemmelig salt for anonym IP-hashing i folkekravet. |
| `PORT` | Settes av Railway automatisk. |

Siden bruker relative/absolutte lenker bygget fra `BASE_PATH` ved servering
(`__BASE__` byttes ut), så den fungerer både på roten og på et underområde.

## Deploy på Railway
1. Push dette til et GitHub-repo (se kommandoene du fikk i chatten).
2. Railway → **New Project → Deploy from GitHub repo** → velg repoet.
   Railway oppdager Node og kjører `npm start` av seg selv.
3. (Valgfritt, for teller + avstemning) **New → Database → PostgreSQL** i
   samme prosjekt. `DATABASE_URL` settes automatisk. Tabellene lages ved
   oppstart. Sett også `HASH_SALT` til en egen hemmelig verdi.
4. Sett `BASE_PATH` hvis siden skal ligge på et underområde (se under).

## Å få den på a5.no/bompenger
To rene måter:

**A. Eget underdomene (enklest).** La f.eks. `bompenger.a5.no` peke på denne
Railway-tjenesten (Railway → Settings → Domains → Custom Domain, så en
CNAME hos domeneleverandøren). La `BASE_PATH` stå tom. Lenk til den fra
`a5.no`.

**B. Underområde `a5.no/bompenger`.** Sett `BASE_PATH=/bompenger` på denne
tjenesten, og la webserveren/proxyen foran `a5.no` sende `/bompenger/*`
videre hit (uten å stryke prefikset). Da matcher alle lenker og API-kall.

## Personvern
Ingen IP lagres i klartekst — kun aggregerte tall og en saltet enveis-hash
for å hindre dobbeltstemming. Folkekravet er en uformell måling (sperre per
nettleser og IP ≈ én stemme per husstand), ikke en offisiell
folkeavstemning. Politisk oppfatning er sensitive personopplysninger —
siden innhenter samtykke, og du bør ha en kort personvernerklæring på
a5.no.

## Oppdatere innhold
Tekst og tall redigeres rett i `public/index.html`. Dokumentene i
`public/filer/` bygges fra kildefilene i hovedpakken (`veiprising-pakke/_kilde/`).
