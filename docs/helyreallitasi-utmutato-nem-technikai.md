# Mit csinálj, ha riasztást kapsz - egyszerű útmutató

Ez az útmutató NEM technikai - nem kell hozzá terminál, parancssor vagy
szakértelem. Ha egy riasztás (email/SMS, a "dead-man switch"-től) azt jelzi,
hogy a rendszer nem válaszol, ezt a lapot kövesd.

**FONTOS: ez a dokumentum a MIGRÁCIÓ UTÁNI állapotra vonatkozik**, amikor a
Marveen KIZÁRÓLAG a zenom1 szerveren fut - a mostani WSL-gépeden akkor már
NEM lesz Marveen-példány sem tartalékként, sem másképp, csak egy sima
Claude Code (vagy más AI-eszköz), amit te magad tudsz elindítani. Amíg a
migráció nem történt meg, a rendszer még a WSL-gépeden fut, és a régi,
egyszerűbb önjavító mechanizmus (10 percenkénti + bejelentkezéskori
újraindulás) még érvényes - erről mr-wolfe/neo külön szól, ha épp
folyamatban van a váltás.

## 1. Ha a bot "elakadt", de a vezérlőpult (dashboard) elérhető

Ez a leggyakoribb, legkönnyebben javítható eset: a szerver fut, csak a
Telegram-bot nem válaszol. Erre van egy egyszerű, telefonról is használható
gomb:

1. Nyisd meg a Marveen vezérlőpultot a telefonodon (ha korábban feltetted a
   kezdőképernyőre app-ikonként - ha nem, lásd `docs/mobil-dashboard.md`,
   VAGY kérj segítséget a beállításához, ez egyszeri lépés).
2. Nyisd meg a fő-agent (Mr. Wolfe) részletes nézetét.
3. Keresd meg az **"Újraindítás"** gombot a csatorna-fülön (angolul
   "Restart channels" vagy hasonló) - erre kattints.
4. Várj 1-2 percet, próbálj újra üzenetet küldeni a botnak.

**FONTOS KORLÁT, amit tudnod kell:** ez a gomb csak akkor működik, ha a
vezérlőpult MAGA elérhető (tehát nem a teljes szerver állt le, csak a bot).
Ha a vezérlőpult SEM töltődik be, menj a 2. ponthoz.

## 2. Ha a vezérlőpult SEM érhető el - ez a súlyosabb eset

Ez azt jelenti, hogy a zenom1 szerveren valami komolyabb probléma van (a
szerver maga állt le, vagy a teljes Marveen-rendszer nem fut). **Ehhez az
esethez NINCS "csak nyomj meg egy gombot" megoldás** - de van egy kész,
részletes technikai útmutató, amit NEM neked kell végrehajtanod, hanem egy
FRISS AI-agenssel (Claude Code) végrehajtatnod:

1. Nyiss egy Claude Code-ot (vagy más AI-eszközt) a saját Windows-gépeden.
2. Add át neki EZT a fájlt: `docs/zenom1-mentookirat-ai-agentnek.md`
   (mondd neki: "olvasd el ezt a fájlt, és kövesd a benne leírt
   lépéseket a Marveen rendszer diagnosztizálásához és
   újraindításához").
3. Az AI-agent ELVÉGZI helyetted a technikai lépéseket (ellenőrzi, fut-e a
   szerver, elérhető-e, szükség esetén újraindítja a szolgáltatásokat), és
   EGYSZERŰ NYELVEN beszámol neked, mit talált és mit csinált.
4. Ha az AI-agent azt jelzi, hogy a probléma túlmutat azon, amit ő meg tud
   oldani (pl. a gép fizikailag nem válaszol), **ekkor kérj emberi
   segítséget** - [KIEGÉSZÍTENDŐ: kapcsolat, akit ilyenkor érdemes elérni,
   Telegram-független módon, mert lehet hogy épp a Telegram-oldal is
   érintett].

**Előfeltétel, amit ELŐRE be kell állítani** (nem menet közben, egy
vészhelyzetben): az AI-agentnek hozzáférésre van szüksége a zenom1
szerverhez - ennek pontos beállítása (egy SSH-kulcs generálása a
Windows-gépeden + a NetBird-kapcsolat ellenőrzése) egyszeri, technikai
lépés, amit mr-wolfe/neo segít beállítani veled, MIELŐTT szükség lenne rá.
Amíg ez nincs kész, a `zenom1-mentookirat-ai-agentnek.md` dokumentum jelzi,
hogy ez a rész még hiányzik.

## Mit NEM kell tudnod ehhez

- Nem kell terminált nyitnod (kivéve hogy megnyisd a Claude Code-ot magát).
- Nem kell parancsokat begépelned - az AI-agent végzi a technikai részt.
- Nem kell tudnod mi az az SSH, systemd, vagy Docker.
- Ha bármikor bizonytalan vagy, a legbiztonságosabb lépés mindig: **kérdezz,
  mielőtt bármit próbálnál** - egy rossz parancs nagyobb kárt tud okozni, mint
  amennyit egy kis várakozás.
