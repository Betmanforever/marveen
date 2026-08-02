Reggeli napindító - készítsd el és küldd el Telegramra (chat_id: {{CHAT_ID}}).

EZ A FÁJL A NAPINDÍTÓ EGYETLEN PROMPT-FORRÁSA (scripts/morning-briefing.sh
tölti be; a korábbi második út, a reggeli-napindito scheduled task, le van
állítva -- ha a napindító tartalmán változtatsz, ITT változtass).

**LEGELÖL -- függőben lévő tulajdonosi döntések (KÖTELEZŐ ellenőrzés)**:
mielőtt bármi mást összeállítanál, kérdezd le a mr-wolfe `hot` memóriából a
legfrissebb konszolidált reggeli összefoglalót:

```bash
curl -s -H "Authorization: Bearer $(cat /home/szabgabor/marveen/store/.dashboard-token)" \
  "http://localhost:3420/api/memories?agent=mr-wolfe&category=hot&q=REGGELI%20OSSZEFOGLALO"
```

Ha van ilyen bejegyzés ÉS 24 óránál frissebb, az a napindító ELSŐ szekciója,
a Dream Engine blokk ELŐTT, `📌 *DÖNTÉSRE VÁR*` címmel. Ez az egyetlen
szekció, amit nem szabad lerövidíteni a felismerhetetlenségig: minden olyan
tétel átkerül, amihez Szabó Gábor lépése vagy döntése kell, plusz minden
helyesbítés egy korábbi állításunkhoz. A tisztán üzemi eredmények maradhatnak
egy összevont záró sorban.

Ha több ilyen bejegyzés van, a LEGFRISSEBBET vedd, és ha az kimondja hogy
felülír korábbiakat, a korábbiakat NE olvasd bele.

**Három eset, és csak az elsőben maradsz csendben:**

1. A lekérdezés LEFUTOTT és nincs találat, vagy a találat 24 óránál régebbi
   -> hagyd ki a szekciót csendben. Ez a normális eset, nincs mit jelenteni.
2. A lekérdezés MAGA HIBÁZOTT (nem 200-as válasz, üres/érvénytelen JSON, a
   token nem olvasható, a dashboard nem válaszol) -> ez NEM azonos azzal,
   hogy nincs függőben lévő döntés. Tegyél a napindító VÉGÉRE egyetlen sort:
   `⚠️ A döntési lista nem volt lekérdezhető \(dashboard hiba\), a napindító enélkül ment ki\.`
3. A lekérdezés lefutott, de EGYNÉL TÖBB érdemi, egymásnak ellentmondó
   találatot ad -> vedd a legfrissebbet, ÉS tegyél a végére egy sort, hogy a
   hot tier takarításra szorul (ez a jelzés mr-wolfe-nak szól, nem Gábornak).

**Dream Engine blokk** (a döntési szekció UTÁN, minden más ELŐTT): a
`/home/szabgabor/marveen/DREAM.md` tartalmából az 5 bucket -- `💡
Skill-javaslatok`, `🧹 Memória-egészség`, `🎯 Top-3 holnapi javaslat`, `🌐
External opportunity`, `🛠 Skill-flotta health` -- MarkdownV2-re escape-elve.
Ha a DREAM.md nem létezik vagy üres, a szekciót hagyd ki.

**HÉTFŐI heti hiba/tanulság-riport (CSAK hétfőn)**: futtasd `date +%u` -- ha
`1`, illeszd be a szekciót a Dream Engine blokk UTÁN, az email/naptár ELŐTT.
Forrás: `/home/szabgabor/marveen/WEEKLY-REPORT.md`. Frissesség-kapu: csak ha
a fájl létezik ÉS 72 óránál frissebb (`find /home/szabgabor/marveen/WEEKLY-REPORT.md -mmin -4320 | grep -q .`);
különben a szekció kimarad és a napindító VÉGÉRE kerül egy sor: "Heti riport
nem készült el időben". Ne másold be a teljes riportot: az eleji
összefoglaló max ~15 sora, `📋 *HETI HIBA/TANULSÁG RIPORT*` címmel, záró
sorral hogy a teljes riport a WEEKLY-REPORT.md-ben van. NEM hétfőn a fájlt
ne is olvasd.

**Törzs-szekciók:**

1. Email check: search_emails az elmúlt 12 órából, szűrd ki a spam/promo
   emaileket
2. Naptár: getCalendarEvents a mai napra a {{CALENDAR_ID}} naptárból
   (Europe/Budapest timezone)
3. AI hírek: WebSearch "AI news [tegnapi dátum]"
4. Küldd el Telegramra a reply tool-lal (chat_id: {{CHAT_ID}})

Ha egy kategóriában nincs esemény, a szekciót hagyd ki teljesen. Tömör,
lényegre törő. Ékezetesen írj magyarul, MarkdownV2 formátumban (a CLAUDE.md
Reggeli napindító szekciója szerint escape-elve).

**Végrehajtás-bizonyíték (kötelező, utolsó lépés)**: a Telegram-üzenet
SIKERES elküldése UTÁN, utolsó lépésként:

```bash
echo "{\"ok\":true,\"ts\":\"$(date -Is)\"}" > /home/szabgabor/marveen/store/napindito-state.json
```

A `marveen-ritual-execution` figyelő ebből látja, hogy a napindító tényleg
kiment. Csak a küldés UTÁN írd meg, soha előtte.
